# Multi-Telescope Support

How Nebulis supports more than one smart telescope at the same time — schema, import flow, and UI conventions.

This is the implementation reference. The original design discussion has been merged into this document.

---

## 1. The model in one paragraph

A user can configure N telescopes (S50 + S30 + Dwarf 3 + …). Every imported session is stamped with the telescope that captured it. The auto-import scheduler polls every telescope whose `autoImportEnabled` flag is on. **Manual imports also fan out** when multiple telescopes are enabled. **Per-session re-syncs target the telescope that originally captured the session**, looked up via `librarySessions.telescopeId`. The UI hides multi-telescope chrome (badges, filter dropdowns, dot stacks) until the user has at least two telescopes — single-scope users see no clutter.

> **No "active telescope" in the UI.** The `isActive` column still exists in the database as a backwards-compat fallback for any code path that hasn't been threaded through with an explicit `telescopeId`, but no UI exposes it — every user-visible action is either fan-out (imports) or scoped-by-context (per-session re-sync, status probe per host). Users edit each telescope independently; the order they were added determines which one is the legacy fallback target.

---

## 2. Schema

### `telescopeProfiles`

| Column | Notes |
|---|---|
| `id` | UUID primary key |
| `name`, `model`, `hostname`, `shareName`, `username`, `password` | SMB connection |
| `isActive` | Single row at a time has 1 |
| `createdAt` | ISO timestamp |
| **`kind`** | `'seestar-s50' \| 'seestar-s30' \| 'dwarf-3' \| 'dwarf-2' \| 'other'`. Drives walker dispatch and default color/share. |
| **`color`** | Hex (e.g. `#3b82f6`). Drives badge tint. Default per-kind palette in [server/lib/db.ts](../server/lib/db.ts) and [src/lib/telescopePresets.ts](../src/lib/telescopePresets.ts) — keep them in sync. |
| **`autoImportEnabled`** | INTEGER (0/1). When 0, the auto-import scheduler skips this scope; manual imports still work. |

### `librarySessions`

| Column | Notes |
|---|---|
| `objectId`, `date` | Compound primary key. Unchanged from v1. |
| **`telescopeId`** | Set at upsert time by the importing worker. Nullable for legacy / pre-backfill rows. Indexed via `idx_librarySessions_telescope`. |

> **Known limitation.** Two telescopes shooting the same target on the same night still collide on the `(objectId, date)` PK — the second insert is silently ignored by `INSERT OR IGNORE`. Fixing this requires a table rebuild to extend the PK with `telescopeId`. Out of scope for v1; revisit when a real two-scope user reports a duplicated-night collision.

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

`server/lib/db.ts` runs a one-shot backfill on every server start that's idempotent — it only writes to NULL/default cells:

1. `kind` ← inferred from `model` for any row still at the default `'other'`.
2. `color` ← per-kind palette default for rows still at the default violet.
3. `librarySessions.telescopeId` ← active profile's id for rows still NULL.
4. `libraryObjects.primaryTelescopeId` ← per-object session-count majority (or active id if no sessions).

After the first boot post-upgrade, all subsequent boots find nothing to do and skip silently.

---

## 3. SMB layer

`smbListDir`, `smbGetFile`, `smbDelete` (and the cached wrappers in [smbCache.ts](../server/lib/smbCache.ts)) all accept an optional trailing `profile` parameter. When provided, the call uses that profile's credentials; when omitted, the call falls back to `getActiveProfile()` (legacy single-telescope behavior — still used by status probes, single-file fetches, etc.).

```ts
// Active profile (legacy)
await smbListDir('MyWorks');

// Specific profile (multi-telescope import worker)
await smbListDir('MyWorks', profile);
```

This is the foundational change that makes everything else possible — without it, the SMB layer was a singleton tied to whichever profile happened to be active.

---

## 4. Walkers

The `server/lib/walkers/` directory abstracts share-relative folder layout per telescope kind.

| File | Role |
|---|---|
| [seestarWalker.ts](../server/lib/walkers/seestarWalker.ts) | Discovers `<base>/<Object>/...` and `<base>/<Object>_sub/...` folders. The active implementation for every kind today. |
| [index.ts](../server/lib/walkers/index.ts) | `getWalkerConfig(kind)` returns `{ basePath }`. SeeStar uses `'MyWorks'`; Dwarf and `other` use `''` (share root). |

