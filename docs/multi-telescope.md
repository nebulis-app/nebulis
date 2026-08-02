# Multi-Telescope Support

How Nebulis supports more than one smart telescope at the same time: schema, import flow, and UI conventions.

This is the implementation reference. The original design discussion has been merged into this document.

---

## 1. The model in one paragraph

A user can configure N telescopes (S50 + S30 + Dwarf 3 + …). Every imported session is stamped with the telescope that captured it. The auto-import scheduler polls every telescope whose `autoImportEnabled` flag is on. **Manual imports also fan out** when multiple telescopes are enabled. **Per-session re-syncs target the telescope that originally captured the session**, looked up via `librarySessions.telescopeId`. The UI hides multi-telescope chrome (badges, filter dropdowns, dot stacks) until the user has at least two telescopes. Single-scope users see no clutter.

> **No "active telescope" in the UI.** The `isActive` column still exists in the database as a backwards-compat fallback for any code path that hasn't been threaded through with an explicit `telescopeId`, but no UI exposes it: every user-visible action is either fan-out (imports) or scoped-by-context (per-session re-sync, status probe per host). Users edit each telescope independently; the order they were added determines which one is the legacy fallback target.

---

## 2. Schema

### `telescopeProfiles`

| Column | Notes |
|---|---|
| `id` | UUID primary key |
| `name`, `model`, `hostname`, `shareName`, `username`, `password` | Connection details. Mirrors the active transport row; `telescopeTransports` is live truth. |
| `isActive` | Single row at a time has 1 |
| `createdAt` | ISO timestamp |
| **`kind`** | `'seestar-s50' \| 'seestar-s30' \| 'dwarf-3' \| 'dwarf-2' \| 'dwarf-mini' \| 'other'`. Drives walker dispatch and default color/share. |
| **`connectionType`** | `'smb' \| 'local' \| 'ftp'`. Defaults to `'ftp'` for Dwarf kinds (they serve no SMB share), `'smb'` otherwise. |
| **`localPath`** | Absolute filesystem path when `connectionType === 'local'`. Empty for SMB and FTP. |
| **`color`** | Hex (e.g. `#3b82f6`). Drives badge tint. Default per-kind palette in [server/lib/db.ts](../server/lib/db.ts) and [src/lib/telescopePresets.ts](../src/lib/telescopePresets.ts); keep them in sync. |
| **`autoImportEnabled`** | INTEGER (0/1). When 0, the auto-import scheduler skips this scope; manual imports still work. |

### `librarySessions`

| Column | Notes |
|---|---|
| `objectId`, `date` | Compound primary key. Unchanged from v1. |
| **`telescopeId`** | Set at upsert time by the importing worker. Nullable for legacy / pre-backfill rows. Indexed via `idx_librarySessions_telescope`. |

> **Known limitation.** Two telescopes shooting the same target on the same night still collide on the `(objectId, date)` PK: the second insert is silently ignored by `INSERT OR IGNORE`. Fixing this requires a table rebuild to extend the PK with `telescopeId`. Out of scope for v1; revisit when a real two-scope user reports a duplicated-night collision.

### `libraryObjects`

| Column | Notes |
|---|---|
| **`primaryTelescopeId`** | The telescope with the most sessions for this object. Recomputed at import time and during `reassignSessionTelescope()`. Used as a UI fallback when an individual session has no `telescopeId`. |

### `sessionImportLog` (new)

Audit trail. One row per object per import run.

```
sessionImportLog (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telescopeId TEXT NOT NULL,
  remotePath  TEXT NOT NULL,         -- e.g. "MyWorks/M42"
  importedAt  TEXT NOT NULL,
  objectId    TEXT,
  sessionDate TEXT,
  outcome     TEXT NOT NULL,         -- 'imported' | 'skipped' | 'failed'
  message     TEXT
)
```

Indexed on `(telescopeId, remotePath)`. Used today only for debugging "why did I get a duplicate"; future incremental dedup can key off it.

### Boot-time backfill

`server/lib/db.ts` runs a one-shot backfill on every server start that's idempotent: it only writes to NULL/default cells:

1. `kind` ← inferred from `model` for any row still at the default `'other'`.
2. `color` ← per-kind palette default for rows still at the default violet.
3. `librarySessions.telescopeId` ← active profile's id for rows still NULL.
4. `libraryObjects.primaryTelescopeId` ← per-object session-count majority (or active id if no sessions).

After the first boot post-upgrade, all subsequent boots find nothing to do and skip silently.

---

## 3. Transport layer

`smbListDir`, `smbGetFile`, `smbCopyFileTo`, `smbPutFile`, `smbDelete` (and the cached wrappers in [smbCache.ts](../server/lib/smbCache.ts)) all accept an optional trailing `profile` parameter. When provided, the call uses that profile's connection; when omitted, the call falls back to the legacy single-telescope behavior, still used by status probes, single-file fetches, etc.

