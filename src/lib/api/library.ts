import type { AstroObject, Session, ProcessedImage, SessionCaptureSummary } from '../../types';
export type { ProcessedImage };
import { fetchJSON, authHeaders, BASE } from './client';
import type { ConnectionType as TransportKind } from './telescopes';

// FITS header inspection
type FitsValue = string | number | boolean;
interface FitsHeaderData {
  cards: Array<{ key: string; value: FitsValue; comment: string; raw: string }>;
  values: Record<string, FitsValue>;
  categorized: Record<string, Array<{ key: string; value: FitsValue; comment: string }>>;
}


/** Mirrors ImportSkipReason in server/lib/library/importFilter.ts — kept as an
 *  explicit union (not `string`) so a reason renamed or added server-side is a
 *  compile error here instead of a silently-unhandled string. There's no
 *  shared module across the server/client boundary yet (see
 *  church-audit/church-crusade.md finding W23), so this list must be updated
 *  by hand alongside the server's. */
export type ImportSkipReason =
  | 'not-a-real-file'
  | 'processing-artifact'
  | 'failed-frame'
  | 'non-observation-folder'
  | 'undecodable-session-folder'
  | 'deleted-session'
  | 'date-dropped'
  | 'sub-frames-disabled'
  | 'sub-folder-preview'
  | 'thumbnails-disabled'
  | 'jpg-disabled'
  | 'fits-disabled'
  | 'videos-disabled'
  | 'unsupported-type';

/** One reason files were left out of an import, and how many. `label` is
 *  server-authored and reads as "<count> <label>". Produced identically by the
 *  folder-import scan, the folder-import commit, and the telescope import, so
 *  one renderer covers all three. */
export interface ImportSkip {
  reason: ImportSkipReason;
  label: string;
  count: number;
  /** Total size of the group. Always present on the wire (parseSkipped
   *  normalizes it), but optional here so a hand-built ImportSkip in a test
   *  doesn't need to fill in a field it isn't testing. */
  bytes?: number;
  /** Up to 200 of the skipped filenames, so the UI can list which files a
   *  reason covers. Always present on the wire (parseSkipped normalizes it to
   *  `[]`); optional here for the same reason as `bytes` above. Absent
   *  semantically only for `deleted-session` (which routes to the restore
   *  view instead). `count > samples.length` means the list was truncated. */
  samples?: string[];
}

export interface ImportStatus {
  running: boolean;
  /** Unique id for the active run. Pass to cancelImport(runId) to cancel
   *  exactly this run instead of whatever import happens to be active. */
  runId: string | null;
  currentObject: string | null;
  /** Telescope driving the current import. Null for folder imports and
   *  drag-and-drop uploads — those have no telescope context. */
  telescopeId: string | null;
  /** Display name for the telescope (e.g. "Dwarf II"). Null when
   *  telescopeId is null. */
  telescopeName: string | null;
  /** Which transport this run is using. Null when there's no telescope context
   *  (folder import or upload). */
  transportKind: TransportKind | null;
  objectsTotal: number;
  objectsDone: number;
  filesTotal: number;
  filesDone: number;
  currentObjectFilesTotal: number;
  currentObjectFilesDone: number;
  bytesTotal: number;
  bytesDone: number;
  /** Files that were already present locally, so nothing was transferred.
   *  Rendered as "already synced" — not the same thing as `skipped`. */
  skippedFiles: number;
  /** Files the run found but will not import, grouped by why. Empty when
   *  nothing was left behind. */
  skipped: ImportSkip[];
  lastRun: string | null;
  error: string | null;
  /** True when `error` describes a user-requested cancellation rather than a
   *  genuine failure — a cancelled run is expected, not something that needs
   *  a "something went wrong" treatment. */
  cancelled: boolean;
  startedAt: string | null;
  warmingThumbnails: { done: number; total: number } | null;
  /** Files this run copied into the library's archive folder, and where it is
   *  on disk. Only set by a folder import with archive mode on. */
  archivedFiles?: number;
  archivePath?: string | null;
  /** Same idea, for RESTACKED files that never matched a library object —
   *  a separate count/path since these land in the shared RESTACKED/ folder
   *  at the library root, not the telescope-scoped archive above. */
  restackArchivedFiles?: number;
  restackArchivePath?: string | null;
}

export const getLibraryObjects = () => fetchJSON<AstroObject[]>('/library/objects');

/** The product tour's demo object. Planted when the tour starts so the tour
 *  has something real to walk through on an install with an empty library,
 *  and removed when it ends — it is a stage prop, never left behind. Both are
 *  no-ops when the library already holds real objects. */
export interface TourDemoState {
  /** The demo library object was planted / removed. */
  object: boolean;
  /** Coordinates were filled in on the observing site / handed back. */
  location: boolean;
}
export const plantTourSampleObject = () =>
  fetchJSON<TourDemoState>('/library/sample-object', { method: 'POST' });
