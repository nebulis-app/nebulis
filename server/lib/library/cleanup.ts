/**
 * Library cleanup: how much space the removable extras take, and purging them.
 *
 * Only files the app itself copied into the managed library count. A row with a
 * `sourceId` belongs to a linked folder that still lives where the user keeps
 * it, and Nebulis never deletes from those (see the librarySources comment in
 * db.ts), so they are neither measured nor purged here.
 *
 * The libraryFiles table is a record of what was imported, not proof the file is
 * still there (the folder can be emptied or moved outside the app). Sizes count
 * only rows whose file exists on disk; rows whose file is gone are reported as
 * `staleRecords` and dropped by the purge. Callers must first confirm the library
 * is reachable, otherwise an unmounted drive would make every row look stale.
 */
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { probePath, type PathProbe } from '../fsProbe.js';
import { getFolderName } from './objects.js';
import { pinnedLibraryLooksUnmounted } from './analyze.js';
import { deleteLocalFilesByRelPath, refreshObjectFileCount } from './observations.js';
import { deleteLibraryFileRow } from './libraryFiles.js';

export interface SubframeUsage {
  files: number;
  bytes: number;
  objects: number;
  /** Rows recorded as sub-frames whose file no longer exists on disk. */
  staleRecords: number;
  /** Rows whose file could not be checked (a read error, not a missing file). They
   *  are counted in neither `files` nor `staleRecords` and are never purged. */
  unreadable: number;
  /** Biggest consumers first, capped so a huge library stays a small payload. */
  topObjects: Array<{ objectId: string; files: number; bytes: number }>;
}

interface SubRow { objectId: string; relPath: string; bytes: number }

const TOP_OBJECTS = 8;
const STAT_BATCH = 64;

const subRows = () =>
  db
    .prepare<[], SubRow>(
      `SELECT objectId, relPath, bytes FROM libraryFiles WHERE role = 'sub' AND sourceId IS NULL`,
    )
    .all();

/** Split rows by what the disk said. Only a definite "no such file" is stale; a
 *  row whose path could not be checked is left out of both lists and untouched. */
async function partitionByExistence(
  rows: SubRow[],
): Promise<{ present: SubRow[]; stale: SubRow[]; unreadable: number }> {
  const present: SubRow[] = [];
  const stale: SubRow[] = [];
  let unreadable = 0;
  if (rows.length > 0 && await pinnedLibraryLooksUnmounted()) return { present, stale, unreadable: rows.length };
  const root = getLibraryDir();
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results: PathProbe[] = await Promise.all(batch.map(r => probePath(path.join(root, r.relPath))));
    batch.forEach((r, j) => {
      if (results[j] === 'present') present.push(r);
      else if (results[j] === 'missing') stale.push(r);
      else unreadable++;
    });
  }
  return { present, stale, unreadable };
}

export async function getSubframeUsage(): Promise<SubframeUsage> {
  const { present, stale, unreadable } = await partitionByExistence(subRows());
  const perObject = new Map<string, { files: number; bytes: number }>();
  let bytes = 0;
  for (const r of present) {
    bytes += r.bytes;
    const o = perObject.get(r.objectId) ?? { files: 0, bytes: 0 };
    o.files++;
    o.bytes += r.bytes;
    perObject.set(r.objectId, o);
  }
  const topObjects = [...perObject.entries()]
    .map(([objectId, v]) => ({ objectId, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_OBJECTS);
  return { files: present.length, bytes, objects: perObject.size, staleRecords: stale.length, unreadable, topObjects };
}

export interface PurgeResult {
  deleted: number;
  freedBytes: number;
  objects: number;
  /** Records dropped because their file was already gone. */
  staleRemoved: number;
  /** Rows skipped because their file could not be checked. */
  unreadable: number;
}

/**
 * Delete every managed sub-frame (raw FITS) in the library. Stacked images,
 * thumbnails, previews and everything else are left alone. Each object goes
 * through `deleteLocalFilesByRelPath`, which owns containment, the unlink, the
 * row, the file count and the manifest, so the records stay consistent with disk.
 */
export async function purgeAllSubframes(): Promise<PurgeResult> {
  const { present, stale, unreadable } = await partitionByExistence(subRows());

  const byObject = new Map<string, SubRow[]>();
  for (const r of present) {
    const list = byObject.get(r.objectId) ?? [];
    list.push(r);
    byObject.set(r.objectId, list);
  }

  const stillThere = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM libraryFiles WHERE relPath = ?',
  );
  let deleted = 0;
  let freedBytes = 0;
  for (const [objectId, files] of byObject) {
    // Rows store '<folderName>/<file>'; the delete helper wants it object-relative.
    const prefix = `${getFolderName(objectId)}/`;
    const rel = files.filter(f => f.relPath.startsWith(prefix));
    deleted += deleteLocalFilesByRelPath(objectId, rel.map(f => f.relPath.slice(prefix.length))).deleted;
    // The helper drops a row only once its file is gone, so a vanished row is
    // the honest "freed" signal: a file that failed to unlink is not counted.
    for (const f of rel) if (!stillThere.get(f.relPath)?.n) freedBytes += f.bytes;
  }

  const staleObjects = new Set<string>();
  for (const r of stale) {
    deleteLibraryFileRow(r.relPath);
    staleObjects.add(r.objectId);
  }
  for (const id of staleObjects) refreshObjectFileCount(id);

  return { deleted, freedBytes, objects: byObject.size, staleRemoved: stale.length, unreadable };
}
