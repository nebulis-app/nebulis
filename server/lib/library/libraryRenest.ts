/**
 * Re-nesting migration: convert a flat library object to the per-session layout.
 *
 * ── What it does and does not do ────────────────────────────────────────────
 *
 * It MOVES files into per-session directories. It does NOT rename them back to
 * what the device originally called them, because for a legacy object that
 * information no longer exists — the flat importer rewrote the name on the way
 * in and nothing recorded the original. `libraryFiles.originalName` for those
 * files honestly equals the on-disk name. Only a fresh import from the device
 * recovers true original names. Nesting is still worth doing on its own: it is
 * what makes future imports into this object keep their names, and it turns
 * session delete and move into directory operations.
 *
 * ── Why the folders are named by night here, not by source folder ───────────
 *
 * A nested *import* mirrors the device's session directory, which is unique and
 * carries exposure/gain. A migration has no such directory to copy: the files
 * have been sitting in one flat folder, and their only surviving grouping is
 * the observing night. So a migrated object gets one directory per night.
 *
 * That is collision-free by construction — the files already coexisted in a
 * single flat directory, so their names are necessarily unique within the
 * object, and partitioning them into subdirectories cannot introduce a clash.
 *
 * A later import into a migrated object will add device-named directories
 * beside the night-named ones. That is fine and deliberate: a session folder is
 * only a unique container, and `getLocalSessions` derives the night from the
 * per-file rows rather than from the directory name, so two differently-named
 * folders covering one night still read as one session. (`nestedLayout.test.ts`
 * covers exactly that case for two same-night source folders.)
 *
 * ── Safety model ────────────────────────────────────────────────────────────
 *
 * A filesystem move and a database update cannot be made atomic, so the order
 * is: move the file, then update its row. A crash therefore leaves a file in
 * its new place with a row still naming the old one, which the next run repairs
 * (`reconcileMovedRow`) rather than re-moving. The whole thing is idempotent and
 * safe to re-run. Nothing is deleted: on any failure the object keeps whatever
 * files it has and stays marked `flat`, which is a shape every read path still
 * understands.
 *
 * Four columns store library-relative paths and every one of them silently
 * breaks if a move does not rewrite it — a missing hero image with no error is
 * the failure mode. They are rewritten in the same transaction as the row:
 *   libraryFiles.relPath, librarySessions.sessionImage,
 *   libraryObjects.galleryImage, imageFavorites.imagePath
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { isErrnoException } from '../errors.js';
import { log } from '../logger.js';
import { isRealFile } from '../telescopeFiles.js';
import {
  getLibraryFilesForObject,
  getLibraryFileRow,
  sessionDateForRow,
  objectRelativePath,
  writeObjectManifest,
  recordLibraryFile,
  roleForFile,
  type LibraryFileRow,
} from './libraryFiles.js';
import {
  getObjectLayout,
  setObjectLayout,
  listObjectFiles,
  sanitizeSessionFolder,
} from './libraryLayout.js';
import { claimImportLock, releaseImportLock } from './import.js';

/** Directory legacy files with no derivable night are grouped into. They would
 *  otherwise have to stay at object level, where they read as "belongs to the
 *  object but to no session" — true, but invisible next to nested siblings. */
export const UNSORTED_DIR = 'unsorted';
const RENEST_BUSY_ERROR = 'Import, sync, or another copy operation is already running.';
const COMPARE_CHUNK_BYTES = 1024 * 1024;

export interface RenestObjectResult {
  objectId: string;
  moved: number;
  skipped: number;
  alreadyNested: boolean;
  error?: string;
}

export interface RenestSummary {
  objects: number;
  moved: number;
  failed: number;
  results: RenestObjectResult[];
}

/**
 * Rewrite every stored reference to a library-relative path.
 *
 * Statements are prepared on first use, not at module load. `sessionImage` is
 * added to `librarySessions` by a lazy column migration in objects.ts, so
 * preparing eagerly here would bind this module to an import-order the rest of
 * the codebase does not guarantee (and did in fact break).
 *
 * `imageFavorites.imagePath` is the primary key of its table, so a row already
 * sitting at the destination (a re-run that got halfway) would collide; the
 * delete-then-update handles that instead of throwing.
 */
