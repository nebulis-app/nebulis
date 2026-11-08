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
 * DIFFERENT session folders, and resolve to the same observing night, where at
 * least one of the folders is a generated date-style one. The night requirement
 * stops sessions on different nights that produce an identically named file
 * (`shotsInfo.json`) from being merged; the generated-folder requirement stops
 * two device-named sessions on one night (a 60 s and a 120 s run of the same
 * target, both writing a same-size `img_stacked_all.tif`) from pairing up. The scan only reads the database; it never opens a file.
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

/** A folder the migration or importer named from a date, as opposed to one that mirrors a device folder. */
function isGeneratedFolder(folder: string): boolean {
  return !folder || folder === UNSORTED || DATE_FOLDER_RE.test(folder);
}

/** Lower is better: a device-named folder beats a date-named one, then the older import wins. */
function keeperRank(row: LibraryFileRow): [number, string] {
  return [isGeneratedFolder(sessionFolderOf(row.relPath)) ? 1 : 0, row.importedAt];
}

function compareRank(a: LibraryFileRow, b: LibraryFileRow): number {
  const [ag, ai] = keeperRank(a);
  const [bg, bi] = keeperRank(b);
  return ag - bg || (ai < bi ? -1 : ai > bi ? 1 : 0);
}

/** Database-only candidates: same night, name and size in different folders. Not yet checked against the bytes. */
function findDuplicateCandidates(): DuplicateScan {
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
      const dupeFolder = sessionFolderOf(dupe.relPath);
      if (dupeFolder === keeperFolder) continue;
      // Two device-named folders are two real sessions, even on one night. Same-size files (an uncompressed
      // stacked TIFF from one sensor) would otherwise pair up: a 60 s and a 120 s run both write img_stacked_all.tif.
      if (!isGeneratedFolder(keeperFolder) && !isGeneratedFolder(dupeFolder)) continue;
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

const SAMPLE_BYTES = 64 * 1024;
const VERIFY_CONCURRENCY = 8;

/** Compare the start, middle and end of two files of equal size. A cheap stand-in for reading both whole:
 *  same-sized files that really differ (two sessions' stacked TIFFs) almost always differ in one of these,
 *  because FITS headers carry timestamps and pixel data is noisy. The repair still compares every byte. */
async function samplesMatch(aPath: string, bPath: string, size: number): Promise<boolean> {
  const offsets = [0, Math.max(0, Math.floor(size / 2) - SAMPLE_BYTES / 2), Math.max(0, size - SAMPLE_BYTES)];
  const a = await fs.promises.open(aPath, 'r');
  try {
    const b = await fs.promises.open(bPath, 'r');
    try {
      const bufA = Buffer.allocUnsafe(SAMPLE_BYTES);
      const bufB = Buffer.allocUnsafe(SAMPLE_BYTES);
      for (const offset of offsets) {
        const want = Math.min(SAMPLE_BYTES, size - offset);
        if (want <= 0) continue;
        const [ra, rb] = await Promise.all([a.read(bufA, 0, want, offset), b.read(bufB, 0, want, offset)]);
        if (ra.bytesRead !== rb.bytesRead || !bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) return false;
      }
      return true;
    } finally { await b.close(); }
  } finally { await a.close(); }
}

/** True when both files exist, are separate files of the stated size, and agree on every sample. A pair that
 *  cannot be read is left out: the page must only offer what the repair could act on. */
async function looksIdentical(pair: DuplicatePair, libraryDir: string): Promise<boolean> {
  try {
    const keepAbs = path.join(libraryDir, pair.keep);
    const removeAbs = path.join(libraryDir, pair.remove);
    const [k, r] = await Promise.all([fs.promises.stat(keepAbs), fs.promises.stat(removeAbs)]);
    if (k.size !== r.size || (k.dev === r.dev && k.ino === r.ino)) return false;
    return await samplesMatch(keepAbs, removeAbs, k.size);
  } catch {
    return false;
  }
}

/**
 * Candidates from the database, then confirmed against the files so the list shows real duplicates and
 * not merely same-named, same-sized neighbours. Reads at most three small samples per file.
 */
export async function findDuplicateSessionFiles(): Promise<DuplicateScan> {
  const candidates = findDuplicateCandidates();
  const libraryDir = getLibraryDir();
  const kept: DuplicatePair[] = [];
  for (let i = 0; i < candidates.pairs.length; i += VERIFY_CONCURRENCY) {
    const batch = candidates.pairs.slice(i, i + VERIFY_CONCURRENCY);
    const ok = await Promise.all(batch.map(pair => looksIdentical(pair, libraryDir)));
    batch.forEach((pair, j) => { if (ok[j]) kept.push(pair); });
  }
  return {
    count: kept.length,
    objects: new Set(kept.map(p => p.objectId)).size,
    bytes: kept.reduce((sum, p) => sum + p.bytes, 0),
    pairs: kept,
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

/** Most pairs returned to the page and written to the log in one listing. */
export const DUPLICATE_LIST_CAP = 500;

export interface DuplicateListing extends Omit<DuplicateScan, 'pairs'> {
  pairs: DuplicatePair[];
  /** True when `count` exceeds what `pairs` carries. */
  truncated: boolean;
}

/**
 * The pairs a repair would act on, for the Library health page, and the same list
 * written to the server log so a user can send it in. One summary line, then one
 * line per pair, capped at DUPLICATE_LIST_CAP. Read-only: nothing is touched.
 */
export async function listAndLogDuplicates(): Promise<DuplicateListing> {
  const scan = await findDuplicateSessionFiles();
  const pairs = scan.pairs.slice(0, DUPLICATE_LIST_CAP);
  const truncated = scan.count > pairs.length;
  log.info(
    { count: scan.count, objects: scan.objects, bytes: scan.bytes, listed: pairs.length, truncated },
    '[duplicates] listing duplicate files',
  );
  for (const pair of pairs) {
    log.info({ objectId: pair.objectId, keep: pair.keep, remove: pair.remove, bytes: pair.bytes }, '[duplicates] pair');
  }
  return { count: scan.count, objects: scan.objects, bytes: scan.bytes, pairs, truncated };
}

export async function fixDuplicateSessionFiles(): Promise<DuplicateRepair> {
  const { pairs } = await findDuplicateSessionFiles();
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
