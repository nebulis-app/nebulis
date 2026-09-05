/**
 * Library — processed-image domain.
 *
 * User-uploaded post-processing results stored under `<objectFolder>/processed/`
 * with a row per file in `sessionProcessedImages`.
 */
import fs from 'fs';
import path from 'path';
import { getLibraryDir } from '../libraryPath.js';
import { ILLEGAL_FS_CHARS } from './importNaming.js';
import { isErrnoException } from '../errors.js';
import { FITS_THUMBNAIL_PIPELINE_VERSION } from '../fitsThumbnail.js';
import { isDwarfThumbnailPreviewName } from './dwarfRestack.js';
import {
  stmts,
  getFolderName,
  LIBRARY_API_BASE,
  type ProcessedImageRow,
  type ProcessedImageSource,
} from './objects.js';
import { getRunDates } from './processingRuns.js';

// Single source of truth for every processed-image format: which extensions
// are accepted, whether each can be rendered in an <img> tag, and the MIME
// type to record for it. RENDERABLE_PROCESSED / STORED_PROCESSED / the upload
// fileFilter / the browser-download MIME lookup in server/routes/library.ts
// all derive from this instead of re-listing extensions by hand.
//
// Renderable formats get a thumbnail in the processed-images grid and are the
// only ones eligible to become a session's auto-picked primary image (see
// getLocalSessions / getLocalObservations in observations.ts) — an XISF or
// 32-bit FITS can't be handed to an <img> tag.
//
// Stored-only formats are the output of a real processing workflow. A
// PixInsight or Siril user's deliverable is an XISF or a 32-bit FITS, and
// refusing those meant Nebulis could not hold the finished work it exists to
// organize. The grid shows them as a file card with a download button.
// `.fits` is deliberately included even though telescope FITS arrives via
// import: a calibrated or integrated stack coming *back* from an external tool
// is a processed image, and there was previously no way to store one. MIME
// types are real IANA types where one exists, so a browser download names and
// handles the file correctly; falling back to image/jpeg would tell the
// client an XISF is a renderable JPEG, so callers must use the shared
// 'application/octet-stream' fallback in processedImageMimeType, never guess.
const PROCESSED_FORMATS: Record<string, { mime: string; renderable: boolean }> = {
  jpg:  { mime: 'image/jpeg', renderable: true },
  jpeg: { mime: 'image/jpeg', renderable: true },
  png:  { mime: 'image/png', renderable: true },
  tif:  { mime: 'image/tiff', renderable: true },
  tiff: { mime: 'image/tiff', renderable: true },
  fit:  { mime: 'application/fits', renderable: false },
  fits: { mime: 'application/fits', renderable: false },
  fts:  { mime: 'application/fits', renderable: false },
  xisf: { mime: 'application/x-xisf', renderable: false },
  psd:  { mime: 'image/vnd.adobe.photoshop', renderable: false },
  xcf:  { mime: 'image/x-xcf', renderable: false },
  dng:  { mime: 'image/x-adobe-dng', renderable: false },
  cr2:  { mime: 'image/x-canon-cr2', renderable: false },
  cr3:  { mime: 'image/x-canon-cr3', renderable: false },
  nef:  { mime: 'image/x-nikon-nef', renderable: false },
  arw:  { mime: 'image/x-sony-arw', renderable: false },
};

const extensionsWhere = (renderable: boolean) =>
  Object.keys(PROCESSED_FORMATS).filter(ext => PROCESSED_FORMATS[ext].renderable === renderable);

const RENDERABLE_PROCESSED = new RegExp(`\\.(${extensionsWhere(true).join('|')})$`, 'i');
const STORED_PROCESSED = new RegExp(`\\.(${extensionsWhere(false).join('|')})$`, 'i');

// The subset of STORED_PROCESSED that /fits-thumbnail can actually render.
// Mirrors that route's own check in server/routes/library.ts.
const FITS_PROCESSED = /\.f(?:it|its|ts)$/i;

export function isRenderableProcessedName(name: string): boolean {
  return RENDERABLE_PROCESSED.test(name);
}

export function isStoredOnlyProcessedName(name: string): boolean {
  return STORED_PROCESSED.test(name);
}

/** MIME type for a processed-image upload's filename, keyed off its
 *  extension. Falls back to 'application/octet-stream' for anything outside
 *  PROCESSED_FORMATS (isRenderableProcessedName/isStoredOnlyProcessedName
 *  should already have gated the upload, so this is a last-resort default,
 *  never a signal that the file is safe to render). */
export function processedImageMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return PROCESSED_FORMATS[ext]?.mime || 'application/octet-stream';
}

export function isFitsProcessedName(name: string): boolean {
  return FITS_PROCESSED.test(name);
}

/** Server-rendered JPEG thumbnail URL for a stored-only processed image, or
 *  null when the format has no renderer (XISF, PSD, RAW, ...). Same
 *  generate-if-missing route and cache-busting version query the ordinary
 *  FITS subframe grid uses (observations.ts) — a RESTACKED .fits file gets
 *  the identical treatment instead of falling back to a bare file-card icon. */
