/**
 * Library — processing-project-archive domain.
 *
 * A "processed image" (see processed.ts) is the finished deliverable; this
 * module holds the *working project* behind it — the Siril `.siril`/log
 * bundle or PixInsight process-icons/masters/`.xipp` folder a user zips up so
 * the whole processing session can be revisited or resumed later, not just
 * the final JPEG/TIFF/XISF it produced. Stored under
 * `<objectFolder>/project-archives/` with one row per file in
 * `projectArchives` (see ProjectArchiveRow in objects.ts).
 *
 * Object-scoped only, same as a Dwarf RESTACKED processed image: a real
 * processing project routinely draws on more than one night's subs, so there
 * is no single observing session to anchor an archive to.
 */
import fs from 'fs';
import path from 'path';
import { ILLEGAL_FS_CHARS } from './importNaming.js';
import { isErrnoException } from '../errors.js';
import {
  stmts,
  getFolderName,
  resolveContainedObjectDir,
  LIBRARY_API_BASE,
  type ProjectArchiveRow,
} from './objects.js';

// Only a zip archive is accepted — the one container format every
// processing tool (PixInsight's own project export, Siril, a manual
// "select project files, compress") can produce without extra software. A
// user's project genuinely could be a bare folder, but Nebulis has no way to
// receive a folder over this upload route, only a single file.
const PROJECT_ARCHIVE_EXT = /\.zip$/i;
// PixInsight's own single-file project formats, uploaded by the PixInsight connector:
// `.xpsm` (process icons) and `.pxiproject`. They are stored and served as opaque files.
const PIXINSIGHT_PROJECT_EXT = /\.(xpsm|pxiproject)$/i;

export function isProjectArchiveName(name: string): boolean {
  return PROJECT_ARCHIVE_EXT.test(name) || PIXINSIGHT_PROJECT_EXT.test(name);
}

export function projectArchiveMimeType(name?: string): string {
  return name && PIXINSIGHT_PROJECT_EXT.test(name) ? 'application/octet-stream' : 'application/zip';
}

/** Resolve `<LIBRARY_DIR>/<folder for objectId>[/...extra]`, throwing rather
 *  than returning null so every call site here can stay a plain
 *  `const dir = resolveArchiveDir(...)` — objects.ts's shared
 *  resolveContainedObjectDir returns null on escape (its callers mostly
 *  already branch on truthiness); this module's callers all want to abort the
 *  request instead, exactly like processed.ts's own local helper. */
function resolveArchiveDir(objectId: string, ...extra: string[]): string {
  const dir = resolveContainedObjectDir(objectId, ...extra);
  if (!dir) throw new Error(`Object id "${objectId}" resolves outside the library`);
  return dir;
}

/** Pick an on-disk name for an uploaded archive that keeps the user's
 *  original filename intact, only deviating when it collides with a file
 *  already in `dir` or holds characters the filesystem can't take. Mirrors
 *  processed.ts's uniqueProcessedFilename. */
function uniqueArchiveFilename(dir: string, originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  const rawStem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot).toLowerCase() : '';
  const stem = rawStem.replace(ILLEGAL_FS_CHARS, '_').trim() || 'project';

  let candidate = `${stem}${ext}`;
  for (let counter = 2; fs.existsSync(path.join(dir, candidate)); counter++) {
    candidate = `${stem} (${counter})${ext}`;
  }
  return candidate;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProjectArchiveRecord {
  id: string;
  objectId: string;
  filename: string;
  originalName: string;
  title: string;
  notes: string;
  software: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  url: string;
  /** Relative library path (folderName/project-archives/filename) — safe to
   *  pass to /library/file, mirroring ProcessedImageRecord.path. */
  path: string;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

function archiveUrl(id: string): string {
  return `${LIBRARY_API_BASE}/project-archives/${id}`;
}

function toRecord(row: ProjectArchiveRow, folderName: string): ProjectArchiveRecord {
  return {
    ...row,
    url: archiveUrl(row.id),
    path: `${folderName}/project-archives/${row.filename}`,
  };
}

/** List every processing-project archive for an object, newest first. */
export function getProjectArchivesForObject(objectId: string): ProjectArchiveRecord[] {
  const folderName = getFolderName(objectId);
  return stmts.getProjectArchivesForObject.all(objectId).map(r => toRecord(r, folderName));
}

/** Get a single archive record by id (null if not found). */
export function getProjectArchiveRecord(id: string): ProjectArchiveRecord | null {
  const row = stmts.getProjectArchive.get(id);
  if (!row) return null;
  return toRecord(row, getFolderName(row.objectId));
}

/** Save an uploaded project archive to disk and record it in the DB. */
export function addProjectArchive(
  objectId: string,
  sourcePath: string,
  originalName: string,
  mimeType: string,
  title: string,
  notes: string,
  software: string,
): ProjectArchiveRecord {
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const archiveDir = resolveArchiveDir(objectId, 'project-archives');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const filename = uniqueArchiveFilename(archiveDir, originalName);
  const destPath = path.join(archiveDir, filename);
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
  stmts.insertProjectArchive.run(id, objectId, filename, originalName, title, notes, software, size, mimeType, uploadedAt);

  const folderName = getFolderName(objectId);
  return {
    id, objectId, filename, originalName, title, notes, software,
    size, mimeType, uploadedAt,
    url: archiveUrl(id),
    path: `${folderName}/project-archives/${filename}`,
  };
}

/** Resolve the on-disk path (+ original name for Content-Disposition) for a
 *  project archive, without reading its bytes. A processing-project zip can
 *  legitimately run into the multi-GB range (masters, intermediate XISF
 *  files, ...) — unlike processed.ts's getProcessedImageFile, this
 *  deliberately does not read the file into a Buffer; the route streams it
 *  with res.download instead. */
export function getProjectArchivePath(id: string): { filePath: string; name: string; mimeType: string } | null {
  const row = stmts.getProjectArchive.get(id);
  if (!row) return null;
  const filePath = resolveArchiveDir(row.objectId, 'project-archives', row.filename);
  if (!fs.existsSync(filePath)) return null;
  return { filePath, name: row.originalName, mimeType: row.mimeType };
}

/** Delete a project archive's record and its file from disk. */
export function deleteProjectArchive(id: string): void {
  const row = stmts.getProjectArchive.get(id);
  if (!row) return;
  const filePath = resolveArchiveDir(row.objectId, 'project-archives', row.filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best-effort */ }
  stmts.deleteProjectArchiveRow.run(id);
}