```ts
// Legacy fallback
await smbListDir('MyWorks');

// Specific profile (multi-telescope import worker)
await smbListDir('MyWorks', profile);
```

This is the foundational change that makes everything else possible. Without it, the layer was a singleton tied to whichever profile happened to be active.

[smb.ts](../server/lib/smb.ts) is the dispatcher; everything behind it implements the same five-function surface over `SmbEntry`, so adding a transport never touches a caller. It dispatches on `profile.connectionType`:

| Kind | Module | Used by |
|---|---|---|
| `smb` | [smb.win.ts](../server/lib/smb.win.ts) / [smb.mac.ts](../server/lib/smb.mac.ts) / [smb.posix.ts](../server/lib/smb.posix.ts) | SeeStar, generic NAS |
| `local` | [smb.local.ts](../server/lib/smb.local.ts) | Any device whose storage is USB-mounted |
| `ftp` | [smb.ftp.ts](../server/lib/smb.ftp.ts) | DWARFLAB (Dwarf II / 3 / Mini) |

### Transports per profile

One profile owns N rows in `telescopeTransports`, so a single physical telescope can be reachable several ways at once (a Dwarf over both FTP and USB, a Seestar over both SMB and USB). `selectActiveTransport(profileId)` picks one per request:

1. any `local` transport whose `localPath` currently stats to a directory (priority 50)
2. otherwise any `ftp` transport with a hostname (priority 75)
3. otherwise any `smb` transport with a hostname (priority 100)
4. otherwise `null` — the caller skips this profile for this tick

Tiebreak within a kind is priority ascending, then `lastSeenAt` descending. Results are cached 30s per profile and invalidated on any transport write. `TRANSPORT_KINDS` in [telescopeTransports.ts](../server/lib/telescopeTransports.ts) is the single source of truth for the union; routes' `z.enum`, the OpenAPI schema, and `TelescopeProfile.connectionType` all derive from it.

The same physical device reached two ways collapses into one profile via `.nebulis.dat`, a hidden identity file at the storage root ([deviceIdentity.ts](../server/lib/deviceIdentity.ts)).

### FTP (Dwarf)

A Dwarf exposes **no SMB share** — anonymous FTP is its only network interface, which is why `ftp` is the default for those kinds. Port 21, passive, `Anonymous` with an empty password. The host is `192.168.88.1` when the telescope runs its own access point, or a DHCP address in station mode; the address field also accepts a `host:port` suffix.

The awkward part is that **the storage root differs per model**: Dwarf 3 serves `Astronomy` at the FTP root, Dwarf II serves `/DWARF_II/Astronomy`, Dwarf Mini serves `/DWARF_mini/Astronomy`. `resolveRemoteRoot()` probes the known prefixes for a directory named `Astronomy` and caches the winner, so walkers stay model-agnostic and an unrecognised layout degrades to the plain FTP root instead of erroring.