function thumbUrlFor(filename: string, libPath: string): string | null {
  if (!isFitsProcessedName(filename)) return null;
  return `${LIBRARY_API_BASE}/fits-thumbnail?v=${FITS_THUMBNAIL_PIPELINE_VERSION}&path=${encodeURIComponent(libPath)}`;
}

/** Resolve `<LIBRARY_DIR>/<folder for objectId>[/...extra]`, refusing to
 *  return a path outside LIBRARY_DIR. getFolderName falls back to the raw
 *  objectId on a DB miss, so a crafted objectId with traversal tokens would
 *  otherwise escape the library root for every function in this module that
 *  reads, writes, or deletes a processed image. */
function resolveContainedObjectDir(objectId: string, ...extra: string[]): string {
  const LIBRARY_DIR = getLibraryDir();
  const dir = path.resolve(LIBRARY_DIR, getFolderName(objectId), ...extra);
  if (dir !== LIBRARY_DIR && !dir.startsWith(LIBRARY_DIR + path.sep)) {
    throw new Error(`Object id "${objectId}" resolves outside the library`);
  }
  return dir;
}

/**
 * Pick an on-disk name for an uploaded processed image that keeps the user's
 * original filename intact (so it matches whatever the telescope/stacking app
 * called it) instead of the opaque `<id>.<ext>` this used to write. Only
 * deviates from the original when it collides with a file already in `dir` or
 * contains characters the filesystem can't hold.
 */
