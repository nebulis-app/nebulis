/**
 * "My Catalog" wall: the user's own picture for each catalog object, and how
 * much room it earns in the mosaic.
 *
 * Deliberately separate from `resolveObjectImagePath`: that resolver falls back
 * to sky-survey masters for an object with no photo, which is exactly what the
 * wall must never show. Here "no photo of your own" means "no image".
 */
import fs from 'fs';
import sharp from 'sharp';
import { getGalleryImageRow, getStackedImages } from './library/gallery.js';
import { resolveLibraryFile } from './library/fileResolver.js';
import { findFallbackObservationImage } from './library/objects.js';
import { getAllProcessedImagesForObject } from './library/processed.js';
import { isDwarfInternalArtifact } from './library/importFilter.js';

export type WallImageKind = 'processed' | 'telescope';

export interface WallImage {
  /** Library-relative path, servable by `/library/file/thumbnail`. */
  path: string;
  kind: WallImageKind;
  /** width / height of the source, 1 when it could not be read. */
  aspect: number;
}

export interface WallSpan { cols: number; rows: number }

const RENDERABLE_EXT = /\.(jpe?g|png|tiff?)$/i;

export interface WallCandidates {
  /** The user's explicitly featured image (already known to be a real file). */
  featured: string | null;
  /** Renderable processed images, any order. */
  processed: Array<{ path: string; uploadedAt: string; source: string }>;
  /** The telescope fallback (stacked JPG etc.). */
  telescope: string | null;
}

/**
 * Priority: featured image, newest user-processed, Dwarf restack, telescope.
 * Pure, so the ordering is testable without a library on disk.
 */
export function pickWallCandidate(c: WallCandidates): { path: string; kind: WallImageKind } | null {
  if (c.featured) {
    // A featured image is the user's own choice; classify by where it lives.
    const isProcessed = /(^|\/)processed\//.test(c.featured);
    return { path: c.featured, kind: isProcessed ? 'processed' : 'telescope' };
  }
  const byNewest = (a: { uploadedAt: string }, b: { uploadedAt: string }) =>
    b.uploadedAt.localeCompare(a.uploadedAt);
  const user = c.processed.filter(p => p.source !== 'dwarf-restack').sort(byNewest)[0];
  if (user) return { path: user.path, kind: 'processed' };
  const restack = c.processed.filter(p => p.source === 'dwarf-restack').sort(byNewest)[0];
  if (restack) return { path: restack.path, kind: 'processed' };
  if (c.telescope) return { path: c.telescope, kind: 'telescope' };
  return null;
}

/** The surface area (in grid cells) an object earns from its size in the sky. */
export function areaForSize(majorAxisArcmin: number | null | undefined): 1 | 2 | 4 | 6 {
  if (majorAxisArcmin == null || !Number.isFinite(majorAxisArcmin) || majorAxisArcmin < 20) return 1;
  if (majorAxisArcmin < 50) return 2;
  if (majorAxisArcmin < 100) return 4;
  return 6;
}

/**
 * Grid span for an object: area from its apparent size, orientation from the
 * photo's aspect ratio. No bonus for processed images.
 */
export function autoSpan(majorAxisArcmin: number | null | undefined, aspect: number): WallSpan {
  const area = areaForSize(majorAxisArcmin);
  const wide = !Number.isFinite(aspect) || aspect >= 1;
  switch (area) {
    case 1: return { cols: 1, rows: 1 };
    case 2: return wide ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
    case 4: return { cols: 2, rows: 2 };
    case 6: return wide ? { cols: 3, rows: 2 } : { cols: 2, rows: 3 };
  }
}

// Aspect is read from the file header (cheap, no decode), then remembered until
// the file changes.
const aspectCache = new Map<string, number>();