export const purgeTourSampleObject = () =>
  fetchJSON<TourDemoState>('/library/sample-object', { method: 'DELETE' });

/** One non-observation folder archive mode kept but did not model. */
export interface ArchivedFolder {
  name: string;
  fileCount: number;
  bytes: number;
  /** Absolute path on the server, so it can be opened in a stacking app. */
  path: string;
}
/** Omit telescopeId for the shared unscoped bucket (a folder-import run with
 *  no telescope assigned, or pre-scoping data — see archiveFolders.ts). */
export const getLibraryArchive = (telescopeId?: string) =>
  fetchJSON<{ path: string; folders: ArchivedFolder[] }>(
    telescopeId ? `/library/archive?telescopeId=${encodeURIComponent(telescopeId)}` : '/library/archive',
  );

/** Every scope (telescope id, or null for the shared unscoped bucket) that
 *  currently has archived data. */
export const getArchiveScopes = () =>
  fetchJSON<Array<string | null>>('/library/archive/scopes');
export interface LibraryObjectFilter {
  id: string;
  label: string;
  matchTypes: string[];
  matchMode?: 'exact' | 'contains';
}
export const getLibraryObjectFilters = () =>
  fetchJSON<LibraryObjectFilter[]>('/library/object-filters');
/** Trigger a manual import.
 *  - `triggerImport()` → all auto-import-enabled telescopes, sequentially.
 *  - `triggerImport({ telescopeId })` → that telescope only.
 *  - `triggerImport({ objectId, telescopeId })` → that object on that telescope.
 *  Pass a bare string for backwards compatibility (treated as `objectId`). */
