/**
 * Duplicate-session cleanup: the same capture stored twice under one object.
 *
 * ── How it happens ──────────────────────────────────────────────────────────
 *
 * The flat→nested migration used to file everything under a folder named for the
 * observing night (`C6/2026-09-15/`). A later sync of the same session then
 * created the device's own folder (`C6/DWARF_RAW_TELE_C 6_.../`) and, finding
 * nothing at that path, downloaded every file again.
 *
 * ── What counts as a duplicate ──────────────────────────────────────────────
 *
 * Two managed rows of one object that share a file name and byte size, sit in
 * DIFFERENT session folders, and resolve to the same observing night. The night
 * requirement stops two genuinely separate sessions that happen to produce an
 * identically named, identically sized file (`shotsInfo.json`) from being
 * merged. The scan only reads the database; it never opens a file.
 *
 * ── What the repair does ────────────────────────────────────────────────────
 *
 * It keeps the copy in the device-named folder (the one a fresh import would
 * have made, so future syncs agree with it) and removes the other, but only
 * after a byte-for-byte comparison proves the two are identical. A pair that
 * differs, or whose keeper is missing from disk, is left alone. Every stored
 * reference to the removed path (session hero, gallery image, favorites) is
 * repointed at the survivor so nothing silently loses its picture. Session
 * folders left holding only bookkeeping are removed.
 *
 * Linked-source rows (`sourceId` set) are the user's own folders and are never
 * examined.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { log } from '../logger.js';
import {
  deleteLibraryFileRow,
  objectRelativePath,
  sessionDateForRow,
  writeObjectManifest,
  type LibraryFileRow,
} from './libraryFiles.js';
import { classifyExistingCopy } from './existingCopy.js';
import { rewritePathReferences } from './libraryRenest.js';
import { refreshObjectFileCount } from './observations.js';

/** Folder names the importer and migration generate from a date alone. A copy in
 *  one of these loses to a copy in a device-named folder. */
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}(_\d{2}-\d{2}-\d{2})?$/;
const UNSORTED = 'unsorted';

export interface DuplicatePair {
  objectId: string;
  keep: string;
  remove: string;
  bytes: number;
}

export interface DuplicateScan {
  /** Candidate pairs. The repair re-checks the bytes, so this can slightly overcount. */
  count: number;
  objects: number;
  bytes: number;
  pairs: DuplicatePair[];
}

export interface DuplicateRepair {
  removed: number;
  freedBytes: number;
  /** Candidates left in place: bytes differed, or a file was missing. */
  skipped: number;
}

function sessionFolderOf(relPath: string): string {
  const rel = objectRelativePath(relPath);
  const slash = rel.indexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '';
}

/** Lower is better: a device-named folder beats a date-named one, then the older import wins. */
function keeperRank(row: LibraryFileRow): [number, string] {
  const folder = sessionFolderOf(row.relPath);
  const generated = !folder || folder === UNSORTED || DATE_FOLDER_RE.test(folder);
  return [generated ? 1 : 0, row.importedAt];
}

function compareRank(a: LibraryFileRow, b: LibraryFileRow): number {
  const [ag, ai] = keeperRank(a);
  const [bg, bi] = keeperRank(b);
  return ag - bg || (ai < bi ? -1 : ai > bi ? 1 : 0);
}

export function findDuplicateSessionFiles(): DuplicateScan {
  const rows = db.prepare<[], LibraryFileRow>(
    'SELECT * FROM libraryFiles WHERE sourceId IS NULL AND bytes > 0',
  ).all();

  const groups = new Map<string, LibraryFileRow[]>();
  for (const row of rows) {
    const folder = sessionFolderOf(row.relPath);
    if (!folder) continue;
    const night = sessionDateForRow(row);
    if (!night) continue;
    const key = `${row.objectId}\u0000${night}\u0000${row.fileName}\u0000${row.bytes}`;
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }

  const pairs: DuplicatePair[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(compareRank);
    const keeper = list[0];
    const keeperFolder = sessionFolderOf(keeper.relPath);
    for (const dupe of list.slice(1)) {
      if (sessionFolderOf(dupe.relPath) === keeperFolder) continue;
      pairs.push({ objectId: dupe.objectId, keep: keeper.relPath, remove: dupe.relPath, bytes: dupe.bytes });
    }
  }

  return {
    count: pairs.length,
    objects: new Set(pairs.map(p => p.objectId)).size,
    bytes: pairs.reduce((sum, p) => sum + p.bytes, 0),
    pairs,
  };
}

/** Remove a session folder that holds nothing but dot-prefixed bookkeeping (`.thumbs`). */
function pruneSessionFolder(objectDir: string, sessionFolder: string): void {
  if (!sessionFolder) return;
  const dir = path.join(objectDir, sessionFolder);
  try {
    const left = fs.readdirSync(dir);
    if (left.every(name => name.startsWith('.'))) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* gone already, or not ours to remove */ }
}

export async function fixDuplicateSessionFiles(): Promise<DuplicateRepair> {
  const { pairs } = findDuplicateSessionFiles();
  const libraryDir = getLibraryDir();
  const result: DuplicateRepair = { removed: 0, freedBytes: 0, skipped: 0 };
  const touchedObjects = new Map<string, string>();
  const touchedFolders = new Set<string>();

  for (const pair of pairs) {
    const keepAbs = path.join(libraryDir, pair.keep);
    const removeAbs = path.join(libraryDir, pair.remove);
    try {
      // Two paths that are one physical file (case-insensitive folder names, hard links, symlinks) are
      // trivially "identical", and unlinking one would delete the only copy.
      const keepStat = fs.statSync(keepAbs);
      const removeStat = fs.statSync(removeAbs);
      if (keepStat.dev === removeStat.dev && keepStat.ino === removeStat.ino) { result.skipped++; continue; }
      // Only 'identical' is safe to delete. 'partial' or 'different' means these are not the same file.
      if (await classifyExistingCopy(keepAbs, removeAbs) !== 'identical') { result.skipped++; continue; }
      fs.unlinkSync(removeAbs);
    } catch (err) {
      result.skipped++;
      log.warn({ pair, err: err instanceof Error ? err.message : String(err) }, '[duplicates] left in place');
      continue;
    }
    db.transaction(() => {
      // Row first: rewritePathReferences also renames libraryFiles rows, which
      // would collide with the keeper's unique relPath.
      deleteLibraryFileRow(pair.remove);
      rewritePathReferences(pair.objectId, pair.remove, pair.keep);
    })();
    result.removed++;
    result.freedBytes += pair.bytes;
    const folderName = pair.remove.slice(0, pair.remove.indexOf('/'));
    touchedObjects.set(pair.objectId, folderName);
    touchedFolders.add(`${folderName}\u0000${sessionFolderOf(pair.remove)}`);
  }

  for (const key of touchedFolders) {
    const [folderName, sessionFolder] = key.split('\u0000');
    pruneSessionFolder(path.join(libraryDir, folderName), sessionFolder);
  }
  for (const [objectId, folderName] of touchedObjects) {
    refreshObjectFileCount(objectId);
    try { writeObjectManifest(objectId, folderName); } catch { /* manifest is rebuilt on the next import */ }
  }
  return result;
}
