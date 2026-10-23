/**
 * Library: replace one existing picture's pixels in place (the Mac viewer's Rotate and Edit).
 *
 * The first replacement of a file stashes the untouched original under `{DATA_DIR}/original-backups/`
 * (never next to the user's files, so linked folders are not cluttered). Later replacements keep that
 * first backup. The new bytes are written beside the target and renamed over it, so a failure part
 * way leaves the old file intact.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import db from '../db.js';
import { DATA_DIR } from '../paths.js';
import { resolveLibraryFile } from './fileResolver.js';

export const ORIGINAL_BACKUPS_DIR = path.join(DATA_DIR, 'original-backups');

export class ReplaceFileError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ReplaceFileError';
  }
}

type Kind = 'jpeg' | 'png';

function kindOfName(name: string): Kind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.png') return 'png';
  return null;
}

function kindOfBytes(head: Buffer): Kind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  return null;
}

function backupDir(relPath: string): string {
  return path.join(ORIGINAL_BACKUPS_DIR, createHash('sha1').update(relPath).digest('hex').slice(0, 16));
}

/** The kept first original of `relPath`, or null when the picture was never replaced. */
export function originalBackupFile(relPath: string): string | null {
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) return null;
  const backup = path.join(backupDir(relPath), path.basename(resolved.abs));
  try { return fs.statSync(backup).isFile() ? backup : null; } catch { return null; }
}

/**
 * Put the kept original back over the picture and drop the backup, so the picture is no longer "edited". The copy is
 * written beside the target and renamed over it, like a replace, so a failure leaves the edited file intact.
 */
export function restoreOriginalBackup(relPath: string, opts: { confirmLinked: boolean }): { bytes: number } {
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) throw new ReplaceFileError(404, 'FILE_NOT_FOUND', 'That file is not in the library');
  if (resolved.sourceId !== null && !opts.confirmLinked) {
    throw new ReplaceFileError(409, 'LINKED_REPLACE_UNCONFIRMED', 'This file is in a linked folder. Confirm that Nebulis may rewrite it.');
  }
  const backup = originalBackupFile(relPath);
  if (!backup) throw new ReplaceFileError(404, 'NO_ORIGINAL', 'There is no saved original for this picture');
  const target = resolved.abs;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.nebulis-${randomUUID()}.tmp`);
  try {
    fs.copyFileSync(backup, tmp);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    throw err;
  }
  fs.rmSync(backupDir(relPath), { recursive: true, force: true });
  const after = fs.statSync(target);
  updateRow.run(after.size, Math.floor(after.mtimeMs), relPath);
  return { bytes: after.size };
}

const updateRow = db.prepare('UPDATE libraryFiles SET bytes = ?, mtimeMs = ? WHERE relPath = ?');

export interface ReplaceResult { backedUp: boolean; bytes: number }

/** Swap the file at `relPath` for the staged upload at `stagedPath`. The caller deletes the staged file. */
export function replaceLibraryFile(relPath: string, stagedPath: string, opts: { confirmLinked: boolean }): ReplaceResult {
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) throw new ReplaceFileError(404, 'FILE_NOT_FOUND', 'That file is not in the library');
  if (resolved.sourceId !== null && !opts.confirmLinked) {
    throw new ReplaceFileError(409, 'LINKED_REPLACE_UNCONFIRMED', 'This file is in a linked folder. Confirm that Nebulis may rewrite it.');
  }
  const target = resolved.abs;
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { throw new ReplaceFileError(404, 'FILE_NOT_FOUND', 'That file is no longer on disk'); }
  if (!stat.isFile()) throw new ReplaceFileError(404, 'FILE_NOT_FOUND', 'That is not a file');

  const targetKind = kindOfName(target);
  if (!targetKind) throw new ReplaceFileError(415, 'UNSUPPORTED_FORMAT', 'Only JPEG and PNG pictures can be rewritten');
  const head = Buffer.alloc(8);
  const fd = fs.openSync(stagedPath, 'r');
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (kindOfBytes(head) !== targetKind) {
    throw new ReplaceFileError(415, 'FORMAT_MISMATCH', `The new picture must be a ${targetKind.toUpperCase()} like the original`);
  }

  // Keep the very first original, once.
  const dir = backupDir(relPath);
  const backup = path.join(dir, path.basename(target));
  let backedUp = false;
  if (!fs.existsSync(backup)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(target, backup);
    fs.writeFileSync(path.join(dir, 'source.txt'), relPath + '\n');
    backedUp = true;
  }

  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.nebulis-${randomUUID()}.tmp`);
  try {
    fs.copyFileSync(stagedPath, tmp);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    throw err;
  }
  const after = fs.statSync(target);
  updateRow.run(after.size, Math.floor(after.mtimeMs), relPath);
  return { backedUp, bytes: after.size };
}