export const triggerImport = (
  opts?: string | { objectId?: string; telescopeId?: string; all?: boolean },
) => {
  const normalized = typeof opts === 'string' ? { objectId: opts } : opts ?? {};
  const query = normalized.all ? '?all=1' : '';
  const body: Record<string, string> = {};
  if (normalized.objectId) body.objectId = normalized.objectId;
  if (normalized.telescopeId) body.telescopeId = normalized.telescopeId;
  return fetchJSON<{ started: boolean; objectId: string | null; telescopeId: string | null; all: boolean }>(
    `/library/import${query}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
};
export const getImportStatus = () => fetchJSON<ImportStatus>('/library/import/status');

/** Format a transport kind for user-facing copy. Used in import progress
 *  strings and history rows so a Seestar reached via USB reads as "via USB"
 *  rather than "local" or "smb".
 *
 *  Both network protocols read as "Wi-Fi". We never say "SMB" to a user, so
 *  saying "FTP" only for Dwarf owners leaked one vendor's wire protocol while
 *  hiding the other's. The distinction a Dwarf owner actually needs (was this
 *  run over the air or over the cable?) survives intact as Wi-Fi vs USB. */
export function formatTransport(kind: TransportKind | null | undefined): string {
  if (kind === 'local') return 'USB';
  if (kind === 'ftp' || kind === 'smb') return 'Wi-Fi';
  return '';
}

/** Build the "from <name> via <transport>" suffix used in progress messages. */
export function formatTransportSuffix(
  telescopeName: string | null | undefined,
  transportKind: TransportKind | null | undefined,
): string {
  const parts: string[] = [];
  if (telescopeName) parts.push(`from ${telescopeName}`);
  const label = formatTransport(transportKind);
  if (label) parts.push(`via ${label}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
/** Cancel the active import. Pass `runId` (from a prior getImportStatus()
 *  call) to cancel only if that specific run is still active — a caller
 *  that doesn't own the currently-running import must not kill it. Omit to
 *  cancel whatever is running (the main library import cancel button). */
export const cancelImport = (runId?: string) => fetchJSON<{ cancelled: boolean }>('/library/import/cancel', {
  method: 'POST',
  body: JSON.stringify(runId ? { runId } : {}),
});

/** A catalog object touched by one sync run: at least one new file landed in
 *  it, with a flag for whether the run created the object outright. */
export interface TouchedObject {
  objectId: string;
  name: string;
  isNew: boolean;
}

/** An observation night (object + date) touched by one sync run. */
export interface TouchedSession {
  objectId: string;
  objectName: string;
  date: string;
  isNew: boolean;
}

export interface ImportHistoryEntry {
  id: number;
  startedAt: string;
  finishedAt: string;
  objectsTotal: number;
  filesTotal: number;
  newFiles: number;
  bytesTotal: number;
  bytesNew: number;
  error: string | null;
  /** True when `error` describes a user-requested cancellation rather than a
   *  genuine failure. False (including rows recorded before this existed)
   *  otherwise. */
  cancelled: boolean;
  files: string[] | null;
  /** Telescope that ran this import (null for folder/upload imports). */
  telescopeId: string | null;
  /** Name snapshotted at run time — survives later profile renames. */
  telescopeName: string | null;
  /** Transport used for this run. */
  transportKind: TransportKind | null;
  /** What the run left behind and why. Null on rows recorded before this was
   *  tracked, and on runs that skipped nothing. */
  skipped: ImportSkip[] | null;
  /** Objects that got new files this run. Null on rows recorded before this
   *  was tracked, and on runs that added no files. */
  objectsTouched: TouchedObject[] | null;
  /** Observation nights that got new files this run. Same null rule as
   *  objectsTouched. */
  sessionsTouched: TouchedSession[] | null;
}
export const getImportHistory = (limit = 10, offset = 0) =>
  fetchJSON<{ entries: ImportHistoryEntry[]; total: number }>(`/library/import/history?limit=${limit}&offset=${offset}`);

export const getLibrarySessions = (objectId: string, opts?: { includeVariants?: boolean }) =>
  fetchJSON<Session[]>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions${opts?.includeVariants ? '?includeVariants=true' : ''}`
  );
/**
 * What the telescope recorded for each night of one object, keyed by observing
 * night. Backed by the device's own sidecar, so a night is absent when nothing
 * was recorded: render that as unknown, never as zero. Telescopes that write no
 * sidecar (currently anything but a Dwarf) return an empty object.
 */
export const getObjectCapture = (objectId: string) =>
  fetchJSON<Record<string, SessionCaptureSummary>>(
    `/library/objects/${encodeURIComponent(objectId)}/capture`,
  );

export const getLibraryFitsHeaders = (path: string) =>
  fetchJSON<FitsHeaderData>(`/library/headers?path=${encodeURIComponent(path)}`);
export const deleteLibraryFile = (path: string) =>
  fetchJSON<{ deleted: boolean }>(`/library/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
export const deleteLibraryObject = (objectId: string) =>
  fetchJSON<{ deleted: boolean; objectId: string }>(
    `/library/objects/${encodeURIComponent(objectId)}`,
    { method: 'DELETE' }
  );
export const deleteLibrarySession = (objectId: string, date: string) =>
  fetchJSON<{ deleted: boolean; objectId: string; date: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}`,
    { method: 'DELETE' }
  );

/** A deleted object still shown in the trash, awaiting restore or a permanent
 *  cleanup. Local files are already gone; restoring only re-enables sync. */
export interface DeletedObject {
  objectId: string;
  folderName: string;
  objectName: string | null;
  deletedAt: string | null;
}
export const getDeletedObjects = () => fetchJSON<DeletedObject[]>('/library/objects/deleted');
export const restoreLibraryObject = (objectId: string) =>
  fetchJSON<{ restored: boolean; objectId: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/restore`,
    { method: 'POST' },
  );

export interface DeletedSession {
  objectId: string;
  folderName: string;
  objectName: string | null;
  date: string;
  deletedAt: string | null;
}
export const getDeletedSessions = () => fetchJSON<DeletedSession[]>('/library/objects/deleted-sessions');
export const restoreLibrarySession = (objectId: string, date: string) =>
  fetchJSON<{ restored: boolean; objectId: string; date: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/restore`,
    { method: 'POST' },
  );
export const deleteSessionSubFrames = (objectId: string, date: string) =>
  fetchJSON<{ deleted: number; objectId: string; date: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/subframes`,
    { method: 'DELETE' }
  );

export const moveObservation = (objectId: string, date: string, toObjectId: string) =>
  fetchJSON<{ moved: number; fromObjectId: string; toObjectId: string; date: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/move`,
    { method: 'POST', body: JSON.stringify({ toObjectId }) }
  );

export async function createManualObservation(params: {
  objectName: string;
  date: string;
  notes?: string;
  image?: File | null;
  telescopeId?: string;
}): Promise<{ objectId: string; date: string }> {
  const formData = new FormData();
  formData.append('objectName', params.objectName);
  formData.append('date', params.date);
  if (params.notes) formData.append('notes', params.notes);
  if (params.image) formData.append('image', params.image, params.image.name);
  if (params.telescopeId) formData.append('telescopeId', params.telescopeId);

  const res = await fetch(`${BASE}/library/manual-observations`, { method: 'POST', headers: authHeaders(), body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || res.statusText);
  }
  const body = await res.json();
  return (body.data ?? body) as { objectId: string; date: string };
}

export const toggleFavorite = (objectId: string, isFavorite: boolean) =>
  fetchJSON<{ objectId: string; isFavorite: boolean }>(
    `/library/objects/${encodeURIComponent(objectId)}/favorite`,
    { method: isFavorite ? 'POST' : 'DELETE' }
  );

export const syncSessionSubFrames = (objectId: string, date: string) =>
  fetchJSON<{ started: boolean; objectId: string; date: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/sync-subframes`,
    { method: 'POST' }
  );

/** Sync raw sub-frames for every session of the object in one pass. */
export const syncObjectSubFrames = (objectId: string) =>
  fetchJSON<{ started: boolean; objectId: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sync-subframes`,
    { method: 'POST' }
  );

// ─── Folder-import wizard (scan → review → commit) ───────────────────────────
// Mirrors the server types in server/lib/library/folderScan.ts.

interface ImportCatalogMatch {
  objectId: string;
  name: string;
  type: string;
  constellation: string | null;
  magnitude: number | null;
}

interface ImportScannedSession {
  date: string;
  fileCount: number;
  bytes: number;
  source: 'fits' | 'filename' | 'folder' | 'mtime' | 'none';
  confidence: 'high' | 'medium' | 'low' | 'none';
}

interface ImportScannedObject {
  folderName: string;
  fileCount: number;
  bytes: number;
  sessions: ImportScannedSession[];
  unsortedCount: number;
  unsortedBytes: number;
  catalogMatch: ImportCatalogMatch | null;
}

export interface ImportScanResult {
  rootPath: string;
  objects: ImportScannedObject[];
  totals: { objects: number; files: number; sessions: number; unsorted: number; bytes: number };
  /** Files found but not importable, grouped by why, largest group first. */
  skipped: ImportSkip[];
  /** Top-level folders left out because they hold no observations, by name, so
   *  the skip notice can say which ones instead of only how many. */
  excludedFolders: string[];
  truncated: boolean;
  /** Set when the scan detected the given root was a device volume root and
   *  descended into the telescope's vendor base path (e.g. "Astronomy") to
   *  find objects, so the UI can tell the user why. */
  basePathDetected: string | null;
}

interface ImportCommitObject {
  folderName: string;
  skip?: boolean;
  targetObjectId: string;
  targetFolderName: string;
  /** derived session date (or "unknown") → final date, or null to drop. */
  sessionMap: Record<string, string | null>;
}

export interface ImportCommitPlan {
  rootPath: string;
  objects: ImportCommitObject[];
  /** Override the telescope profile's importSubFrames setting for this run. */
  importSubFrames?: boolean;
  /** Override the importFits app setting for this run. */
  importFits?: boolean;
  /** Keep files Nebulis has no use for, so the imported folder is a complete
   *  copy. Does not override the per-type choices above. */
  archiveAllFiles?: boolean;
  /** Telescope to tag every session created by this import with, or null to
   *  leave sessions untagged. */
  telescopeId?: string | null;
}

/** Phase 1: scan a server-readable folder and return the import plan.
 *  `telescopeId`, when passed, lets the scan recognise a device volume root
 *  and descend into that telescope's vendor base path automatically —
 *  otherwise identical to today's "Not sure / mixed sources" behavior. */
export const scanImportFolder = (
  rootPath: string,
  importSubFrames?: boolean,
  importFits?: boolean,
  archiveAllFiles?: boolean,
  telescopeId?: string | null,
) =>
  fetchJSON<ImportScanResult>('/library/import/scan', {
    method: 'POST',
    body: JSON.stringify({ rootPath, importSubFrames, importFits, archiveAllFiles, telescopeId }),
  });

/** Phase 2: commit a reviewed plan. Runs in the background; watch progress via
 *  getImportStatus(). */
export const commitFolderImport = (plan: ImportCommitPlan) =>
  fetchJSON<{ started: boolean; objects: number }>('/library/import/commit', {
    method: 'POST',
    body: JSON.stringify(plan),
  });

/**
 * Converts an unknown value to a `Record<string, unknown>` without a cast,
 * using `Object.fromEntries(Object.entries(...))` to bridge the `object`
 * type to an index-signature record. Returns `null` for non-objects so
 * callers can handle invalid input explicitly.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value));
}

/**
 * Validates the shape returned by the processed-images upload endpoint.
 */
function parseProcessedImage(value: unknown): ProcessedImage {
  const v = asRecord(value);
  if (!v) throw new Error('Processed image response is not an object');
  const reqStr = (key: string): string => {
    const x = v[key];
    if (typeof x !== 'string') {
      throw new Error(`Processed image response missing string \`${key}\``);
    }
    return x;
  };
  const { size } = v;
  if (typeof size !== 'number') {
    throw new Error('Processed image response missing number `size`');
  }
  return {
    id: reqStr('id'),
    objectId: reqStr('objectId'),
    date: typeof v.date === 'string' ? v.date : null,
    filename: reqStr('filename'),
    originalName: reqStr('originalName'),
    title: reqStr('title'),
    notes: reqStr('notes'),
    size,
    mimeType: reqStr('mimeType'),
    uploadedAt: reqStr('uploadedAt'),
    url: reqStr('url'),
    path: reqStr('path'),
    thumbUrl: typeof v.thumbUrl === 'string' ? v.thumbUrl : null,
    runId: typeof v.runId === 'string' ? v.runId : null,
    runDates: Array.isArray(v.runDates) ? v.runDates.filter((d): d is string => typeof d === 'string') : null,
    source: v.source === 'dwarf-restack' ? 'dwarf-restack' : 'user',
  };
}

