/**
 * Pictures whose frame was changed (cropped, rotated, flipped) after capture.
 *
 * A plate solution is read from the picture itself, so it stays right. The other two sources of a position, the FITS
 * twin's header and the telescope's field of view, describe the frame as captured, so on an edited picture they put
 * the object circles in the wrong place. Annotate skips them while the mark holds.
 *
 * The mark carries the file's mtime at the time of the edit: any later change to the file, such as restoring the
 * saved original, makes it stale without anyone having to clear it.
 */
import fs from 'fs';
import db from '../db.js';
import { resolveLibraryFile } from '../library/fileResolver.js';

const stmts = {
  put: db.prepare<[string, number]>(
    `INSERT INTO fileGeometryEdits (relPath, mtimeMs) VALUES (?, ?)
     ON CONFLICT(relPath) DO UPDATE SET mtimeMs = excluded.mtimeMs`,
  ),
  get: db.prepare<[string], { mtimeMs: number }>('SELECT mtimeMs FROM fileGeometryEdits WHERE relPath = ?'),
};

/** Records that the picture now on disk at `relPath` has a different frame from the one captured. */
export function markGeometryEdited(relPath: string): void {
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) return;
  stmts.put.run(relPath, fs.statSync(resolved.abs).mtimeMs);
}

/** True while the file still has the mtime it had when its frame was edited. */
export function isGeometryEdited(relPath: string, mtimeMs: number): boolean {
  return stmts.get.get(relPath)?.mtimeMs === mtimeMs;
}
