# Import Pipeline Audit

**Scope covered:** telescope import (`runImport`), the folder-import wizard (scan + `commitFolderImport`), sub-frame sync (`syncSessionSubFrames`), the transport layer (SMB/FTP/local), the walkers, filename parsing, and the frontend (Gallery, ImportModal, FolderImportWizard, SyncSubframesModal).

One correction to the mental model first: **`runFolderImport()` — the "simple folder import" path #7 in `internal-doc/IMPORT-PIPELINE.md` — no longer exists.** It was deliberately deleted (commit `8c22b57`, "had the same full-resave bug"). Only 3 import paths are live today: telescope import, the folder-import wizard, and sub-frame sync. The internal doc is stale on this point — worth a fix since it'll mislead the next person who reads it.

## High severity (real data-loss / data-integrity bugs)

1. **`deleteLocalObject()` orphans files for every nested-layout object.** `server/lib/library/objects.ts:1307-1330` — it does a flat `readdirSync` + `unlinkSync` per entry then `rmdirSync`. New objects use a per-session-subfolder layout, so `unlinkSync` on a subdirectory throws `EISDIR`, silently swallowed by `catch {}`, then `rmdirSync` fails on the non-empty directory, also swallowed. Verified directly: the DB is tombstoned and every `libraryFiles` row is deleted, but the files stay on disk forever — the opposite of what the function's own comment claims. No test covers this at all. Every other recursive-delete site in the codebase correctly uses `fs.rmSync(dir, { recursive: true, force: true })`; this is the one that doesn't.

2. **The folder-import wizard and sub-frame sync never check tombstoned sessions.** `runImport` explicitly filters `deletedSessions[]` before downloading anything (`import.ts:1078`, "strict policy"), but `commitFolderImport` (`server/lib/library/import.ts:2189-2739`) and `syncSessionSubFrames` (`server/lib/library/import.ts:1530-1964`) have no equivalent check. A user who deletes a session, then re-runs the wizard against a source folder that still has those files, silently resurrects it — the exact scenario the tombstone mechanism exists to prevent. `createManualObservation` has the same gap, lower severity since it's a single explicit action.

3. **Empty-library "Upload Observation" button has no import-in-progress gate.** `src/pages/Gallery.tsx:615-625` — confirmed above: its sibling "Import from Telescope" button is `disabled={isImporting || ...}`, this one isn't. Click it while a telescope import is running → the wizard's scan phase succeeds (read-only, no lock) → commit hits `claimImportLock()` and gets rejected → and per finding #5 below, the wizard doesn't retry, so the user's full review session is thrown away.

4. **Gallery's primary "From Telescope" button swallows all import errors.** `src/pages/Gallery.tsx:181-188` — `importMutation` has `onSuccess` but no `onError`, and the status bar only renders while `running` is true, never reads `importStatus.error`. Confirmed no app-wide mutation error handler exists. A 409 (lock held) or a backend failure (bad telescope id, SMB/FTP auth failure) just quietly returns the button to idle. `FolderImportWizard` and `SyncSubframesModal` both surface errors inline — this is the flagship entry point and the worst-behaved one on failure.

## Medium severity

5. **`FolderImportWizard` has no retry-on-lock-conflict, unlike `SyncSubframesModal`.** `src/components/folderImport/FolderImportWizard.tsx:121-129` fails permanently on a 409. `SyncSubframesModal.tsx:51-83` handles the identical race (auto-import scheduler firing concurrently) with a polling wait-and-retry. The wizard is arguably more exposed since a review session can sit open for minutes while a scheduled tick fires.

6. **`purgeJunkFiles` has no import-lock guard and can delete in-flight `.tmp` staging files.** `server/lib/library/housekeeping.ts:42-94` — its sibling `purgeStaleImportTmp` explicitly checks `getImportStatus().running` with a comment explaining exactly this hazard (confirmed at line 120); `purgeJunkFiles` is missing the same guard despite running nightly and at boot alongside imports that write `<dest>.tmp` before renaming.

7. **Delete/move routes never claim the import lock.** `deleteLocalSession`, `deleteSessionSubFrames`, `deleteLocalObject`, `moveObservation` can race directly against an in-progress import writing to the same directory tree.

8. **`parseFilename()`'s fallback regexes accept semantically invalid dates** (month 13, day 99) with zero range validation, unlike `dateDerivation.ts`'s `isPlausibleDate`. Feeds into `Date.UTC()`, which silently normalizes out-of-range values — a session gets misfiled under a bogus date with no error anywhere.

9. **`deriveFileDate()` can't distinguish a genuine device-native filename match from a coincidental one**, so a user-renamed FITS file with an accidental 8+6-digit pattern gets a "high confidence" filename-derived date that silently overrides the file's own accurate `DATE-OBS` header.

10. **Transport-layer caches are never invalidated when a telescope's transport settings change.** `invalidateFtpCache` and `invalidateSmbReachability` exist but have zero production callers (test-only). Worst case: swap which physical Dwarf is connected at the shared default AP IP `192.168.88.1` and the FTP storage-root cache serves the previous device's path prefix for up to 5 minutes.

11. **`smbCache.ts`'s disk cache key is `sha1(path)` with no host/profile component** and no actual TTL despite the module comment claiming one. If a live call for one telescope fails, its error-fallback path can serve back a *different* telescope's cached listing for the same relative path — a cross-device data mixup, not just staleness.

12. **"Not found" semantics diverge across the 5 SMB backends.** `local.ts`/`ftp.ts` return `[]` for a missing directory; `win.ts`/`mac.ts` throw a generic connection error instead — so `ftp.ts`'s comment claiming semantic parity with the others is incorrect for two of the three named backends.

13. **Path-sanitization is implemented three separate times** (`smb.shared.ts`'s `sanitizePath`, `smb.local.ts`'s own `resolveLocal` check, `smb.ftp.ts`'s narrower `assertSafeRemotePath`) instead of one shared guard. No live traversal hole found in any of them today, but a future fix to one won't propagate to the others.

14. **`FolderImportWizard`'s completion screen drops `skipped`/`skippedFiles` after commit**, even though the backend populates them identically to the telescope-import path (and the wizard's own pre-commit scan does show a skip preview) — so the user never sees what was actually excluded during the real commit.

## Minor / design-smell

- Duplicated retry-on-lock-loss loop between `runAllTelescopesImport` (`import.ts:2007`) and `runDueTelescopesImport` (`housekeeping.ts:223`) — near-identical, will drift.
- `smbDelete`'s directory-scope restriction exists on 3 of 5 backends (win/mac/posix) but not local/ftp — currently unused externally, but a latent path-scoping gap the moment a delete feature ships for USB/Dwarf.
- `dwarfWalker.ts`'s dotfile filtering is explicit in one code branch (archive-mode sub-walk) and implicit/downstream-only in the main per-session loop — asymmetric, though not currently a functional bug.
- `canonicalImportName()`'s collision-suffix loop has no clamp against crossing the 7am observing-night rollover boundary — only reachable with a pathological number of same-stem/same-date collisions.
- The premise that `.fit/.fits/.jpg/.jpeg` are exempt from rewriting in `canonicalImportName()` doesn't match the current code — there's no such extension branch; worth correcting in `IMPORT-PIPELINE.md` if that's documented there.

## Suggested priority order

Fix 1–4 first (real data loss / silent failure with no error surfaced to the user), then 5–7 (lock/race hardening), then 8–9 (date-parsing correctness), then the transport-cache items (10–13) as a batch since they're all in the same layer.