/** Fire-and-forget breadcrumb into the server's debug log (no-op there unless
 *  debug logging is active). Used to record the browser side of a folder upload
 *  so a client-side stall is visible in the same log the user sends us. Never
 *  throws and never blocks the upload. `keepalive` lets a final breadcrumb flush
 *  even if the tab is navigating away. */
export function reportImportDebug(message: string): void {
  try {
    void fetch(`${BASE}/library/import/debug-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message }),
      keepalive: true,
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

export interface ImportSpaceCheck {
  ok: boolean;
  /** Directory whose volume was measured (the upload staging area). */
  path: string;
  freeBytes: number;
  requiredBytes: number;
  /** Explanation to show the user. Null when `ok`. */
  message: string | null;
}

/** Ask whether the server has room to stage an upload of `bytes` before
 *  sending any of it. */
export const preflightImportSpace = (bytes: number) =>
  fetchJSON<ImportSpaceCheck>('/library/import/preflight', {
    method: 'POST',
    body: JSON.stringify({ bytes }),
  });

export interface ImportTempUsage {
  path: string;
  bytes: number;
  files: number;
  sessions: number;
  oldestAt: string | null;
}

export const getImportTempUsage = () =>
  fetchJSON<ImportTempUsage>('/library/import/temp-usage');

export interface ImportTempCleanupResult {
  deleted: number;
  errors: number;
  bytes: number;
  skippedActive: number;
}

export const cleanupImportTemp = () =>
  fetchJSON<ImportTempCleanupResult>('/library/import/temp-cleanup', { method: 'POST' });

/** Drop a single staged upload session. Best-effort: used when the import
 *  dialog is dismissed mid-upload, where a failure just means the sweeper
 *  reclaims the space later instead. */
export function discardImportTempSession(tmpId: string): void {
  void fetchJSON(`/library/import/temp/${encodeURIComponent(tmpId)}`, { method: 'DELETE' })
    .catch(() => { /* best-effort */ });
}

/** Upload a folder's files to a server temp dir, returning the temp path for
 *  use with /import/scan and /import/commit. relativePaths should have the
 *  top-level folder name already stripped (client responsibility).
 *
 *  Large directories are split into 500 MB batches to avoid socket timeouts on
 *  single massive requests. Each batch after the first reuses the same server
 *  temp dir via the returned tmpId.
 *
 *  When `debug` is true, per-batch breadcrumbs are posted to the server debug
 *  log so a browser-side stall (the upload spinning forever) is diagnosable.
 *
 *  `signal`, if given, is checked before starting each batch and wired to
 *  abort the in-flight XHR — cancellation is cooperative between batches plus
 *  immediate mid-batch, not preemptive. Without this, a caller that dismisses
 *  the upload UI mid-upload has no way to actually stop the batch loop: it
 *  keeps POSTing into the void, and its eventual resolution can still fire
 *  `onProgress`/resolve into a caller that thinks it moved on.
 *
 *  `onTmpId` fires as soon as the server names the staging session, which is
 *  after the first batch rather than at the end. A caller that cancels partway
 *  needs that id to tell the server to drop what was already staged: without
 *  it, an abandoned upload holds its bytes until the sweeper runs. */
export async function uploadFolderTemp(
  files: File[],
  relativePaths: string[],
  onProgress?: (sent: number, total: number) => void,
  debug = false,
  signal?: AbortSignal,
  onTmpId?: (tmpId: string) => void,
): Promise<{ tmpPath: string; tmpId: string | null; fileCount: number }> {
  // Split into batches: max 500 MB or 100 files per request.
  const BATCH_BYTES = 500 * 1024 * 1024;
  const BATCH_FILES = 100;
  const batches: Array<{ files: File[]; paths: string[] }> = [];
  let cur: { files: File[]; paths: string[] } = { files: [], paths: [] };
  let curBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (cur.files.length >= BATCH_FILES || (cur.files.length > 0 && curBytes + f.size > BATCH_BYTES)) {
      batches.push(cur);
      cur = { files: [], paths: [] };
      curBytes = 0;
    }
    cur.files.push(f);
    cur.paths.push(relativePaths[i] || f.name);
    curBytes += f.size;
  }
  if (cur.files.length > 0) batches.push(cur);

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let bytesSent = 0;
  let tmpPath = '';
  let tmpId: string | null = null;
  let totalFileCount = 0;

  if (debug) {
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
    reportImportDebug(
      `[browser] upload starting: ${files.length} files, ${mb(totalBytes)} MB, ` +
      `${batches.length} batches. UA: ${navigator.userAgent}`,
    );
  }

  for (let bi = 0; bi < batches.length; bi++) {
    if (signal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }

    const batch = batches[bi];
    const batchBytes = batch.files.reduce((sum, f) => sum + f.size, 0);
    let batchSent = 0;
    const batchStartedAt = Date.now();
    if (debug) {
      reportImportDebug(
        `[browser] batch ${bi + 1}/${batches.length} starting: ` +
        `${batch.files.length} files, ${(batchBytes / 1024 / 1024).toFixed(1)} MB`,
      );
    }

    const result = await new Promise<{ tmpPath: string; tmpId: string; fileCount: number }>((resolve, reject) => {
      const formData = new FormData();
      batch.files.forEach((f, i) => formData.append('files', f, batch.paths[i] || f.name));
      formData.append('relativePaths', JSON.stringify(batch.paths));
      if (tmpId) formData.append('tmpId', tmpId);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/library/import/upload-temp`);
      const hdrs = authHeaders();
      Object.entries(hdrs).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      if (onProgress) {
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) {
            const delta = e.loaded - batchSent;
            batchSent = e.loaded;
            bytesSent += delta;
            onProgress(bytesSent, totalBytes);
          }
        });
      }
      xhr.onload = () => {
        // Flush any bytes not yet reported (progress events can lag at batch end).
        bytesSent += batchBytes - batchSent;
        batchSent = batchBytes;
        if (onProgress) onProgress(bytesSent, totalBytes);

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText);
            resolve(body?.data ?? body);
          } catch {
            reject(new Error('Invalid response from server'));
          }
        } else {
          try {
            const body = JSON.parse(xhr.responseText);
            reject(new Error(body?.error?.message || body?.error || xhr.statusText));
          } catch {
            reject(new Error(xhr.statusText));
          }
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      // Temporary diagnostic for a live investigation into uploads landing
      // server-side as Content-Length: 0. Sent as a header (not gated behind
      // the debug-logging toggle, and delivered even if the body itself ends
      // up empty/truncated) so we can tell whether the picked File objects
      // still report their real size right at send() time, or have already
      // gone stale between picking and uploading.
      xhr.setRequestHeader('X-Diag-File-Sizes', batch.files.map(f => f.size).join(','));
      xhr.send(formData);
    }).catch((err: unknown) => {
      // A true stall fires neither onload nor onerror, so no breadcrumb lands
      // here and the last "batch N starting" line marks where it hung. This
      // path covers explicit failures (network error, non-2xx, bad response)
      // as well as a deliberate cancellation (AbortError) — skip the "FAILED"
      // breadcrumb for the latter, it isn't a failure.
      if (debug && !(err instanceof DOMException && err.name === 'AbortError')) {
        reportImportDebug(
          `[browser] batch ${bi + 1}/${batches.length} FAILED after ` +
          `${Date.now() - batchStartedAt}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    });

    tmpPath = result.tmpPath;
    if (result.tmpId !== tmpId) onTmpId?.(result.tmpId);
    tmpId = result.tmpId;
    totalFileCount += result.fileCount;
    if (debug) {
      reportImportDebug(
        `[browser] batch ${bi + 1}/${batches.length} complete in ` +
        `${Date.now() - batchStartedAt}ms (server accepted ${result.fileCount} files)`,
      );
    }
  }

  if (debug) reportImportDebug(`[browser] upload finished: ${totalFileCount} files accepted across ${batches.length} batches`);
  return { tmpPath, tmpId, fileCount: totalFileCount };
}

// Gallery image
export const getGalleryImage = (objectId: string) =>
  fetchJSON<{ objectId: string; galleryImage: string | null }>(
    `/library/objects/${encodeURIComponent(objectId)}/gallery-image`
  );

export const setGalleryImage = (objectId: string, imagePath: string | null) =>
  fetchJSON<{ objectId: string; galleryImage: string | null }>(
    `/library/objects/${encodeURIComponent(objectId)}/gallery-image`,
    { method: 'PUT', body: JSON.stringify({ imagePath }) }
  );

export async function uploadGalleryImage(objectId: string, file: File): Promise<{ objectId: string; galleryImage: string }> {
  const formData = new FormData();
  formData.append('image', file, file.name);
  const res = await fetch(`${BASE}/library/objects/${encodeURIComponent(objectId)}/gallery-image/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || res.statusText);
  }
  const body = await res.json();
  return (body.data ?? body) as { objectId: string; galleryImage: string };
}

interface StackedImage {
  name: string;
  path: string;
  date: string;
  downloadUrl: string;
}

export const getStackedImages = (objectId: string) =>
  fetchJSON<StackedImage[]>(`/library/objects/${encodeURIComponent(objectId)}/stacked-images`);

// Session image
export const setSessionImage = (objectId: string, date: string, imagePath: string | null) =>
  fetchJSON<{ objectId: string; date: string; sessionImage: string | null }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/session-image`,
    { method: 'PUT', body: JSON.stringify({ imagePath }) }
  );

// Processed images
export const getProcessedImages = (objectId: string, date: string) =>
  fetchJSON<ProcessedImage[]>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/processed-images`
  );