async function readAspect(relPath: string): Promise<number> {
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) return 1;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(resolved.abs).mtimeMs;
  } catch {
    return 1;
  }
  const key = `${relPath}@${mtimeMs}`;
  const hit = aspectCache.get(key);
  if (hit != null) return hit;
  let aspect = 1;
  try {
    const meta = await sharp(resolved.abs).metadata();
    // EXIF orientations 5-8 are rotated a quarter turn, so width and height swap.
    const swapped = (meta.orientation ?? 1) >= 5;
    const w = swapped ? meta.height : meta.width;
    const h = swapped ? meta.width : meta.height;
    if (w && h) aspect = w / h;
  } catch { /* unreadable header: treat as square */ }
  aspectCache.set(key, aspect);
  return aspect;
}

function fileExists(relPath: string): boolean {
  const resolved = resolveLibraryFile(relPath);
  return !!resolved && fs.existsSync(resolved.abs);
}

/** The user's own best picture of a library object, or null if they have none. */
export async function resolveWallImage(objectId: string): Promise<WallImage | null> {
  const row = getGalleryImageRow(objectId);
  // Survey sentinels (`catalog-source:*`) are sky-survey masters, never the user's.
  const featured =
    row.userSet && row.galleryImage && !row.galleryImage.startsWith('catalog-source:') && !row.galleryImage.startsWith('builtin:')
    && RENDERABLE_EXT.test(row.galleryImage) && fileExists(row.galleryImage)
      ? row.galleryImage
      : null;

  const processed = getAllProcessedImagesForObject(objectId)
    .filter(r => RENDERABLE_EXT.test(r.filename) && !isDwarfInternalArtifact(r.filename))
    .map(r => ({ path: r.path, uploadedAt: r.uploadedAt, source: r.source }))
    .filter(r => fileExists(r.path));

  const fallback = findFallbackObservationImage(objectId);
  const telescope = fallback
    && !/(^|\/)(sky_|gallery_)/.test(fallback)
    && !isDwarfInternalArtifact(fallback.split('/').pop() ?? fallback)
    && fileExists(fallback)
      ? fallback
      : null;

  const picked = pickWallCandidate({ featured, processed, telescope });
  if (!picked) return null;
  return { ...picked, aspect: await readAspect(picked.path) };
}

/** True for a renderable image that exists inside the library (never a survey master). */
export function isOwnImagePath(relPath: string): boolean {
  if (!RENDERABLE_EXT.test(relPath) || /(^|\/)sky_/.test(relPath)) return false;
  return fileExists(relPath);
}

export interface WallImageChoice { path: string; kind: WallImageKind; label: string; aspect: number }

/** Every picture of the user's own that a tile could show: processed images
 *  (newest first), then the telescope's best stack. */
export async function listWallImageChoices(objectId: string): Promise<WallImageChoice[]> {
  const out: Omit<WallImageChoice, 'aspect'>[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<WallImageChoice, 'aspect'>) => { if (!seen.has(c.path)) { seen.add(c.path); out.push(c); } };

  const processed = getAllProcessedImagesForObject(objectId)
    .filter(r => RENDERABLE_EXT.test(r.filename) && !isDwarfInternalArtifact(r.filename) && fileExists(r.path))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  for (const r of processed) add({ path: r.path, kind: 'processed', label: r.title || r.originalName });

  // Every stacked frame across the object's nights, newest night first.
  const stacked = getStackedImages(objectId)
    .filter(s => RENDERABLE_EXT.test(s.name) && !isDwarfInternalArtifact(s.name) && !/(^|\/)(sky_|gallery_)/.test(s.path) && fileExists(s.path))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const s of stacked) add({ path: s.path, kind: 'telescope', label: `${s.date} · ${s.name}` });

  const fallback = findFallbackObservationImage(objectId);
  if (fallback && !/(^|\/)(sky_|gallery_)/.test(fallback) && fileExists(fallback)) {
    add({ path: fallback, kind: 'telescope', label: fallback.split('/').pop() ?? fallback });
  }
  return Promise.all(out.map(async c => ({ ...c, aspect: await readAspect(c.path) })));
}