function rewritePathReferences(objectId: string, fromRel: string, toRel: string): void {
  db.prepare('UPDATE libraryFiles SET relPath = ? WHERE relPath = ?')
    .run(toRel, fromRel);
  db.prepare('UPDATE librarySessions SET sessionImage = ? WHERE objectId = ? AND sessionImage = ?')
    .run(toRel, objectId, fromRel);
  db.prepare('UPDATE libraryObjects SET galleryImage = ? WHERE objectId = ? AND galleryImage = ?')
    .run(toRel, objectId, fromRel);
  db.prepare('DELETE FROM imageFavorites WHERE imagePath = ? AND EXISTS (SELECT 1 FROM imageFavorites WHERE imagePath = ?)')
    .run(fromRel, toRel);
  db.prepare('UPDATE imageFavorites SET imagePath = ? WHERE imagePath = ?')
    .run(toRel, fromRel);
}

/** Session directory a legacy flat file belongs in: its observing night, or
 *  the unsorted bucket when it has none (no row, or a row with no date). */
function targetDirFor(row: LibraryFileRow | undefined): string {
  const night = row ? sessionDateForRow(row) : null;
  if (!night) return UNSORTED_DIR;
  return sanitizeSessionFolder(night) ?? UNSORTED_DIR;
}

/**
 * Repair a row whose file is already at the destination but whose path still
 * points at the source — the exact state a crash between the move and the
 * update leaves behind. Returns true when it repaired something.
 */
function reconcileMovedRow(objectId: string, fromRel: string, toRel: string): boolean {
  const fromAbs = path.join(getLibraryDir(), fromRel);
  const toAbs = path.join(getLibraryDir(), toRel);
  if (fs.existsSync(fromAbs) || !fs.existsSync(toAbs)) return false;
  rewritePathReferences(objectId, fromRel, toRel);
  return true;
}

function finishExdevMove(srcAbs: string, destAbs: string): void {
  fs.copyFileSync(srcAbs, destAbs);
  fs.unlinkSync(srcAbs);
  if (fs.existsSync(srcAbs)) {
    throw new Error('Cross-device move copied the file but could not remove the source');
  }
}

function filesEqualSync(a: string, b: string, size: number): boolean {
  const aFd = fs.openSync(a, 'r');
  const bFd = fs.openSync(b, 'r');
  const aBuf = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK_BYTES, Math.max(size, 1)));
  const bBuf = Buffer.allocUnsafe(aBuf.length);
  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(aBuf.length, size - offset);
      const aRead = fs.readSync(aFd, aBuf, 0, length, offset);
      const bRead = fs.readSync(bFd, bBuf, 0, length, offset);
      if (aRead <= 0 || bRead <= 0) return false;
      if (aRead !== bRead) return false;
      if (!aBuf.subarray(0, aRead).equals(bBuf.subarray(0, bRead))) return false;
      offset += aRead;
    }
    return true;
  } finally {
    fs.closeSync(aFd);
    fs.closeSync(bFd);
  }
}

function cleanupDuplicateSource(objectId: string, fromRel: string, toRel: string): number | null {
  const fromAbs = path.join(getLibraryDir(), fromRel);
  const toAbs = path.join(getLibraryDir(), toRel);
  if (!fs.existsSync(fromAbs) || !fs.existsSync(toAbs)) return null;
  const fromStat = fs.statSync(fromAbs);
  const toStat = fs.statSync(toAbs);
  if (!fromStat.isFile() || !toStat.isFile() || fromStat.size !== toStat.size) return null;
  if (!filesEqualSync(fromAbs, toAbs, fromStat.size)) return null;
  fs.unlinkSync(fromAbs);
  rewritePathReferences(objectId, fromRel, toRel);
  return fromStat.size;
}

/**
 * Convert one object to the nested layout. Idempotent: an object already marked
 * nested is returned untouched, and a partially-migrated one is finished.
 */
export function renestObject(objectId: string): RenestObjectResult {
  if (!claimImportLock()) {
    return { objectId, moved: 0, skipped: 0, alreadyNested: false, error: RENEST_BUSY_ERROR };
  }
  try {
    return renestObjectUnlocked(objectId);
  } finally {
    releaseImportLock();
  }
}

