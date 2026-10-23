/**
 * Pictures of an observing site: the garden, the skyline, the spot the tripod stands on. They are for the
 * person's own reference (and for telling two sites apart), so nothing else reads them.
 *
 * Files live on disk under DATA_DIR/site-photos/<siteId>/, named by their own id and never by the uploaded name, so a
 * name can't reach outside the folder. The original name stays in the row for display. Small JPEG previews are
 * made on first request and kept beside the originals in a `thumbs` folder.
 *
 * This module must not import observingSites.ts: deleteSite there calls into here.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import db from './db.js';
import { DATA_DIR } from './paths.js';

export interface SitePhoto {
  id: string;
  siteId: string;
  fileName: string;
  mimeType: string;
  size: number;
  caption: string;
  createdAt: string;
}

export const SITE_PHOTO_LIMITS = {
  /** Per site. */
  photos: 40,
  bytes: 30 * 1024 * 1024,
  caption: 300,
  fileName: 200,
} as const;

export class SitePhotoError extends Error {
  constructor(public code: 'NOT_FOUND' | 'VALIDATION_ERROR', message: string) {
    super(message);
  }
}

export const SITE_PHOTOS_DIR = path.join(DATA_DIR, 'site-photos');

/** Only pictures. The route serves them inline, so nothing a browser could run as a page is let in. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

interface PhotoRow {
  id: string; siteId: string; fileName: string; mimeType: string; size: number; storedName: string; caption: string; createdAt: string;
}

const stmts = {
  forSite: db.prepare<[string], PhotoRow>('SELECT * FROM siteImages WHERE siteId = ? ORDER BY createdAt, id'),
  get: db.prepare<[string], PhotoRow>('SELECT * FROM siteImages WHERE id = ?'),
  count: db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM siteImages WHERE siteId = ?'),
  siteExists: db.prepare<[string], { id: string }>('SELECT id FROM observingSites WHERE id = ?'),
  insert: db.prepare(`INSERT INTO siteImages (id, siteId, fileName, mimeType, size, storedName, caption, createdAt)
                      VALUES (@id, @siteId, @fileName, @mimeType, @size, @storedName, @caption, @createdAt)`),
  caption: db.prepare('UPDATE siteImages SET caption = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM siteImages WHERE id = ?'),
  deleteForSite: db.prepare('DELETE FROM siteImages WHERE siteId = ?'),
};

function photo(r: PhotoRow): SitePhoto {
  return { id: r.id, siteId: r.siteId, fileName: r.fileName, mimeType: r.mimeType, size: r.size, caption: r.caption, createdAt: r.createdAt };
}

/** What the bytes are, by their first few bytes, so a file can't pass as a picture just by saying so. */
function sniffImageType(filePath: string): string | null {
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, 16, 0);
      head = buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return brand === 'mif1' ? 'image/heif' : 'image/heic';
  }
  return null;
}

function safeExtension(fileName: string, mimeType: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
  return mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
}

export function listSitePhotos(siteId: string): SitePhoto[] {
  return stmts.forSite.all(siteId).map(photo);
}

export function isImageType(mime: string): boolean {
  return IMAGE_TYPES.has(mime.toLowerCase());
}

/**
 * Moves an uploaded temp file into the site's folder. The temp file is always consumed (moved or deleted), so a
 * refused upload never leaves anything behind.
 */
export function addSitePhoto(
  siteId: string,
  upload: { tempPath: string; fileName: string; mimeType: string; size: number; caption?: string },
  now = new Date(),
): SitePhoto {
  try {
    if (!stmts.siteExists.get(siteId)) throw new SitePhotoError('NOT_FOUND', 'Observing site not found');
    const sniffed = sniffImageType(upload.tempPath);
    if (!sniffed || !isImageType(sniffed)) throw new SitePhotoError('VALIDATION_ERROR', 'Only pictures can be added to a site');
    if ((stmts.count.get(siteId)?.n ?? 0) >= SITE_PHOTO_LIMITS.photos) {
      throw new SitePhotoError('VALIDATION_ERROR', `A site holds at most ${SITE_PHOTO_LIMITS.photos} pictures`);
    }
    const id = randomUUID();
    const fileName = path.basename(upload.fileName.replace(/\\/g, '/')).replace(/\p{Cc}/gu, '').slice(0, SITE_PHOTO_LIMITS.fileName) || 'photo';
    const mimeType = sniffed;
    const storedName = id + safeExtension(fileName, mimeType);
    const dir = path.join(SITE_PHOTOS_DIR, siteId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, storedName);
    try {
      fs.renameSync(upload.tempPath, target);
    } catch {
      // A temp dir on another volume can't be renamed across; copy instead.
      fs.copyFileSync(upload.tempPath, target);
    }
    const row: PhotoRow = {
      id, siteId, fileName, mimeType, size: upload.size, storedName,
      caption: (upload.caption ?? '').slice(0, SITE_PHOTO_LIMITS.caption), createdAt: now.toISOString(),
    };
    stmts.insert.run(row);
    return photo(row);
  } finally {
    fs.rmSync(upload.tempPath, { force: true });
  }
}

export function getSitePhotoFile(id: string): { photo: SitePhoto; filePath: string } | null {
  const r = stmts.get.get(id);
  if (!r) return null;
  const filePath = path.join(SITE_PHOTOS_DIR, r.siteId, r.storedName);
  return fs.existsSync(filePath) ? { photo: photo(r), filePath } : null;
}

/**
 * A JPEG no wider than `width`, made once and kept. Falls back to null when the picture can't be decoded (a HEIC
 * the bundled libvips lacks a codec for), so the route can send the original instead.
 */
export async function getSitePhotoPreview(id: string, width: number): Promise<{ filePath: string } | null> {
  const found = getSitePhotoFile(id);
  if (!found) return null;
  const w = Math.min(2400, Math.max(64, Math.round(width)));
  const dir = path.join(SITE_PHOTOS_DIR, found.photo.siteId, 'thumbs');
  const out = path.join(dir, `${id}-${w}.jpg`);
  if (fs.existsSync(out)) return { filePath: out };
  try {
    fs.mkdirSync(dir, { recursive: true });
    await sharp(found.filePath).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(out);
    return { filePath: out };
  } catch {
    fs.rmSync(out, { force: true });
    return null;
  }
}

export function setSitePhotoCaption(id: string, caption: string): SitePhoto {
  const r = stmts.get.get(id);
  if (!r) throw new SitePhotoError('NOT_FOUND', 'Picture not found');
  const text = caption.slice(0, SITE_PHOTO_LIMITS.caption);
  stmts.caption.run(text, id);
  return photo({ ...r, caption: text });
}

export function deleteSitePhoto(id: string): boolean {
  const r = stmts.get.get(id);
  if (!r) return false;
  stmts.delete.run(id);
  const dir = path.join(SITE_PHOTOS_DIR, r.siteId);
  fs.rmSync(path.join(dir, r.storedName), { force: true });
  // Previews are named <id>-<width>.jpg.
  const thumbs = path.join(dir, 'thumbs');
  try {
    for (const f of fs.readdirSync(thumbs)) if (f.startsWith(`${id}-`)) fs.rmSync(path.join(thumbs, f), { force: true });
  } catch { /* no previews were made */ }
  return true;
}

/** Drops every picture of a site, rows and files. Called when the site itself is deleted. */
export function deleteSitePhotosFor(siteId: string): void {
  stmts.deleteForSite.run(siteId);
  fs.rmSync(path.join(SITE_PHOTOS_DIR, siteId), { recursive: true, force: true });
}