export const getAllProcessedImagesForObject = (objectId: string) =>
  fetchJSON<ProcessedImage[]>(`/library/objects/${encodeURIComponent(objectId)}/processed-images`);

export async function uploadProcessedImage(
  objectId: string,
  date: string,
  file: File,
  title: string,
  notes: string,
  runId?: string | null,
): Promise<ProcessedImage> {
  const formData = new FormData();
  formData.append('image', file, file.name);
  formData.append('title', title);
  formData.append('notes', notes);
  if (runId) formData.append('runId', runId);
  const res = await fetch(
    `${BASE}/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/processed-images`,
    { method: 'POST', headers: authHeaders(), body: formData }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || res.statusText);
  }
  const body = await res.json();
  return parseProcessedImage(body?.data ?? body);
}

/** Overwrite an existing processed image's file in place, keeping its id,
 *  title, notes and session date. Backs the image editor's "Save" (vs
 *  `uploadProcessedImage`, which is "Save as new version"). */
export async function overwriteProcessedImage(
  objectId: string,
  id: string,
  file: File,
): Promise<ProcessedImage> {
  const formData = new FormData();
  formData.append('image', file, file.name);
  const res = await fetch(
    `${BASE}/library/objects/${encodeURIComponent(objectId)}/processed-images/${encodeURIComponent(id)}`,
    { method: 'PUT', headers: authHeaders(), body: formData },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || res.statusText);
  }
  const body = await res.json();
  return parseProcessedImage(body?.data ?? body);
}