function renestObjectUnlocked(objectId: string): RenestObjectResult {
  const result: RenestObjectResult = { objectId, moved: 0, skipped: 0, alreadyNested: false };

  if (getObjectLayout(objectId) === 'nested') {
    result.alreadyNested = true;
    return result;
  }

  const folderRow = db.prepare<[string], { folderName: string }>(
    'SELECT folderName FROM libraryObjects WHERE objectId = ?',
  ).get(objectId);
  if (!folderRow) {
    result.error = 'No such library object';
    return result;
  }
  const folderName = folderRow.folderName;
  const libraryDir = getLibraryDir();
  const objDir = path.join(libraryDir, folderName);
  if (!fs.existsSync(objDir)) {
    // Nothing on disk to move. Marking it nested is still correct — it is the
    // shape anything imported into it from here on will use.
    setObjectLayout(objectId, 'nested');
    return result;
  }

  const rowsByRel = new Map<string, LibraryFileRow>();
  for (const row of getLibraryFilesForObject(objectId)) {
    rowsByRel.set(objectRelativePath(row.relPath), row);
  }

  // Count and total bytes before, so the move can be verified rather than
  // assumed. Mirrors the check libraryMigration.ts does for a relocation.
  //
  // Listed as 'nested' deliberately, even though the object is still flat: that
  // walk returns BOTH object-level files and anything already sitting in a
  // session directory. A run resuming after a crash finds some files already
  // moved, and a before-count that only saw object level would not balance
  // against the after-count and would fail verification on a healthy library.
  const before = listObjectFiles(objDir, 'nested').filter(e => isRealFile(e.fileName));
  const bytesBefore = before.reduce((sum, e) => {
    try { return sum + fs.statSync(path.join(objDir, e.relPath)).size; } catch { return sum; }
  }, 0);

  // Recovery pass: a row still naming an object-level path whose file is
  // already in its session directory is the fingerprint of a crash between the
  // rename and the row update. Driven by rows rather than by the directory
  // listing, because in that state there is no object-level file left to find.
  for (const row of getLibraryFilesForObject(objectId)) {
    const rel = objectRelativePath(row.relPath);
    if (rel.includes('/')) continue; // already nested
    const toLibRel = `${folderName}/${targetDirFor(row)}/${row.fileName}`;
    if (reconcileMovedRow(objectId, row.relPath, toLibRel)) result.moved++;
  }

  // Only object-level files need moving; anything already nested is done.
  let cleanedDuplicates = 0;
  let cleanedDuplicateBytes = 0;
  for (const entry of before.filter(e => e.sessionFolder === null)) {
    const row = rowsByRel.get(entry.relPath);
    const dir = targetDirFor(row);
    const destRel = `${dir}/${entry.fileName}`;
    const fromLibRel = `${folderName}/${entry.relPath}`;
    const toLibRel = `${folderName}/${destRel}`;
    const srcAbs = path.join(objDir, entry.relPath);
    const destAbs = path.join(objDir, destRel);

    try {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      if (fs.existsSync(destAbs)) {
        const cleanedBytes = cleanupDuplicateSource(objectId, fromLibRel, toLibRel);
        if (cleanedBytes !== null) {
          cleanedDuplicates++;
          cleanedDuplicateBytes += cleanedBytes;
          result.moved++;
          continue;
        }
        // Should not happen (flat names are unique within an object), but if it
        // does, refuse rather than overwrite someone's data.
        result.skipped++;
        log.warn({ objectId, file: entry.relPath }, '[renest] destination already exists, skipped');
        continue;
      }
      try {
        fs.renameSync(srcAbs, destAbs);
      } catch (err) {
        if (isErrnoException(err) && err.code === 'EXDEV') {
          finishExdevMove(srcAbs, destAbs);
        } else {
          throw err;
        }
      }
      // File is in its new place; now make every stored reference agree.
      db.transaction(() => rewritePathReferences(objectId, fromLibRel, toLibRel))();
      // A file with no row (dropped in by hand, or predating the table) gets
      // one now rather than being left unrecorded in a nested object.
      if (!row) {
        recordLibraryFile({
          objectId,
          folderName,
          sessionFolder: dir,
          fileName: entry.fileName,
          originalName: entry.fileName,
          role: roleForFile(entry.fileName),
          bytes: (() => { try { return fs.statSync(destAbs).size; } catch { return 0; } })(),
        });
      }
      result.moved++;
    } catch (err) {
      result.skipped++;
      log.warn(
        { objectId, file: entry.relPath, err: err instanceof Error ? err.message : String(err) },
        '[renest] move failed',
      );
    }
  }

  // Verify before flipping the layout. If anything is unaccounted for, leave
  // the object marked flat: a flat reader over a half-nested folder still shows
  // whatever stayed at object level, whereas claiming nested would hide it.
  const after = listObjectFiles(objDir, 'nested').filter(e => isRealFile(e.fileName));
  const bytesAfter = after.reduce((sum, e) => {
    try { return sum + fs.statSync(path.join(objDir, e.relPath)).size; } catch { return sum; }
  }, 0);

  const expectedCount = before.length - cleanedDuplicates;
  const expectedBytes = bytesBefore - cleanedDuplicateBytes;
  if (after.length !== expectedCount || bytesAfter !== expectedBytes) {
    result.error = `Verification failed: ${before.length} files/${bytesBefore} bytes before, ${after.length}/${bytesAfter} after`;
    log.error({ objectId, before: before.length, after: after.length, bytesBefore, bytesAfter, cleanedDuplicates }, '[renest] verification failed');
    return result;
  }
  if (result.skipped > 0) {
    result.error = `${result.skipped} file(s) could not be moved. The object was left in the flat layout.`;
    return result;
  }

  setObjectLayout(objectId, 'nested');
  writeObjectManifest(objectId, folderName);
  log.info({ objectId, moved: result.moved, skipped: result.skipped }, '[renest] object converted');
  return result;
}

