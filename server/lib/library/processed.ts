/**
 * Library — processed-image domain.
 *
 * User-uploaded post-processing results stored under `<objectFolder>/processed/`
 * with a row per file in `sessionProcessedImages`.
 */
import fs from 'fs';
import path from 'path';
import { getLibraryDir } from '../libraryPath.js';
import {
  stmts,
  getFolderName,
  LIBRARY_API_BASE,
} from './objects.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProcessedImageRecord {
  id: string;
  objectId: string;
  date: string;
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
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** List all processed images for a session, newest first. */
export function getProcessedImages(objectId: string, date: string): ProcessedImageRecord[] {
  const folderName = getFolderName(objectId);
  const rows = stmts.getProcessedImages.all(objectId, date);
  return rows.map(r => ({
    ...r,
    url: `${LIBRARY_API_BASE}/processed-images/${r.id}`,
    path: `${folderName}/processed/${r.filename}`,
  }));
}

/** List all processed images for an object across all sessions, newest first. */
export function getAllProcessedImagesForObject(objectId: string): ProcessedImageRecord[] {
  const folderName = getFolderName(objectId);
  const rows = stmts.getAllProcessedImagesForObject.all(objectId);
  return rows.map(r => ({
    ...r,
    url: `${LIBRARY_API_BASE}/processed-images/${r.id}`,
    path: `${folderName}/processed/${r.filename}`,
  }));
}

/** Get a single processed image record by id (null if not found). */
export function getProcessedImageRecord(id: string): ProcessedImageRecord | null {
  const row = stmts.getProcessedImage.get(id);
  if (!row) return null;
  const folderName = getFolderName(row.objectId);
  return {
    ...row,
    url: `${LIBRARY_API_BASE}/processed-images/${row.id}`,
    path: `${folderName}/processed/${row.filename}`,
  };
}

/** Save an uploaded processed image to disk and record it in the DB. */
export function addProcessedImage(
  objectId: string,
  date: string,
  sourcePath: string,
  originalName: string,
  mimeType: string,
  title: string,
  notes: string,
): ProcessedImageRecord {
  const LIBRARY_DIR = getLibraryDir();
  const id = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ext = originalName.split('.').pop()?.toLowerCase() || 'jpg';
  const filename = `${id}.${ext}`;

  const processedDir = path.join(LIBRARY_DIR, getFolderName(objectId), 'processed');
  if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

  const destPath = path.join(processedDir, filename);
  const size = fs.statSync(sourcePath).size;
  try {
    fs.renameSync(sourcePath, destPath);
  } catch (renameErr) {
    if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.copyFileSync(sourcePath, destPath);
      fs.unlinkSync(sourcePath);
    } else {
      throw renameErr;
    }
  }

  const uploadedAt = new Date().toISOString();
  stmts.insertProcessedImage.run(id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt);

  const folderName = getFolderName(objectId);
  return {
    id, objectId, date, filename, originalName, title, notes,
    size, mimeType, uploadedAt,
    url: `${LIBRARY_API_BASE}/processed-images/${id}`,
    path: `${folderName}/processed/${filename}`,
  };
}

/** Get the file data for a processed image (null if not found). */
export function getProcessedImageFile(id: string): { data: Buffer; name: string; mimeType: string } | null {
  const LIBRARY_DIR = getLibraryDir();
  const row = stmts.getProcessedImage.get(id);
  if (!row) return null;
  const filePath = path.join(LIBRARY_DIR, getFolderName(row.objectId), 'processed', row.filename);
  if (!fs.existsSync(filePath)) return null;
  return { data: fs.readFileSync(filePath), name: row.originalName, mimeType: row.mimeType };
}

/** Delete a processed image record and its file from disk. */
export function deleteProcessedImage(id: string): void {
  const LIBRARY_DIR = getLibraryDir();
  const row = stmts.getProcessedImage.get(id);
  if (!row) return;
  const filePath = path.join(LIBRARY_DIR, getFolderName(row.objectId), 'processed', row.filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best-effort */ }
  stmts.deleteProcessedImageRow.run(id);
}
