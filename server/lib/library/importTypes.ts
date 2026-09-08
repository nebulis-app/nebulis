/**
 * Types shared between `import.ts` (the run engine) and `importHistory.ts`
 * (the one writer of an `importHistory` row).
 *
 * Split out of `import.ts` so `importHistory.ts` can depend on these shapes
 * without depending on the 4000+ line module that used to declare them —
 * before this split, `importHistory.ts -> import.ts` (type-only) and
 * `import.ts -> importHistory.ts` (real, for `writeImportHistory`) formed the
 * repo's one import cycle. `import type` is erased at build (no
 * `verbatimModuleSyntax` in server/tsconfig.json), so it was never a runtime
 * cycle, but it still meant importHistory.ts couldn't be typechecked in
 * isolation from import.ts.
 */
import type { TransportKind } from '../telescopeTransports.js';
import type { ImportSkipSummary } from './importFilter.js';

export interface ImportStatus {
  running: boolean;
  /** Unique id minted when this run started. Lets a caller cancel exactly
   *  the run it started (see cancelImport) instead of whatever import
   *  happens to be active — e.g. the sub-frame sync modal closing must not
   *  kill an unrelated auto-import that raced in and claimed the lock. Null
   *  when no import has ever run in this process. */
  runId: string | null;
  currentObject: string | null;
  /** Telescope driving the current import run. Null for folder imports and
   *  drag-and-drop uploads, since those have no telescope context. */
  telescopeId: string | null;
  /** Human-readable name of the telescope (e.g. "Dwarf II", "Living-room
   *  SeeStar"). Lets the UI say "Importing M31 from Dwarf II" without
   *  another round-trip. Null when telescopeId is null. */
  telescopeName: string | null;
  /** Which transport this run is using. Drives the "via Wi-Fi" / "via USB"
   *  hint in the import progress UI so users with both transports
   *  configured can see which one the auto-import is actually pulling
   *  from. Null for non-telescope imports. */
  transportKind: TransportKind | null;
  objectsTotal: number;
  objectsDone: number;
  filesTotal: number;
  filesDone: number;
  currentObjectFilesTotal: number;
  currentObjectFilesDone: number;
  bytesTotal: number;
  bytesDone: number;
  skippedFiles: number;
  /** Files this run tried to download and failed on. Only the sub-frame sync
   *  paths set it; `filesDone` there counts every attempt (so the progress bar
   *  still completes), so the whole-object roll-up needs this to report a real
   *  "downloaded" total rather than counting failed frames as successes.
   *  Optional so the other status literals stay unchanged. */
  filesErrored?: number;
  /** Files this run found on the telescope but will not import, grouped by
   *  why, largest group first. Distinct from `skippedFiles`, which counts
   *  files that were already present locally.
   *
   *  Without this the only signal is a file count lower than what is on the
   *  device, which reads as the import losing files rather than as a filter
   *  doing its job. The folder-import wizard has reported this since it
   *  shipped; the telescope path used to leave it in the debug log. */
  skipped: ImportSkipSummary[];
  lastRun: string | null;
  error: string | null;
  /** True when `error` describes a user-requested cancellation rather than a
   *  genuine failure. Lets callers show a cancelled run differently (or not
   *  at all) from an error that needs the user's attention — the Library
   *  page's error banner skips it entirely, since a cancellation is
   *  something the user just did, not new information. The run is still
   *  recorded in Sync History either way. */
  cancelled: boolean;
  startedAt: string | null;
  warmingThumbnails: { done: number; total: number } | null;
  /** True when the user explicitly triggered this run (Sync Now, a
   *  per-object/session sync, a folder import), false for the scheduled
   *  auto-import tick. Threaded into the importHistory row so a zero-new-file
   *  run the user asked for directly can still surface in Sync History,
   *  while a routine background tick that (correctly) found nothing stays
   *  hidden. */
  manual: boolean;
  /** Files copied into the reserved `_archive` directory by this run, and where
   *  it is on disk. Only ever non-zero for a folder import with archive mode
   *  on. Present so the wizard can say the calibration folders were kept:
   *  preserving bytes the user cannot find does not read as "it worked".
   *  Optional so the two telescope-import status literals, which can never
   *  archive anything, stay unchanged. */
  archivedFiles?: number;
  archivePath?: string | null;
  /** Same idea as archivedFiles/archivePath, but for RESTACKED leftovers that
   *  never matched a library object — a separate count and path because they
   *  land in the shared RESTACKED/ root, not the telescope-scoped archive
   *  (see getRestackArchiveDir). */
  restackArchivedFiles?: number;
  restackArchivePath?: string | null;
}

export interface TouchedObject {
  objectId: string;
  /** Display name as it appeared in the source this run (telescope folder
   *  name or import-wizard target), matching the first path segment of the
   *  entries in `files`. */
  name: string;
  /** True if this object had no prior import before this run created it. */
  isNew: boolean;
}

export interface TouchedSession {
  objectId: string;
  objectName: string;
  /** Observing night, YYYY-MM-DD. */
  date: string;
  /** True if this object+date had no prior session before this run. */
  isNew: boolean;
}