**Why no Dwarf or generic walker file yet:** the Dwarf SMB layout is assumed to match SeeStar's flat object-folder convention until verified against a real Dwarf 3. The "generic" layout documented in the Add Telescope modal (session subfolders + `lights/subframes/`) is a *different* tree structure that nobody has actually tested an importer against — writing that walker today would be speculative. When real divergence shows up, drop a new file in `walkers/` and dispatch on `kind` in `index.ts`.

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

[scheduleAutoImport()](../server/lib/localLibrary.ts) polls every minute and triggers `runAllTelescopesImport()` once per `autoImportInterval`. Telescopes with `autoImportEnabled = 0` are skipped at the `getAutoImportProfiles()` filter — flipping the per-telescope toggle in Settings takes effect on the next tick.

---

## 6. API surface

### Telescope CRUD

`GET /api/telescopes` returns all profiles with masked passwords, plus a server-computed `sessionCount` per telescope (cheap aggregate over `librarySessions`).

`POST /api/telescopes`, `PUT /api/telescopes/:id`, `DELETE /api/telescopes/:id`, `PUT /api/telescopes/active/:id` — same as before, plus accept `kind` / `color` / `autoImportEnabled` fields. Sending the masked password sentinel keeps the existing one.

### Import

`POST /api/library/import` shape:

| Body / query | Meaning |
|---|---|
| `{ objectId }` | Just that object on the active telescope. |
| `{ telescopeId }` | All objects on that telescope. |
| `{ objectId, telescopeId }` | One object on one telescope. |
| `?all=1` (no body) | Every `autoImportEnabled` telescope, sequentially. |
| (no body, no params) | Active telescope only — preserves legacy behavior. |

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

Every multi-telescope UI element renders only when `useQuery(['telescopes']).data.length >= 2`. Backend always returns `telescopeId` fields regardless — the client decides whether to render. This keeps the wire format stable as users cross the threshold; no backend changes needed when they add or remove a second scope.

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
| Top-nav status pill | Single scope: green/grey "Telescope Online/Offline" pill (legacy). 2+ scopes: aggregate "N/M online" pill with multi-color dot stack — clicking opens a popover that lists every telescope with its color, hostname, online state, and latency. |
| Settings → Connection | Card list. Each row shows color swatch, session count, auto-import toggle, edit, delete. Clicking the row opens the Edit modal — which is also where Test Connection lives. No "active" badge; no per-row click-to-activate. |
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

- **Kind dropdown** → preset auto-fills shareName/username/color (only on create; edit preserves user values).
- **Color picker** → 8 hand-picked swatches from the palette.
- **Auto-import toggle** → maps to `autoImportEnabled`.
- **Password field** → in edit mode, blank means "keep existing" (server treats the masked sentinel as no-change too).
- **Test Connection** → calls `POST /api/telescopes/test-connection` with the *current form values* (hostname, share, username, password, kind). Works for both Add (before the profile exists) and Edit (without saving unsaved changes). Returns `{ connected, objectCount?, error? }` with a green/red banner under the button.

The Settings → Connection list also exposes a per-row auto-import toggle that calls `updateTelescope(id, { autoImportEnabled })` directly without opening the modal — for the common "I'm not using the S30 this winter, stop polling it" case.

---

## 9. What's still open

1. **Two scopes, same target, same night.** Collides on the `(objectId, date)` PK. Needs a PK rebuild to include `telescopeId`. See [multi-telescope-support.md §3](multi-telescope-support.md#3-schema-changes).
2. **Real Dwarf 3 share.** Walker assumes SeeStar layout. Verify against hardware before claiming Dwarf is "supported".
3. **Generic walker.** The "Other" kind currently uses the SeeStar walker, which doesn't match the layout documented in the Add Telescope modal (session subfolders + `lights/subframes/`). Either build the walker or remove the doc.
4. **Per-telescope status panel.** Today `importStatus` is global, so the UI shows the most recently importing telescope. A multi-scope user wouldn't know if scope B failed mid-fan-out unless they checked logs. Worth revisiting when there are real users with multiple scopes.
5. **Reassign-on-add suggestion.** When the user adds a new telescope and the backfill stamps every existing session with the previously-active id, there's no UI prompt to say "hey, want to reassign these?" — the user has to do it manually per session. Possibly too clever; revisit if it comes up.