Connection handling has two constraints worth knowing before editing that file: a single FTP control socket cannot interleave commands (so connections are pooled one-per-target and operations serialised through a per-target queue), and FTP has no ranged read (so a capped `maxBytes` read aborts by destroying the data socket and then discards the control connection). Full contract in [CLAUDE.md](../CLAUDE.md#ftp-transport-dwarflab).

`smbCopyFileTo` streams straight to disk on `local` and `ftp`. Callers gate on `supportsStreamedCopy(profile)` rather than testing `connectionType` themselves.

---

## 4. Walkers

The `server/lib/walkers/` directory abstracts folder layout per telescope kind. Walkers are **transport-agnostic**: they emit device-relative paths and the transport resolves them.

| File | Role |
|---|---|
| [telescopeWalker.ts](../server/lib/walkers/telescopeWalker.ts) | SeeStar. Discovers `<base>/<Object>/...` and `<base>/<Object>_sub/...` folders. |
| [dwarfWalker.ts](../server/lib/walkers/dwarfWalker.ts) | DWARFLAB. Session folders (`DWARF3_RAW_*` / `DWARF_RAW_*`) under `Astronomy/`, one folder per session rather than per object. |
| [index.ts](../server/lib/walkers/index.ts) | `getWalkerConfig(kind)` returns `{ basePath }`. SeeStar uses `'MyWorks'`, Dwarf uses `'Astronomy'`, `other` uses `''` (share root). `isDwarfKind(kind)` distinguishes the two layout families. |

`DWARF_BASE_PATH` is `'Astronomy'` for every Dwarf model no matter how the device is reached. The knowledge that a Dwarf II keeps that folder under `/DWARF_II` lives in the FTP transport, not the walker — a USB mount exposes it at the volume root regardless of model.

**Still speculative:** the "generic" layout documented in the Add Telescope modal for the `other` kind (session subfolders + `lights/subframes/`) is a different tree that no importer has been tested against. `other` currently runs the SeeStar walker at the share root.

---

## 5. Import flow

### Single-telescope import (`runImport`)

```ts
runImport(targetObjectId?, targetDate?, { telescopeId? })
```

1. Resolves a `profile` from `options.telescopeId` or falls back to the active profile.
2. Sets module-level `currentImportProfile` so `saveIndex()` and the mid-loop save block stamp every `librarySessions` row with the right id.
3. Calls SMB with `(path, profile)` so credentials follow the worker, not the active selection.
4. After each object, writes one `sessionImportLog` row per session date.
5. Updates `libraryObjects.primaryTelescopeId` to the importing telescope's id.

### Multi-telescope fan-out (`runAllTelescopesImport`)

```ts
runAllTelescopesImport()  // iterates getAutoImportProfiles() sequentially
```

Sequential, not parallel. Two reasons:

- The existing `claimImportLock()` + `importStatus` model is global. Per-telescope status would need new infra.
- Home networks rarely have enough bandwidth + simultaneous SMB connections to make parallel useful.

The lock is released between telescopes (each `runImport` call has its own `finally`), and `runAllTelescopesImport` re-claims it before starting the next iteration. The route handler claims the lock for the first iteration so a second call to `POST /api/library/import?all=1` returns 409 immediately instead of queueing.

### Auto-import scheduler

[scheduleAutoImport()](../server/lib/localLibrary.ts) polls every minute and triggers `runAllTelescopesImport()` once per `autoImportInterval`. Telescopes with `autoImportEnabled = 0` are skipped at the `getAutoImportProfiles()` filter. Flipping the per-telescope toggle in Settings takes effect on the next tick.

---

## 6. API surface

### Telescope CRUD

`GET /api/telescopes` returns all profiles with masked passwords, plus a server-computed `sessionCount` per telescope (cheap aggregate over `librarySessions`).

`POST /api/telescopes`, `PUT /api/telescopes/:id`, `DELETE /api/telescopes/:id`, `PUT /api/telescopes/active/:id`: same as before, plus accept `kind` / `color` / `autoImportEnabled` fields. Sending the masked password sentinel keeps the existing one.

### Import

`POST /api/library/import` shape:

| Body / query | Meaning |
|---|---|
| `{ objectId }` | Just that object on the active telescope. |
| `{ telescopeId }` | All objects on that telescope. |
| `{ objectId, telescopeId }` | One object on one telescope. |
| `?all=1` (no body) | Every `autoImportEnabled` telescope, sequentially. |
| (no body, no params) | Active telescope only, preserves legacy behavior. |

The Gallery "Import from Telescope" button picks `?all=1` automatically when two or more telescopes have `autoImportEnabled = 1`, otherwise falls back to the legacy single-telescope path. The button label reflects which mode it's in (e.g. "From all 3 telescopes").

Per-session sync routes (`POST /api/library/objects/:objectId/sessions/:date/sync` and `…/sync-subframes`) look up the session's stored `telescopeId` (via `getSessionTelescopeId(objectId, date)`) and pass it through to `runImport` / `syncSessionSubFrames`. Re-syncing an old session always hits the telescope that captured it, never the currently-active one. Falls back to the parent object's `primaryTelescopeId` when the session is unstamped (legacy data); ultimate fallback is the active profile.

### Session attribution

`PUT /api/library/objects/:objectId/sessions/:date/telescope`
```json
{ "telescopeId": "uuid-of-target-telescope" }
```
Updates the session's `telescopeId` and recomputes the parent object's `primaryTelescopeId` from the new session distribution. Returns 404 if the session row doesn't exist.

### Read-side enrichment

These responses now include telescope attribution:

- `GET /api/library/objects` → each object has `primaryTelescopeId` + `telescopeIds: string[]` (recency-sorted, dedup).
- `GET /api/library/objects/:id/sessions` → each session has `telescopeId`.
- `GET /api/library/observations` and `GET /api/library/observations/:id/:date` → both include `telescopeId`. The detail endpoint falls back to the object's `primaryTelescopeId` when an individual session is unstamped.

---

## 7. UI conventions

### The 1↔2 threshold

Every multi-telescope UI element renders only when `useQuery(['telescopes']).data.length >= 2`. Backend always returns `telescopeId` fields regardless: the client decides whether to render. This keeps the wire format stable as users cross the threshold; no backend changes needed when they add or remove a second scope.

### Color + abbreviation

Per-telescope `color` is the visual primary key. The frontend palette and `abbreviateTelescope(name, kind)` helper live in [src/lib/telescopePresets.ts](../src/lib/telescopePresets.ts):

| Kind | Default color | Abbreviation |
|---|---|---|
| `seestar-s50` | `#3b82f6` (blue) | S50 |
| `seestar-s30` | `#10b981` (emerald) | S30 |
| `dwarf-3` | `#f59e0b` (amber) | D3 |
| `dwarf-2` | `#ef4444` (red) | D2 |
| `other` | `#8b5cf6` (violet) | First two letters of the name, uppercased |

### Where badges/filters appear

| Surface | What renders (≥2 telescopes only) |
|---|---|
| Top-nav status pill | Single scope: green/grey "Telescope Online/Offline" pill (legacy). 2+ scopes: aggregate "N/M online" pill with multi-color dot stack. Clicking opens a popover that lists every telescope with its color, hostname, online state, and latency. |
| Settings → Connection | Card list. Each row shows color swatch, session count, auto-import toggle, edit, delete. Clicking the row opens the Edit modal, which is also where Test Connection lives. No "active" badge; no per-row click-to-activate. |
| Calendar header | Telescope filter dropdown ("All telescopes" + each profile). |
| Calendar day cells | 1.5px colored dot beside each session marker. |
| Calendar "+N more" popover | Same dots. |
| Recent Observations list | Pill chip showing color + name. |
| Observation Detail header | Pill chip linking to the calendar filter; admins get a Pencil button → reassign popover. |
| Library (Gallery) filter bar | "All scopes" + one button per telescope. |
| ObjectCard (library tile) | Up to 3 colored dots in the top-left, one per telescope that captured this object. |

---

## 8. Add Telescope modal

Single component handles both create and edit modes. Pass `existing?: TelescopeProfile` to switch.

- **Kind dropdown** → preset auto-fills shareName/username/color, the default hostname, and the transport mode (only on create; edit preserves user values). Picking a Dwarf kind selects FTP and pre-fills `192.168.88.1`.
- **Connection toggle** → Wi-Fi vs USB, shown for Seestar and Dwarf. The Wi-Fi option is labelled "Wi-Fi (SMB)" for Seestar and "Wi-Fi (FTP)" for Dwarf, and sets `connectionType` accordingly. `other` is SMB-only and skips the toggle.
- **Advanced settings** → share name is hidden in FTP mode (FTP has no shares and the storage root is auto-detected); username/password remain, defaulting to anonymous.
- **Color picker** → 8 hand-picked swatches from the palette.
- **Auto-import toggle** → maps to `autoImportEnabled`.
- **Password field** → in edit mode, blank means "keep existing" (server treats the masked sentinel as no-change too).
- **Test Connection** → calls `POST /api/telescopes/test-connection` with the *current form values* (hostname, share, username, password, kind, connectionType). Works for both Add (before the profile exists) and Edit (without saving unsaved changes). Returns `{ connected, objectCount?, error?, remoteRoot? }` with a green/red banner under the button. For FTP the banner also reports the detected storage root, which is the fastest way to spot a wrong model selection.

The Settings → Connection list also exposes a per-row auto-import toggle that calls `updateTelescope(id, { autoImportEnabled })` directly without opening the modal, for the common "I'm not using the S30 this winter, stop polling it" case.

---

## 9. What's still open

1. **Two scopes, same target, same night.** Collides on the `(objectId, date)` PK. Needs a PK rebuild to include `telescopeId`. See [multi-telescope-support.md §3](multi-telescope-support.md#3-schema-changes).
2. **Real Dwarf hardware.** The Dwarf walker and the FTP transport are both written from vendor docs and third-party drivers, and the FTP transport is covered by tests against an in-process FTP server ([ftpTransport.test.ts](../tests/backend/ftpTransport.test.ts)). Neither has been run against a physical Dwarf. The storage-root probe and the `ls -l` listing format are the two things most likely to need adjusting once someone tries it.
3. **Transport list editor.** Adding a second transport to an existing profile only happens implicitly, via the merge prompt when `.nebulis.dat` identifies a device already owned by another profile. There is no "add another way to reach this telescope" button, no editor, and no way to pin a transport manually (`selectActiveTransport` is fully automatic). The API routes for it already exist.
4. **Generic walker.** The "Other" kind currently uses the SeeStar walker, which doesn't match the layout documented in the Add Telescope modal (session subfolders + `lights/subframes/`). Either build the walker or remove the doc.
5. **Per-telescope status panel.** Today `importStatus` is global, so the UI shows the most recently importing telescope. A multi-scope user wouldn't know if scope B failed mid-fan-out unless they checked logs. Worth revisiting when there are real users with multiple scopes.
6. **Reassign-on-add suggestion.** When the user adds a new telescope and the backfill stamps every existing session with the previously-active id, there's no UI prompt to say "hey, want to reassign these?" The user has to do it manually per session. Possibly too clever; revisit if it comes up.
