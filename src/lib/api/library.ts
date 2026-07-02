import type { AstroObject, Session, ProcessedImage } from '../../types';
export type { ProcessedImage };
import { fetchJSON, authHeaders, BASE } from './client';

// FITS header inspection
type FitsValue = string | number | boolean;
interface FitsHeaderData {
  cards: Array<{ key: string; value: FitsValue; comment: string; raw: string }>;
  values: Record<string, FitsValue>;
  categorized: Record<string, Array<{ key: string; value: FitsValue; comment: string }>>;
}


export interface ImportStatus {
  running: boolean;
  currentObject: string | null;
  /** Telescope driving the current import. Null for folder imports and
   *  drag-and-drop uploads — those have no telescope context. */
  telescopeId: string | null;
  /** Display name for the telescope (e.g. "Dwarf II"). Null when
   *  telescopeId is null. */
  telescopeName: string | null;
  /** Which transport ("smb" or "local" for USB) this run is using. Null when
   *  there's no telescope context (folder import or upload). */
  transportKind: 'smb' | 'local' | null;
  objectsTotal: number;
  objectsDone: number;
  filesTotal: number;
  filesDone: number;
  currentObjectFilesTotal: number;
  currentObjectFilesDone: number;
  bytesTotal: number;
  bytesDone: number;
  skippedFiles: number;
  lastRun: string | null;
  error: string | null;
  startedAt: string | null;
  warmingThumbnails: { done: number; total: number } | null;
}

export const getLibraryObjects = () => fetchJSON<AstroObject[]>('/library/objects');
interface LibraryObjectFilter {
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
 *  rather than "local" or "smb". */
export function formatTransport(kind: 'smb' | 'local' | null | undefined): string {
  if (kind === 'local') return 'USB';
  if (kind === 'smb') return 'Wi-Fi';
  return '';
}

/** Build the "from <name> via <transport>" suffix used in progress messages. */
export function formatTransportSuffix(
  telescopeName: string | null | undefined,
  transportKind: 'smb' | 'local' | null | undefined,
): string {
  const parts: string[] = [];
  if (telescopeName) parts.push(`from ${telescopeName}`);
  const label = formatTransport(transportKind);
  if (label) parts.push(`via ${label}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
export const cancelImport = () => fetchJSON<{ cancelled: boolean }>('/library/import/cancel', { method: 'POST' });

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
  files: string[] | null;
  /** Telescope that ran this import (null for folder/upload imports). */
  telescopeId: string | null;
  /** Name snapshotted at run time — survives later profile renames. */
  telescopeName: string | null;
  /** Transport used for this run. */
  transportKind: 'smb' | 'local' | null;
}
export const getImportHistory = (limit = 10, offset = 0) =>
  fetchJSON<{ entries: ImportHistoryEntry[]; total: number }>(`/library/import/history?limit=${limit}&offset=${offset}`);

export const getLibrarySessions = (objectId: string) =>
  fetchJSON<Session[]>(`/library/objects/${encodeURIComponent(objectId)}/sessions`);
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

interface SubFramePreviewGroup {
  folder: string;
  count: number;
  files: string[];
}

export interface SubFramePreviewPurgeResult {
  scannedObjects: number;
  matched: number;
  deleted: number;
  errors: number;
  groups: SubFramePreviewGroup[];
}

/**
 * Remove frame-named preview JPGs (e.g. Light_*.jpg) that older imports copied
 * into the library. `dryRun` counts without deleting. Raw .fit sub-frames and
 * stacked JPGs are never affected.
 */
export const purgeSubFramePreviews = (dryRun: boolean) =>
  fetchJSON<SubFramePreviewPurgeResult>(
    '/library/maintenance/purge-subframe-previews',
    { method: 'POST', body: JSON.stringify({ dryRun }) }
  );

export async function createManualObservation(params: {
  objectName: string;
  date: string;
  notes?: string;
  image?: File | null;
}): Promise<{ objectId: string; date: string }> {
  const formData = new FormData();
  formData.append('objectName', params.objectName);
  formData.append('date', params.date);
  if (params.notes) formData.append('notes', params.notes);
  if (params.image) formData.append('image', params.image, params.image.name);

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
  truncated: boolean;
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
}

/** Phase 1: scan a server-readable folder and return the import plan. */
export const scanImportFolder = (
  rootPath: string,
  importSubFrames?: boolean,
  importFits?: boolean,
) =>
  fetchJSON<ImportScanResult>('/library/import/scan', {
    method: 'POST',
    body: JSON.stringify({ rootPath, importSubFrames, importFits }),
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
    date: reqStr('date'),
    filename: reqStr('filename'),
    originalName: reqStr('originalName'),
    title: reqStr('title'),
    notes: reqStr('notes'),
    size,
    mimeType: reqStr('mimeType'),
    uploadedAt: reqStr('uploadedAt'),
    url: reqStr('url'),
    path: reqStr('path'),
  };
}

/** Upload a folder's files to a server temp dir, returning the temp path for
 *  use with /import/scan and /import/commit. relativePaths should have the
 *  top-level folder name already stripped (client responsibility).
 *
 *  Large directories are split into 500 MB batches to avoid socket timeouts on
 *  single massive requests. Each batch after the first reuses the same server
 *  temp dir via the returned tmpId. */
export async function uploadFolderTemp(
  files: File[],
  relativePaths: string[],
  onProgress?: (sent: number, total: number) => void,
): Promise<{ tmpPath: string; fileCount: number }> {
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

  for (const batch of batches) {
    const batchBytes = batch.files.reduce((sum, f) => sum + f.size, 0);
    let batchSent = 0;

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
      xhr.send(formData);
    });

    tmpPath = result.tmpPath;
    tmpId = result.tmpId;
    totalFileCount += result.fileCount;
  }

  return { tmpPath, fileCount: totalFileCount };
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
): Promise<ProcessedImage> {
  const formData = new FormData();
  formData.append('image', file, file.name);
  formData.append('title', title);
  formData.append('notes', notes);
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

export const deleteProcessedImage = (objectId: string, date: string, id: string) =>
  fetchJSON<{ deleted: boolean; id: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/processed-images/${id}`,
    { method: 'DELETE' }
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
): Promise<{ objectId: string; date: string; filename: string }> {
  const formData = new FormData();
  formData.append('image', file, file.name);
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

// Download URL — streams a ZIP of locally-imported library files (no SMB)
export const getDownloadUrl = (objectId: string, opts?: { fileType?: string; date?: string }) => {
  const params = new URLSearchParams();
  if (opts?.fileType) params.set('fileType', opts.fileType);
  if (opts?.date) params.set('date', opts.date);
  return `${BASE}/library/download/objects/${encodeURIComponent(objectId)}?${params.toString()}`;
};

// ── Async subframe ZIP (3-phase: start → poll → fetch tmp) ──
export const getSubframeFilters = (objectId: string, dates: string[]) =>
  fetchJSON<{ filters: string[] }>(
    `/library/download/objects/${encodeURIComponent(objectId)}/subframe-filters`,
    { method: 'POST', body: JSON.stringify({ dates }) },
  );

export const startSubframesArchive = (objectId: string, dates: string[], filters?: string[]) =>
  fetchJSON<{ jobId: string; filesTotal: number }>(
    `/library/download/objects/${encodeURIComponent(objectId)}/subframes`,
    { method: 'POST', body: JSON.stringify({ dates, ...(filters ? { filters } : {}) }) },
  );

export interface SubframesArchiveStatus {
  status: 'running' | 'done' | 'error';
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