// ─── Whole-library run ───────────────────────────────────────────────────────

interface RenestStatus {
  running: boolean;
  startedAt: string | null;
  objectsTotal: number;
  objectsDone: number;
  currentObject: string | null;
  summary: RenestSummary | null;
  error: string | null;
}

let status: RenestStatus = {
  running: false, startedAt: null, objectsTotal: 0, objectsDone: 0,
  currentObject: null, summary: null, error: null,
};

export function getRenestStatus(): RenestStatus {
  return { ...status };
}

/** How many objects are still flat, for the "you have N to convert" prompt. */
export function countFlatObjects(): number {
  return db.prepare<[], { n: number }>(
    "SELECT COUNT(*) as n FROM libraryObjects WHERE deleted = 0 AND (layout IS NULL OR layout != 'nested')",
  ).get()?.n ?? 0;
}

/** Give the event loop a turn between objects. renestObjectUnlocked() moves
 *  files with synchronous fs calls (matching the rest of this module — see
 *  the EXDEV fallback note above), so without an explicit yield here a
 *  library-wide run never lets the server answer another request, including
 *  the status poll this run's own progress bar depends on, until every
 *  object is done. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Convert every flat object. Single-flight, mirroring libraryMigration's
 * `startMigration` so two concurrent requests can't interleave file moves.
 *
 * Async so callers can fire-and-forget it (mirroring runImport()) and let
 * the client track progress via getRenestStatus() polling instead of
 * blocking the triggering HTTP request for the whole run.
 */
export async function renestLibrary(): Promise<RenestSummary> {
  if (status.running) throw new Error('A reorganize is already running');
  if (!claimImportLock()) throw new Error(RENEST_BUSY_ERROR);

  const results: RenestObjectResult[] = [];
  try {
    const objects = db.prepare<[], { objectId: string }>(
      "SELECT objectId FROM libraryObjects WHERE deleted = 0 AND (layout IS NULL OR layout != 'nested')",
    ).all();

    status = {
      running: true,
      startedAt: new Date().toISOString(),
      objectsTotal: objects.length,
      objectsDone: 0,
      currentObject: null,
      summary: null,
      error: null,
    };

    for (const { objectId } of objects) {
      status.currentObject = objectId;
      const r = renestObjectUnlocked(objectId);
      results.push(r);
      status.objectsDone++;
      await yieldToEventLoop();
    }
  } finally {
    status.running = false;
    status.currentObject = null;
    releaseImportLock();
  }

  const summary: RenestSummary = {
    objects: results.length,
    moved: results.reduce((s, r) => s + r.moved, 0),
    failed: results.filter(r => r.error).length,
    results,
  };
  status.summary = summary;
  log.info({ objects: summary.objects, moved: summary.moved, failed: summary.failed }, '[renest] library run complete');
  return summary;
}

/** Exposed for tests: does this object have a row for every file on disk? */
export function isFullyRecorded(objectId: string, folderName: string): boolean {
  const objDir = path.join(getLibraryDir(), folderName);
  const files = listObjectFiles(objDir, getObjectLayout(objectId)).filter(e => isRealFile(e.fileName));
  return files.every(e => getLibraryFileRow(`${folderName}/${e.relPath}`) !== undefined);
}
