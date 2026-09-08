t# Fix plan: stranded library path on Docker (and retired drives everywhere)

Status: **IMPLEMENTED 2026-09-07** on `feat/v2.0` (uncommitted). Full backend
suite green (136 files / 1636 tests). New tests:
`tests/backend/libraryPathPinned.test.ts`,
`tests/backend/libraryLocationResetRoute.test.ts`.
§6 (the interim CLI workaround) is now superseded by the "Reset to default
folder" button and can be deleted from user-facing docs.

---

## 1. The problem

A user set up Nebulis on Windows, then moved to the Docker/unRAID image by copying
`nebulis.db` (and the rest of `/app/data`) onto the new host. The database carries
`appSettings.libraryPath = 'D:\Nebulis\library'` (or similar). That path does not
exist inside the container, so:

- `isDefaultLocation()` returns **false** (the stored path is non-empty).
- `isLibraryAvailable()` returns **false** (the directory is absent).
- The app shows the "library needs reconfiguring" banner and blocks all library
  writes with 503.
- **There is no way out from the UI on Docker/Linux:**
  - The Change Location dialog lists "drives" from `listVolumes()`, which on Linux
    only scans `/media/<user>`, `/media`, `/mnt`, `/run/media/<user>`
    ([`server/lib/volumes.ts` `listLinux()`](server/lib/volumes.ts)). In a stock
    container those are empty, so the dialog shows "No drives found".
  - The folder browser only unlocks *after* a drive is picked from that list
    ([`src/components/ui/ChangeLocationModal.tsx`](src/components/ui/ChangeLocationModal.tsx)).
    There is no free-text path field.
  - The "Network share" tab is hidden on Linux by design
    (`networkLibrarySupported` is `win32 || darwin` only,
    [`server/lib/libraryPath.ts` `getLibraryLocationInfo()`](server/lib/libraryPath.ts)).
  - "Move back to default location" calls `startMigration(defaultPath)`, which
    hits the guard in [`server/lib/libraryMigration.ts` `run()`](server/lib/libraryMigration.ts):

    ```ts
    if (!isDefaultLocation() && !(await isLibraryAvailable())) {
      throw new MigrationError('The current library location is not connected. Reconnect it before moving the library.');
    }
    ```

    The stored Windows path can never be "connected" inside the container, so the
    one recovery button always fails.
  - `DELETE /settings/reset-database` keeps `appSettings` (so it keeps the bad
    path) and purges the imported rows. Not a fix.
  - There is no `LIBRARY_DIR` env override. [`server/lib/paths.ts`](server/lib/paths.ts)
    hardcodes `LIBRARY_DIR = join(DATA_DIR, 'library')` and
    `getDefaultLibraryDir()` re-derives the same.

The only current workaround is editing `nebulis.db` by hand (see §6).

### This is not Docker-only

Any user who relocated the library to an external drive and then permanently
retired that drive is in the same dead end on Windows and macOS: the source is
gone, so "Move back to default" refuses, and the only offered path forward is
"reconnect the drive you no longer have".

---

## 2. Root cause summary

Two missing capabilities:

1. **No environment-level override for the library directory.** Every headless
   deployment story (Docker, unRAID, a NAS, a systemd unit) expects to pin storage
   locations with env vars / bind mounts, not a GUI drive picker.
2. **No "forget the configured location" action that does not also try to copy
   files.** Every route to clearing `libraryPath` goes through the migration
   engine, which by design refuses to run when the current (source) location is
   unreachable.

---

## 3. Fix 1: `LIBRARY_DIR` environment override

### Behaviour

- When `LIBRARY_DIR` is set (non-empty after trim), it is the library directory,
  full stop. It wins over `appSettings.libraryPath` **and** over any network-share
  configuration.
- `getLibraryDir()` returns it. `getDefaultLibraryDir()` returns it (so
  "the built-in location" the UI offers as the reset target is the pinned path).
- `isDefaultLocation()` returns **true** when the override is active (there is
  nothing for the user to "relocate" — the deployment already decided).