/** Object-scoped processed-image upload, no session date. The image is filed
 *  against the object itself (date NULL) and appears in the aggregate
 *  Processed Images section, not under any one observation. Metadata is not
 *  collected on this path — just the file. */
export async function uploadObjectProcessedImage(
  objectId: string,
  file: File,
): Promise<ProcessedImage> {
  const formData = new FormData();
  formData.append('image', file, file.name);
  const res = await fetch(
    `${BASE}/library/objects/${encodeURIComponent(objectId)}/processed-images`,
    { method: 'POST', headers: authHeaders(), body: formData },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || res.statusText);
  }
  const body = await res.json();
  return parseProcessedImage(body?.data ?? body);
}

export const deleteProcessedImage = (objectId: string, date: string, id: string) =>
  fetchJSON<{ deleted: boolean; id: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/processed-images/${id}`,
    { method: 'DELETE' }
  );

/** Object-scoped delete, no session date — for the aggregate "Processed"
 *  section, which mixes images from many dates (and Dwarf RESTACKED imports
 *  with no date at all) in one list. */
export const deleteObjectProcessedImage = (objectId: string, id: string) =>
  fetchJSON<{ deleted: boolean; id: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/processed-images/${id}`,
    { method: 'DELETE' }
  );

// Processing runs — which session dates a combined processed image draws on.
export interface ProcessingRun {
  id: string;
  objectId: string;
  title: string;
  notes: string;
  software: string;
  createdAt: string;
  dates: string[];
}