function uniqueProcessedFilename(dir: string, originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  const rawStem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot).toLowerCase() : '';
  const stem = rawStem.replace(ILLEGAL_FS_CHARS, '_').trim() || 'file';

  let candidate = `${stem}${ext}`;
  for (let counter = 2; fs.existsSync(path.join(dir, candidate)); counter++) {
    candidate = `${stem} (${counter})${ext}`;
  }
  return candidate;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProcessedImageRecord {
  id: string;
  objectId: string;
  /** NULL for an image not tied to any single observing night (currently
   *  only Dwarf RESTACKED auto-imports — see `source`). */
  date: string | null;
  filename: string;
  originalName: string;
  title: string;
  notes: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  url: string;
  /** Relative library path (folderName/processed/filename) — safe to pass to /library/file. */
  path: string;
  /** Server-rendered thumbnail for a FITS processed image; null for anything
   *  else (renderable formats need no separate thumbnail, and other
   *  stored-only formats like XISF have no renderer). */
  thumbUrl: string | null;
  runId: string | null;
  /** All session dates the run covers, sorted, when runId is set and covers
   *  more than one night. Null for single-session images so the UI only
   *  needs to check truthiness to decide whether to show a "combined" badge. */
  runDates: string[] | null;
  source: ProcessedImageSource;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** Full-image URL for a processed image, carrying an `uploadedAt`-derived
 *  version query so a browser (which caches `/processed-images/:id` for an
 *  hour) fetches fresh bytes after the file is overwritten in place by the
 *  image editor's "Save". The route ignores the param. */
function processedImageUrl(id: string, uploadedAt: string): string {
  return `${LIBRARY_API_BASE}/processed-images/${id}?v=${Date.parse(uploadedAt) || 0}`;
}

function withRunDates(row: ProcessedImageRow, folderName: string): ProcessedImageRecord {
  const dates = getRunDates(row.runId);
  const path = `${folderName}/processed/${row.filename}`;
  return {
    ...row,
    url: processedImageUrl(row.id, row.uploadedAt),
    path,
    thumbUrl: thumbUrlFor(row.filename, path),
    runDates: dates && dates.length > 1 ? dates : null,
  };
}

/** List all processed images for a session, newest first. Excludes Dwarf's
 *  redundant `stacked_thumbnail.*` preview (see isDwarfThumbnailPreviewName)
 *  so it never shows even for a row imported before this filter existed. */
export function getProcessedImages(objectId: string, date: string): ProcessedImageRecord[] {
  const folderName = getFolderName(objectId);
  return stmts.getProcessedImages.all(objectId, date)
    .filter(r => !isDwarfThumbnailPreviewName(r.originalName))
    .map(r => withRunDates(r, folderName));
}

/** List all processed images for an object across all sessions, newest first.
 *  Same `stacked_thumbnail.*` exclusion as getProcessedImages. */
export function getAllProcessedImagesForObject(objectId: string): ProcessedImageRecord[] {
  const folderName = getFolderName(objectId);
  return stmts.getAllProcessedImagesForObject.all(objectId)
    .filter(r => !isDwarfThumbnailPreviewName(r.originalName))
    .map(r => withRunDates(r, folderName));
}

/** Get a single processed image record by id (null if not found). */
export function getProcessedImageRecord(id: string): ProcessedImageRecord | null {
  const row = stmts.getProcessedImage.get(id);
  if (!row) return null;
  return withRunDates(row, getFolderName(row.objectId));
}

/** Save an uploaded (or auto-imported) processed image to disk and record it
 *  in the DB. `runId` links it to a processingRuns row (see processingRuns.ts)
 *  when the upload combines more than one session; omit for the common
 *  single-session case. `date` is null for an image not tied to any single
 *  observing night (a Dwarf RESTACKED file, tagged `source: 'dwarf-restack'`
 *  — see dwarfRestack.ts). */
export function addProcessedImage(
  objectId: string,
  date: string | null,
  sourcePath: string,
  originalName: string,
  mimeType: string,
  title: string,
  notes: string,
  runId: string | null = null,
  source: ProcessedImageSource = 'user',
): ProcessedImageRecord {
  const id = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const processedDir = resolveContainedObjectDir(objectId, 'processed');
  if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

  const filename = uniqueProcessedFilename(processedDir, originalName);
  const destPath = path.join(processedDir, filename);
  const size = fs.statSync(sourcePath).size;
  try {
    fs.renameSync(sourcePath, destPath);
  } catch (renameErr) {
    if (isErrnoException(renameErr) && renameErr.code === 'EXDEV') {
      fs.copyFileSync(sourcePath, destPath);
      fs.unlinkSync(sourcePath);
    } else {
      throw renameErr;
    }
  }

  const uploadedAt = new Date().toISOString();
  stmts.insertProcessedImage.run(id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt, runId, source);

  const folderName = getFolderName(objectId);
  const runDates = getRunDates(runId);
  const recordPath = `${folderName}/processed/${filename}`;
  return {
    id, objectId, date, filename, originalName, title, notes,
    size, mimeType, uploadedAt, runId, source,
    url: processedImageUrl(id, uploadedAt),
    path: recordPath,
    thumbUrl: thumbUrlFor(filename, recordPath),
    runDates: runDates && runDates.length > 1 ? runDates : null,
  };
}

/**
 * Overwrite an existing processed image's file bytes in place, keeping its DB
 * row and id. This backs the image editor's "Save" (vs "Save as new version",
 * which calls addProcessedImage and creates a separate row).
 *
 * The new bytes go to a fresh unique filename and the old file is removed, so
 * the thumbUrl (keyed on the filename) and the `?v=` on `url` both change —
 * nothing renders a stale copy. Title, notes, runId and the session date are
 * left untouched: this swaps the picture, not the identity.
 */
export function replaceProcessedImageFile(
  id: string,
  sourcePath: string,
  originalName: string,
  mimeType: string,
): ProcessedImageRecord | null {
  const row = stmts.getProcessedImage.get(id);
  if (!row) {
    try { fs.unlinkSync(sourcePath); } catch { /* best-effort */ }
    return null;
  }

  const processedDir = resolveContainedObjectDir(row.objectId, 'processed');
  if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

  const oldFilename = row.filename;
  const filename = uniqueProcessedFilename(processedDir, originalName);
  const destPath = path.join(processedDir, filename);
  const size = fs.statSync(sourcePath).size;
  try {
    fs.renameSync(sourcePath, destPath);
  } catch (renameErr) {
    if (isErrnoException(renameErr) && renameErr.code === 'EXDEV') {
      fs.copyFileSync(sourcePath, destPath);
      fs.unlinkSync(sourcePath);
    } else {
      throw renameErr;
    }
  }
  if (oldFilename !== filename) {
    try { fs.unlinkSync(path.join(processedDir, oldFilename)); } catch { /* best-effort */ }
  }

  const uploadedAt = new Date().toISOString();
  stmts.updateProcessedImageFile.run(filename, originalName, size, mimeType, uploadedAt, id);

  const folderName = getFolderName(row.objectId);
  const recordPath = `${folderName}/processed/${filename}`;
  const runDates = getRunDates(row.runId);
  return {
    id,
    objectId: row.objectId,
    date: row.date,
    filename,
    originalName,
    title: row.title,
    notes: row.notes,
    size,
    mimeType,
    uploadedAt,
    runId: row.runId,
    source: row.source,
    url: processedImageUrl(id, uploadedAt),
    path: recordPath,
    thumbUrl: thumbUrlFor(filename, recordPath),
    runDates: runDates && runDates.length > 1 ? runDates : null,
  };
}

/** True when this exact Dwarf RESTACKED file has already been imported for
 *  this object, so a re-sync doesn't accumulate duplicate rows. */
export function hasRestackedImage(objectId: string, originalName: string): boolean {
  return !!stmts.getRestackedImageByName.get(objectId, originalName);
}

/** Get the file data for a processed image (null if not found). */
export function getProcessedImageFile(id: string): { data: Buffer; name: string; mimeType: string } | null {
  const row = stmts.getProcessedImage.get(id);
  if (!row) return null;
  const filePath = resolveContainedObjectDir(row.objectId, 'processed', row.filename);
  if (!fs.existsSync(filePath)) return null;
  return { data: fs.readFileSync(filePath), name: row.originalName, mimeType: row.mimeType };
}

/** Delete a processed image record and its file from disk. */
export function deleteProcessedImage(id: string): void {
  const row = stmts.getProcessedImage.get(id);
  if (!row) return;
  const filePath = resolveContainedObjectDir(row.objectId, 'processed', row.filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best-effort */ }
  stmts.deleteProcessedImageRow.run(id);
}