- `isNetworkLocation()` returns **false** when the override is active.
- `isLibraryAvailable()` for the override behaves like the default location:
  the directory is created on demand and always considered available. No marker
  file is required (same as today's default location), because the operator, not
  a removable drive, owns the path.
- The library is still addressed by `<folder>/<file>` relative to
  `getLibraryDir()`, so pointing the override at a directory that already holds
  `M31/…`, `NGC7000/…` etc. from a copied library Just Works once the matching
  DB rows exist.

### Interaction with a stale `appSettings.libraryPath`

Setting `LIBRARY_DIR` **immediately un-stucks** the user in §1: the stored
Windows path is ignored, `isLibraryAvailable()` is true, the banner clears,
writes are allowed. We also opportunistically clean the DB: on boot, if
`LIBRARY_DIR` is set and `appSettings.libraryPath` / network columns are
non-empty, blank them and log one line ("library location pinned by LIBRARY_DIR;
cleared stored path X"). This keeps the DB honest if the env var is later
removed. (If it is removed, the app falls back to `{DATA_DIR}/library`, the
normal default — not back to the Windows path.)

### Guard rails

- **Migration is disabled while the override is active.** `POST /storage/migrate`
  returns `400 LIBRARY_PINNED` with "Your library location is set by the
  LIBRARY_DIR environment variable. Change that to move the library." The Change
  Location button in Settings is hidden; a short read-only note replaces it
  ("Pinned by LIBRARY_DIR: /app/data/library").
- `LIBRARY_DIR` must be absolute. If it is not, log an error and ignore it
  (fall back to the default) rather than crash-looping the container.
- If `LIBRARY_DIR` equals the resolved default (`{DATA_DIR}/library`), that is
  fine and is treated exactly like "no override".

### Files touched

| File | Change |
| --- | --- |
| `server/lib/paths.ts` | Read + validate `process.env.LIBRARY_DIR`; export `LIBRARY_DIR_OVERRIDE` (string \| null). Keep the existing `LIBRARY_DIR` const as `LIBRARY_DIR_OVERRIDE ?? join(DATA_DIR, 'library')` for the few legacy importers. |
| `server/lib/libraryPath.ts` | `getDefaultLibraryDir()`, `getLibraryDir()`, `isDefaultLocation()`, `isNetworkLocation()`, `isLibraryAvailable()`, `getLibraryLocationInfo()` all honour the override first. Add `isLibraryPinned()` helper + `pinned: boolean` on `LibraryLocationInfo`. |
| `server/lib/db.ts` (or a small boot task in `server/index.ts`) | One-shot: when pinned and stored path non-empty, clear `libraryPath` + `libraryLocationType='local'` + network columns; log. Must not fight `dbBackup.ts` ordering — do it after migrations, in `index.ts`. |
| `server/routes/storage.ts` | `POST /migrate` → `400 LIBRARY_PINNED` when `isLibraryPinned()`. |
| `server/lib/libraryMigration.ts` | `startMigration()` throws `MigrationError` if pinned (defence in depth). |
| `src/lib/api/storage.ts` + `LibraryLocation` type | Surface `pinned`. |
| `src/components/settings/LibraryLocationSection.tsx` | When `pinned`, hide "Change" / "Move back to default"; show the pinned path + one-line explanation. |
| `src/components/ui/ChangeLocationModal.tsx` | N/A if the entry point is hidden; add a defensive guard anyway. |
| `src/components/LibraryUnavailableBanner.tsx` | Not shown when pinned (available is true), no change needed, but verify. |
| `docker/README.md`, `docker/docker-compose.yml`, root `docker-compose.yml` | Document `LIBRARY_DIR` + a commented example bind mount. |
| `README.md` "Library Location" section / `CLAUDE.md` | Note the override is the supported Docker relocation mechanism. |
| `tests/backend/libraryPath.test.ts` (new or extend) | Override wins over stored path + network; `isDefaultLocation()` true; migrate route 400s; DB self-clean runs once. |

---

## 4. Fix 2: non-migrating "Reset library location"

**This is the zero-CLI, in-app recovery for the reported scenario.** A stale
`libraryPath` does not stop the server booting or the SPA loading: the user logs
in normally and sees the "library needs reconfiguring" banner, with everything
except library writes working. So a button in that banner is enough to repoint
the config. For a user who has already copied their `library/` folders into the
default location (and kept their DB), clicking it is the entire fix. §6's manual
steps exist **only** because this button does not exist yet.

What the button cannot do: move image files into place. If the user put the
folders somewhere other than the default library directory, they move them with
their own file tools first (not a Nebulis command). No button can guess where
they were copied.

### Behaviour

A new action that clears the configured location **without copying any files**:

- Calls `setLibraryPath('')` + `refreshLibraryConfig()` (and clears the network
  columns, which `setLibraryPath('')` already does).
- Does **not** invoke the migration engine, so the "source not connected" guard
  never applies.
- After it runs, the library directory is `{DATA_DIR}/library` (the normal
  default). If the user has copied their object folders there, and the DB rows
  reference those folder names, the library is immediately whole again.
- If the default directory is empty, the user sees an empty library plus the
  existing "objects on disk not found" reconciliation paths — expected, and
  better than a hard block.

### Endpoint

`POST /api/v1/storage/library-location/reset` (admin, `strictRateLimiter`).

```
{ ok: true, path: "<new default path>" }
```

- Refused with `409` if a migration is currently running (`isActivePhase`).
- Refused with `400 LIBRARY_PINNED` if `LIBRARY_DIR` is set (nothing to reset).
- Writes a `logEvent` (`category: 'storage'`, `event: 'library_location_reset'`,
  level `warning`) with the old path in metadata.

### UI placement

1. **`LibraryUnavailableBanner.tsx`** — when the location is unavailable and not
   migrating, add a secondary action: **"Reset to default folder"**. Opens a
   confirm dialog:

   > This points Nebulis back at its built-in library folder
   > (`{defaultPath}`). Files at the old location (`{currentPath}`) are **not**
   > copied. Use this if that drive or path is gone for good and you have already
   > put your images in the default folder (or will re-import them).
   >
   > [Cancel] [Reset location]

2. **`LibraryLocationSection.tsx`** — alongside "Move back to default location",
   when `!location.available`, show "Reset without moving files" with the same
   confirm.

The existing "Move back to default location" stays as-is for the case where the
old location *is* reachable (it should copy).

### Files touched

| File | Change |
| --- | --- |
| `server/routes/storage.ts` | New `POST /library-location/reset`. |
| `server/lib/libraryPath.ts` | Export a small `resetLibraryLocation()` wrapper (calls `setLibraryPath('')`, returns the new dir) so the route stays thin, or just call `setLibraryPath('')` directly. |
| `src/lib/api/storage.ts` | `resetLibraryLocation()` client fn. |
| `src/components/LibraryUnavailableBanner.tsx` | Secondary action + confirm modal. |
| `src/components/settings/LibraryLocationSection.tsx` | Secondary action + confirm modal (reuse a shared `<ConfirmResetLocationModal>`). |
| `tests/backend/storage.*.test.ts` | Reset clears path + network cols; 409 while migrating; 400 when pinned; event logged. |
| `tests/e2e` | Banner → reset → banner clears (mocked). |

---

## 5. User impact

### Existing users who did nothing special

**No change.** No env var set, library at the default or on a working relocated
drive: identical behaviour. `pinned` is `false`, both new UI affordances stay
hidden (the reset action only appears when the location is unavailable).

### Users upgrading with a healthy relocated library (USB / network share)

**No change.** The migration engine, markers, and reconnect logic are untouched.

### The stranded user from §1 (and retired-drive users)

Two supported ways out after the fix ships, no terminal for either:

- **From the UI (this user's case):** they already copied their `library/`
  folders across, so they just click **Reset to default folder** on the banner
  and confirm (see §7.3). The app is fully loaded while the banner is showing, so
  the button is reachable. If their folders landed somewhere other than the
  default library directory, they move them there first with their normal file
  tools.
- **Docker config (cleaner long-term):** set `LIBRARY_DIR` to a bind-mounted
  path in the compose file / unRAID template (see §7.1). The stored Windows path
  is ignored and blanked on the next boot. This is editing container config, not
  running commands inside it.

### Upgrade notes

- No schema change. `libraryPath` / `libraryLocationType` / `libraryNetwork*`
  columns already exist.
- The one-shot DB clean in Fix 1 only runs when `LIBRARY_DIR` is set, and is
  idempotent.
- No data is moved or deleted by either fix. Fix 2 explicitly does not touch
  files; it only repoints a config value.

---

## 6. Interim workaround — delete this section once Fix 2 ships

**After Fix 2 ships this whole section goes away.** Recovery becomes: open the
app, click **Reset to default folder** on the banner, confirm. No terminal.

Until then, the config can only be cleared by editing the database. The container
ships `better-sqlite3` but **not** the `sqlite3` CLI, so use the container's own
Node.

> Replace `nebulis` with your container name and adjust the data path if you
> bind-mounted `/app/data` somewhere other than the default named volume.

### Step 1 — find your database

- **Named volume (default compose):** it is inside the container at
  `/app/data/nebulis.db`. Nothing to locate.
- **Bind mount (typical on unRAID):** e.g.
  `/mnt/user/appdata/nebulis/nebulis.db` on the host. The container path is still
  `/app/data/nebulis.db`.

### Step 2 — back up the database first

```bash
docker cp nebulis:/app/data/nebulis.db ./nebulis.db.bak
```

### Step 3 — clear the stored library path

```bash
docker exec nebulis node -e "const D=require('better-sqlite3');const db=new D('/app/data/nebulis.db');db.prepare(\"UPDATE appSettings SET libraryPath='', libraryLocationType='local', libraryNetworkHost='', libraryNetworkShare='', libraryNetworkDomain='', libraryNetworkUsername='', libraryNetworkPasswordSealed='', libraryNetworkSubpath='' WHERE id=1\").run();console.log('cleared');"
```

Expected output: `cleared`.

### Step 4 — put the image folders where Nebulis now expects them

The library now resolves to `/app/data/library` (i.e.
`<your data dir>/library` on the host). Nebulis stores files as
`<objectFolder>/<file>`, so the folder names must match what the database
recorded on the old machine (they will, if you copied the folders from the old
`library/` directory unchanged).

```bash
# host side, adjust paths
mkdir -p /mnt/user/appdata/nebulis/library
cp -a /path/to/copied/library/. /mnt/user/appdata/nebulis/library/
```

Do **not** rename any folders or files during the copy.

### Step 5 — restart

```bash
docker restart nebulis
```

Open the app. The "needs reconfiguring" banner should be gone and your objects
should show their images. If an object shows "image not found", the folder name
on disk does not match the database — compare
`/app/data/library/<folder>` names against the object list.

### If you would rather start clean

Skip steps 3–4, delete `nebulis.db` (you have the backup), restart, create the
admin account again, and re-import from the telescope or from the copied folders
via **Import → folder**.

---

## 7. Usage instructions **after** the fix ships

### 7.1 Docker: keep observation sessions on a separate disk (recommended)

Pin the library directory to a bind mount with `LIBRARY_DIR`. The database,
secrets, thumbnails and logs stay in `/app/data`; only the images live on the
second disk.

```yaml
services:
  nebulis:
    image: nebulisapp/nebulis:latest
    container_name: nebulis
    restart: unless-stopped
    ports:
      - "8080:8080"
      - "47890:47890/udp"
    environment:
      - PORT=8080
      - NODE_ENV=production
      - LIBRARY_DIR=/library          # <-- pin the library here
    volumes:
      - nebulis-data:/app/data        # DB, settings, secrets, thumbnails, logs
      - /mnt/user/astrophotos:/library # <-- your big storage, mounted at LIBRARY_DIR

volumes:
  nebulis-data:
```

unRAID template equivalent: add a **Path** mapping
`Container: /library` → `Host: /mnt/user/astrophotos`, and a **Variable**
`LIBRARY_DIR` = `/library`.

Notes:

- `LIBRARY_DIR` must be an absolute path that exists in the container (i.e. it
  must be a mount point you declared). If it is missing or relative, Nebulis logs
  a warning and falls back to `/app/data/library`.
- With `LIBRARY_DIR` set, **Settings → Storage → Library location** shows the
  pinned path and hides the "Change" / "Move" buttons. To move the library,
  change the bind mount and restart, then copy the files over yourself.
- If you previously had a stored library path (e.g. migrated a DB from another
  machine), setting `LIBRARY_DIR` overrides it and Nebulis clears the stale value
  from the database on the next boot.
- Migrating an existing default library onto the new disk: stop the container,
  `cp -a` the old `<data>/library/.` into the new mount, add `LIBRARY_DIR`, start.

### 7.2 Docker: library at the default location, no env var

Bind-mount straight onto the default path. No `LIBRARY_DIR` needed:

```yaml
    volumes:
      - nebulis-data:/app/data
      - /mnt/user/astrophotos:/app/data/library
```

Nested mounts are fine. This is the smallest possible change and needs no
in-app reconfiguration.

### 7.3 Any platform: recover from a lost / retired library drive

**If your image folders are already in the default library folder** (the reported
case — the user copied `library/` across when moving to Docker), that's it:
open Nebulis, click **Reset to default folder** on the "library needs
reconfiguring" banner, confirm. The banner clears and everything shows. No file
moving, no terminal.

**If the folders are not there yet** (the library used to live on a drive that is
gone):

1. Put your image folders (copied from the old `library/` directory, names
   unchanged) into the default library folder:
   - Windows: `C:\ProgramData\Nebulis\data\library`
   - macOS: `~/Library/Application Support/Nebulis/library`
   - Docker (no `LIBRARY_DIR`): `<data volume>/library`
2. Open Nebulis. On the "library needs reconfiguring" banner, click
   **Reset to default folder** and confirm.
3. The banner clears and the library points at the default folder. Objects whose
   folders you restored show their images again; anything you did not restore
   shows "image not found" until you re-import it.

**"Reset to default folder" never copies or deletes files.** It only tells
Nebulis to stop looking at the old, unreachable location. If the old drive is
actually still reachable, use **Move back to default location** instead — that
one copies the files first.

---

## 8. Test checklist

Fix 1:

- [ ] `LIBRARY_DIR=/x` with stored `libraryPath='/old'` → `getLibraryDir()` is
      `/x`, `isDefaultLocation()` true, banner absent, writes allowed.
- [ ] Boot with the above → `libraryPath` blanked in DB, one log line.
- [ ] `LIBRARY_DIR` unset again after that → falls back to `{DATA_DIR}/library`,
      not `/old`.
- [ ] `LIBRARY_DIR` relative or missing dir → warning logged, default used, no
      crash loop.
- [ ] `POST /storage/migrate` while pinned → `400 LIBRARY_PINNED`.
- [ ] Settings UI hides Change/Move, shows pinned path.
- [ ] `LIBRARY_DIR` == default path → treated as unpinned/normal.

Fix 2:

- [ ] Stored unreachable `libraryPath` (no env var) → `POST
      /storage/library-location/reset` → `libraryPath=''`, network cols cleared,
      `getLibraryDir()` == default, event logged.
- [ ] Reset while a migration is active → `409`.
- [ ] Reset while pinned → `400 LIBRARY_PINNED`.
- [ ] Banner "Reset to default folder" flow (e2e, mocked) → banner clears.
- [ ] "Move back to default location" still refuses when source unreachable
      (unchanged behaviour) and still works when source reachable.

Regression:

- [ ] Healthy default library: no new UI, no behaviour change.
- [ ] Healthy USB-relocated library: markers, reconnect, storage cards unchanged.
- [ ] Healthy network-share library (macOS/Windows): unchanged.
- [ ] Full backend vitest baseline green (see `project_e2e_test_debt`).

---

## 9. Docs to update on ship

- `docker/README.md` — `LIBRARY_DIR` row in the env table + a "Storing images on
  a separate disk" section (content from §7.1).
- `docker/docker-compose.yml` and root `docker-compose.yml` — commented
  `LIBRARY_DIR` + example mount.
- `README.md` — Library Location section: mention `LIBRARY_DIR` and the reset
  action.
- `CLAUDE.md` — "Library Location (relocatable storage)": `LIBRARY_DIR` overrides
  `appSettings.libraryPath`; migration is disabled while pinned; the non-migrating
  reset route exists for lost drives.
- `CHANGELOG.md` — user-facing entry:
  > Docker: set `LIBRARY_DIR` to keep your image library on a separate disk or
  > mount. Added "Reset to default folder" so you can recover if the drive your
  > library lived on is gone.