export const getProcessingRuns = (objectId: string) =>
  fetchJSON<ProcessingRun[]>(`/library/objects/${encodeURIComponent(objectId)}/processing-runs`);

export const createProcessingRun = (
  objectId: string,
  data: { dates: string[]; title?: string; notes?: string; software?: string },
) =>
  fetchJSON<ProcessingRun>(
    `/library/objects/${encodeURIComponent(objectId)}/processing-runs`,
    { method: 'POST', body: JSON.stringify(data) },
  );

export const getLibraryFileUrl = (filePath: string) =>
  `${BASE}/library/file?path=${encodeURIComponent(filePath)}`;

/** Library tile thumbnail URL.
 *  Pass `version` (typically `object.galleryImage`) so the URL changes when
 *  the user picks a new gallery image — defeats the browser's 24h cache for
 *  this endpoint. The server ignores the param. */
export const getLibraryObjectThumbnailUrl = (
  objectId: string,
  w = 400,
  h = 400,
  version?: string | null,
) => {
  const v = version ? `&v=${encodeURIComponent(version)}` : '';
  return `${BASE}/library/objects/${encodeURIComponent(objectId)}/thumbnail?w=${w}&h=${h}${v}`;
};

export const getLibraryFileThumbnailUrl = (filePath: string, w = 400, h = 400) =>
  `${BASE}/library/file/thumbnail?path=${encodeURIComponent(filePath)}&w=${w}&h=${h}`;

export async function uploadLibraryFile(
  objectId: string,
  date: string,
  file: File,
  /** When set, overwrite this exact library-relative file (image editor
   *  "Save") instead of writing a new "…E.jpg" variant ("Save as new
   *  version"). */
  overwritePath?: string,
): Promise<{ objectId: string; date: string; filename: string }> {
  const formData = new FormData();
  formData.append('image', file, file.name);
  if (overwritePath) formData.append('overwritePath', overwritePath);
  const res = await fetch(
    `${BASE}/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/library-files`,
    { method: 'POST', headers: authHeaders(), body: formData }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || res.statusText);
  }
  const body = await res.json();
  return (body.data ?? body) as { objectId: string; date: string; filename: string };
}

