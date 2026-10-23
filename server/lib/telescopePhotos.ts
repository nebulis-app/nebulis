/**
 * One picture per telescope, the owner's own photo of it. The web app shows it on the telescope's card in Settings;
 * a cut-out on a transparent background looks best.
 *
 * It is a file, not a column: DATA_DIR/telescope-photos/<telescopeId>.webp, so a telescope has a picture exactly when
 * the file exists and its modified time is the cache-busting version. Uploads are decoded and re-encoded (longest side
 * 1200 px, transparency kept), which both bounds the size and means the stored bytes are always an image this server
 * made, never whatever was sent. SVG is refused: it can carry script.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { DATA_DIR } from './paths.js';

export const TELESCOPE_PHOTO_LIMITS = { bytes: 20 * 1024 * 1024, maxEdge: 1200 } as const;

export const TELESCOPE_PHOTOS_DIR = path.join(DATA_DIR, 'telescope-photos');

export class TelescopePhotoError extends Error {
  constructor(public code: 'VALIDATION_ERROR', message: string) {
    super(message);
  }
}

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'tiff', 'avif']);

/** The id becomes a file name, so only the characters an id is made of are allowed. */
function fileFor(telescopeId: string): string | null {
  return /^[A-Za-z0-9_-]{1,100}$/.test(telescopeId) ? path.join(TELESCOPE_PHOTOS_DIR, `${telescopeId}.webp`) : null;
}

export function getTelescopePhotoPath(telescopeId: string): string | null {
  const file = fileFor(telescopeId);
  return file && fs.existsSync(file) ? file : null;
}

/** Changes whenever the picture does; null when there is none. */
export function telescopePhotoVersion(telescopeId: string): number | null {
  const file = getTelescopePhotoPath(telescopeId);
  if (!file) return null;
  try { return Math.round(fs.statSync(file).mtimeMs); } catch { return null; }
}

/**
 * Replaces the telescope's picture with an upload. The temp file is always consumed, so a refused upload leaves nothing behind.
 */
export async function setTelescopePhoto(telescopeId: string, tempPath: string): Promise<number> {
  const target = fileFor(telescopeId);
  const staging = target ? `${target}.${process.pid}.tmp` : null;
  try {
    if (!target || !staging) throw new TelescopePhotoError('VALIDATION_ERROR', 'Invalid telescope id');
    let format: string | undefined;
    try {
      format = (await sharp(tempPath).metadata()).format;
    } catch {
      throw new TelescopePhotoError('VALIDATION_ERROR', 'That file is not a picture this server can read');
    }
    if (!format || !ACCEPTED_FORMATS.has(format)) {
      throw new TelescopePhotoError('VALIDATION_ERROR', 'Use a JPEG, PNG, WebP, GIF, TIFF, AVIF or HEIC picture');
    }
    fs.mkdirSync(TELESCOPE_PHOTOS_DIR, { recursive: true });
    try {
      await sharp(tempPath).rotate()
        .resize({ width: TELESCOPE_PHOTO_LIMITS.maxEdge, height: TELESCOPE_PHOTO_LIMITS.maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88 }).toFile(staging);
    } catch {
      throw new TelescopePhotoError('VALIDATION_ERROR', 'That picture could not be processed');
    }
    fs.renameSync(staging, target);
    return telescopePhotoVersion(telescopeId) ?? Date.now();
  } finally {
    fs.rmSync(tempPath, { force: true });
    if (staging) fs.rmSync(staging, { force: true });
  }
}

export function deleteTelescopePhoto(telescopeId: string): boolean {
  const file = getTelescopePhotoPath(telescopeId);
  if (!file) return false;
  fs.rmSync(file, { force: true });
  return true;
}
