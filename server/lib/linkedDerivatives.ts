/**
 * Where a derivative (a FITS or TIFF thumbnail) of a LINKED file is kept.
 *
 * A linked folder is the user's own archive, often read-only. Nebulis never writes to, renames or deletes a file it did
 * not copy (see library/fileResolver.ts), and that includes a `.thumbs/` folder beside the file. On a read-only mount
 * the write failed on every request and, with no negative cache, the viewer fell back to downloading the whole FITS.
 *
 * The key holds the size and mtime, so a file that is replaced in place gets a fresh render instead of its old preview.
 */
import crypto from 'crypto';
import path from 'path';
import { THUMBNAILS_DIR } from './paths.js';

export function linkedThumbnailPath(absPath: string, stat: { size: number; mtimeMs: number }, thumbFileName: string): string {
  const key = crypto.createHash('sha1').update(`${absPath}\0${stat.size}\0${Math.round(stat.mtimeMs)}`).digest('hex');
  return path.join(THUMBNAILS_DIR, 'linked', `${key}-${thumbFileName}`);
}
