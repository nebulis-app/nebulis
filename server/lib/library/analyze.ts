/**
 * Library analysis: find records that no longer match what is on disk.
 *
 * Read-only by default. `analyzeLibrary` only reports; each `fix*` function
 * repairs exactly one category, so the user decides what to touch. The fixes drop
 * records that point at nothing, retire objects whose folder is gone (into the
 * existing trash, so restorable), correct the stored flat/nested flag, and, for
 * duplicate session files only, delete the second copy of a file once its bytes
 * are proven identical to the first (see duplicateSessions.ts).
 *
 * Callers must confirm the library is reachable first. An unmounted drive makes
 * every file look missing, and "fixing" that would wipe good records.
 * Rows belonging to linked folders (`sourceId` set) are never examined.
 *
 * "Missing" means a definite ENOENT and nothing else. A read error (permissions,
 * an I/O fault, a share that dropped mid-check) is `unreadable`: it is never
 * listed as stale, never repaired, and any unreadable path makes the repair
 * refuse to run, because it cannot tell which of its findings to trust.
 */
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { probePath } from '../fsProbe.js';
import { findLayoutDrift, reconcileLayoutFromDisk } from './libraryLayout.js';
import { countFlatObjects } from './libraryRenest.js';
import { findDuplicateSessionFiles, fixDuplicateSessionFiles, type DuplicateRepair } from './duplicateSessions.js';
import { deleteLibraryFileRow } from './libraryFiles.js';
import { refreshObjectFileCount } from './observations.js';
import { invalidateAllImagesCache } from './gallery.js';
import { deleteProcessedImage } from './processed.js';

export interface MissingObject {
  objectId: string;
  folderName: string;
  /** File records still attached. They are stale by definition: the folder is gone. */
  fileRecords: number;
}

export interface LibraryAnalysis {
  staleRecords: { count: number; objects: number };
  missingObjects: MissingObject[];
  /** Exact total; `missingObjects` is capped. */
  missingObjectCount: number;
  layoutDrift: number;
  flatObjects: number;
  /** The same capture stored in two session folders of one object. */
  duplicateFiles: { count: number; objects: number; bytes: number };
  /** Processed-image records (the Gallery's "Processed" cards) whose file is gone. */
  missingProcessed: { count: number; objects: number };
  /** Paths that could not be checked, so are excluded from every count above. A
   *  non-zero value means a repair will refuse until it is resolved. */
  unreadable: number;
  ranAt: string;
}

/** Thrown by a repair when some paths could not be checked. */
export class LibraryUnreadableError extends Error {
  constructor(public readonly unreadable: number) {
    super(`Could not check ${unreadable} path${unreadable === 1 ? '' : 's'}, so nothing was repaired.`);
    this.name = 'LibraryUnreadableError';
  }
}

const STAT_BATCH = 64;
/** Cap the object list in the payload; the count is still exact. */
const MISSING_OBJECT_LIST_CAP = 50;

interface FileRow { objectId: string; relPath: string }

async function findStaleRows(): Promise<{ stale: FileRow[]; unreadable: number }> {
  const rows = db
    .prepare<[], FileRow>('SELECT objectId, relPath FROM libraryFiles WHERE sourceId IS NULL')
    .all();
  const root = getLibraryDir();
  const stale: FileRow[] = [];
  let unreadable = 0;
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results = await Promise.all(batch.map(r => probePath(path.join(root, r.relPath))));
    batch.forEach((r, j) => {
      if (results[j] === 'missing') stale.push(r);
      else if (results[j] === 'error') unreadable++;
    });
  }
  return { stale, unreadable };
}

/** Live objects with no linked-folder files whose folder is not on disk.
 *  Only objects that once held files qualify: an object with no records and no file
 *  count never had a folder to lose, so its absence proves nothing. */
async function findMissingObjects(): Promise<{ missing: MissingObject[]; unreadable: number }> {
  const root = getLibraryDir();
  const objs = db
    .prepare<[], { objectId: string; folderName: string; fileRecords: number }>(
      `SELECT o.objectId, o.folderName,
              (SELECT COUNT(*) FROM libraryFiles f WHERE f.objectId = o.objectId) AS fileRecords
       FROM libraryObjects o
       WHERE o.deleted = 0
         AND NOT EXISTS (SELECT 1 FROM libraryFiles f WHERE f.objectId = o.objectId AND f.sourceId IS NOT NULL)
         AND (o.fileCount > 0 OR EXISTS (SELECT 1 FROM libraryFiles f WHERE f.objectId = o.objectId))`,
    )
    .all();
  const missing: MissingObject[] = [];
  let unreadable = 0;
  for (let i = 0; i < objs.length; i += STAT_BATCH) {
    const batch = objs.slice(i, i + STAT_BATCH);
    const results = await Promise.all(batch.map(o => probePath(path.join(root, o.folderName || o.objectId))));
    batch.forEach((o, j) => {
      if (results[j] === 'missing') missing.push(o);
      else if (results[j] === 'error') unreadable++;
    });
  }
  return { missing, unreadable };
}