// Whole-object ZIP download (locally-imported files, no SMB).
//
// The ZIP route needs a credential the browser can attach to a plain
// `<a download>` navigation, which cannot carry an Authorization header. So this
// makes an authenticated call to mint a short-lived signed URL; the caller then
// points an <a> at `url` and clicks it. The token in `url` expires in minutes.
export const requestObjectDownloadUrl = (
  objectId: string,
  opts?: { fileType?: string; date?: string; includeVariants?: boolean },
) =>
  fetchJSON<{ url: string; expiresInMs: number }>(
    `/library/download/objects/${encodeURIComponent(objectId)}/link`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(opts?.fileType ? { fileType: opts.fileType } : {}),
        ...(opts?.date ? { date: opts.date } : {}),
        ...(opts?.includeVariants ? { includeVariants: true } : {}),
      }),
    },
  );

// ── Async subframe ZIP (3-phase: start → poll → fetch tmp) ──
export const getSubframeFilters = (objectId: string, dates: string[], includeVariants?: boolean) =>
  fetchJSON<{ filters: string[] }>(
    `/library/download/objects/${encodeURIComponent(objectId)}/subframe-filters`,
    { method: 'POST', body: JSON.stringify({ dates, ...(includeVariants ? { includeVariants: true } : {}) }) },
  );

export const startSubframesArchive = (
  objectId: string,
  dates: string[],
  filters?: string[],
  includeVariants?: boolean,
  sirilLayout?: boolean,
) =>
  fetchJSON<{ jobId: string; filesTotal: number }>(
    `/library/download/objects/${encodeURIComponent(objectId)}/subframes`,
    {
      method: 'POST',
      body: JSON.stringify({
        dates,
        ...(filters ? { filters } : {}),
        ...(includeVariants ? { includeVariants: true } : {}),
        ...(sirilLayout ? { sirilLayout: true } : {}),
      }),
    },
  );

export interface SubframesArchiveStatus {
  status: 'running' | 'done' | 'error' | 'cancelled';
  filesTotal: number;
  filesDone: number;
  elapsedMs: number;
  token?: string;
  filename?: string;
  size?: number;
  error?: string;
}

export const getSubframesArchiveStatus = (jobId: string) =>
  fetchJSON<SubframesArchiveStatus>(`/library/download/status/${encodeURIComponent(jobId)}`);

/** Stop an in-flight ZIP build server-side. Idempotent; safe to call after it finished. */
export const cancelSubframesArchive = (jobId: string) =>
  fetchJSON<{ cancelled: boolean }>(`/library/download/status/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });

export const getSubframesArchiveTmpUrl = (token: string) =>
  `${BASE}/library/download/tmp/${encodeURIComponent(token)}`;

// Image gallery
export interface LibraryImage {
  name: string;
  path: string;
  date: string;
  objectId: string;
  objectName: string;
  objectType: string | null;
  distanceLy: number | null;
  downloadUrl: string;
  isFavorite: boolean;
  /** True for a user-uploaded post-processing result, false for a raw
   *  telescope file. Drives the Gallery page's "Processed only" filter. */
  isProcessed: boolean;
}

/** Paginated response envelope for /library/all-images. */
interface LibraryImagesPage {
  items: LibraryImage[];
  total: number;
  /** Offset for the next page, or null when this was the last page. */
  nextOffset: number | null;
}

/**
 * Fetch the full library image list (legacy behavior). The server returns a
 * `{ items, total, nextOffset }` envelope; we unwrap `items` so existing
 * callers keep the `LibraryImage[]` shape.
 */
export const getAllLibraryImages = async (): Promise<LibraryImage[]> => {
  const page = await fetchJSON<LibraryImagesPage>('/library/all-images');
  return page.items;
};

export const getImageFavorites = () =>
  fetchJSON<string[]>('/library/image-favorites');

export const toggleImageFavorite = (imagePath: string, isFavorite: boolean) =>
  fetchJSON<{ imagePath: string; isFavorite: boolean }>(
    '/library/images/favorite',
    { method: isFavorite ? 'POST' : 'DELETE', body: JSON.stringify({ imagePath }) }
  );

// ─── File location ("where do these files live") ─────────────────────────────

export interface DiskLocation {
  relPath: string;
  path: string;
  exists: boolean;
}

export interface ObjectLocation {
  storage: 'local' | 'network';
  libraryRoot: string;
  object: DiskLocation;
  session: DiskLocation | null;
  /** Other objects in the same variant family (Mosaic/Hα/...). Only populated
   *  for the object-level view (no date). */
  variants: Array<DiskLocation & { objectId: string; label: string }>;
}

export const getObjectLocation = (objectId: string, date?: string) =>
  fetchJSON<ObjectLocation>(
    `/library/objects/${encodeURIComponent(objectId)}/location${date ? `?date=${encodeURIComponent(date)}` : ''}`,
  );