interface ProcessedRow { id: string; objectId: string; filename: string; folderName: string | null }

/** Processed-image records whose file is no longer under `<object>/processed/`.
 *  They still render as Gallery cards, but with nothing behind them to open. */
async function findMissingProcessed(): Promise<{ missing: ProcessedRow[]; unreadable: number }> {
  const rows = db
    .prepare<[], ProcessedRow>(
      `SELECT p.id, p.objectId, p.filename, o.folderName
       FROM sessionProcessedImages p LEFT JOIN libraryObjects o ON o.objectId = p.objectId`,
    )
    .all();
  const root = getLibraryDir();
  const missing: ProcessedRow[] = [];
  let unreadable = 0;
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results = await Promise.all(
      batch.map(r => probePath(path.join(root, r.folderName || r.objectId, 'processed', r.filename))),
    );
    batch.forEach((r, j) => {
      if (results[j] === 'missing') missing.push(r);
      else if (results[j] === 'error') unreadable++;
    });
  }
  return { missing, unreadable };
}

export async function analyzeLibrary(): Promise<LibraryAnalysis> {
  const [staleResult, missingResult, processedResult] = await Promise.all([
    findStaleRows(), findMissingObjects(), findMissingProcessed(),
  ]);
  const { stale } = staleResult;
  const { missing } = missingResult;
  return {
    staleRecords: { count: stale.length, objects: new Set(stale.map(r => r.objectId)).size },
    missingObjects: missing.slice(0, MISSING_OBJECT_LIST_CAP),
    missingObjectCount: missing.length,
    layoutDrift: findLayoutDrift().length,
    flatObjects: countFlatObjects(),
    duplicateFiles: (({ count, objects, bytes }) => ({ count, objects, bytes }))(findDuplicateSessionFiles()),
    missingProcessed: {
      count: processedResult.missing.length,
      objects: new Set(processedResult.missing.map(r => r.objectId)).size,
    },
    unreadable: staleResult.unreadable + missingResult.unreadable + processedResult.unreadable,
    ranAt: new Date().toISOString(),
  };
}

/** Drop every file record whose file is gone. */
export async function fixStaleRecords(): Promise<{ removed: number }> {
  const { stale, unreadable } = await findStaleRows();
  if (unreadable > 0) throw new LibraryUnreadableError(unreadable);
  const touched = new Set<string>();
  db.transaction(() => {
    for (const r of stale) { deleteLibraryFileRow(r.relPath); touched.add(r.objectId); }
  })();
  for (const id of touched) refreshObjectFileCount(id);
  return { removed: stale.length };
}

/** Drop processed-image records whose file is gone. */
export async function fixMissingProcessed(): Promise<{ removed: number }> {
  const { missing, unreadable } = await findMissingProcessed();
  if (unreadable > 0) throw new LibraryUnreadableError(unreadable);
  db.transaction(() => {
    for (const r of missing) deleteProcessedImage(r.id);
  })();
  invalidateAllImagesCache();
  return { removed: missing.length };
}

/** Move objects whose folder is gone to the trash. Restorable from there, and
 *  notes, plans and observations attached to them are left intact. */
export async function fixMissingObjects(): Promise<{ retired: number }> {
  const { missing, unreadable } = await findMissingObjects();
  if (unreadable > 0) throw new LibraryUnreadableError(unreadable);
  const now = new Date().toISOString();
  const retire = db.prepare('UPDATE libraryObjects SET deleted = 1, deletedAt = ? WHERE objectId = ?');
  const dropRows = db.prepare('DELETE FROM libraryFiles WHERE objectId = ? AND sourceId IS NULL');
  db.transaction(() => {
    for (const o of missing) { dropRows.run(o.objectId); retire.run(now, o.objectId); }
  })();
  return { retired: missing.length };
}

export function fixLayoutDrift(): { fixed: number } {
  return { fixed: reconcileLayoutFromDisk() };
}

/** Delete the second copy of each file stored twice, after verifying the bytes match. */
export function fixDuplicateFiles(): Promise<DuplicateRepair> {
  return fixDuplicateSessionFiles();
}
