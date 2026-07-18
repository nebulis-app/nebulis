/**
 * Library — gallery/image domain.
 *
 * Listing stacked JPGs across the library, getting/setting per-object gallery
 * images, and getting/setting per-session "crowned" preview images. The
 * gallery card image is auto-selected from disk when no explicit choice has
 * been recorded.
 */
import fs from 'fs';
import path from 'path';
import { getLibraryDir } from '../libraryPath.js';
import { parseFilename, normalizeCatalogId, sessionNightFor } from '../telescopeFiles.js';
import {
  stmts,
  getFolderName,
  ensureLibraryDir,
  LIBRARY_API_BASE,
} from './objects.js';
import { getImageFavorites } from './favorites.js';
import { caldwellToNgcId } from '../caldwellCatalog.js';
import { hubbleImagePath, wikiImagePath, imageCachePath, fovForEntry, findCachedMaster } from '../catalogPrefetch.js';
import { prefetchSkyImage } from '../skyImage.js';
import { getById as getDsoById } from '../dsoCatalog.js';
import { getSettingsData } from '../telescopes.js';

// ─── Library-wide image listing ─────────────────────────────────────────────

export interface LibraryImageEntry {
  name: string;
  path: string;
  date: string;
  objectId: string;
  objectName: string;
  objectType: string | null;
  distanceLy: number | null;
  downloadUrl: string;
  isFavorite: boolean;
}

export interface GetAllLibraryImagesOptions {
  /** Max items to return. Clamped to [1, 500]. If omitted, no slicing is applied. */
  limit?: number;
  /** Number of items to skip. Clamped to >= 0. Defaults to 0 when limit is set. */
  offset?: number;
}

export interface GetAllLibraryImagesResult {
  items: LibraryImageEntry[];
  /** Total count after filtering, before slicing. */
  total: number;
  /** offset+items.length if more remain; null if we returned the last page. */
  nextOffset: number | null;
}

/** Image entry without the per-user favorite flag (the cacheable portion). */
type LibraryImageBase = Omit<LibraryImageEntry, 'isFavorite'>;

/**
 * Cache for the (expensive) library-wide filesystem walk. The walk reads every
 * object directory off disk and is identical for all users, so we cache the
 * sorted base list (without per-user favorite state) for a short TTL. This
 * collapses the burst of repeated calls that a single gallery visit triggers
 * (initial load + window-focus refetch + favorite-toggle invalidations) into
 * one disk scan, instead of re-walking the whole library each time and blocking
 * the event loop. Favorite state is still read fresh on every call, so toggles
 * are reflected immediately. Mirrors the planner's TTL cache.
 */
const ALL_IMAGES_WALK_TTL_MS = 15_000;
let allImagesWalkCache: { dir: string; entries: LibraryImageBase[]; expiresAt: number } | null = null;

/** Drop the cached walk so the next call re-scans disk (e.g. after an import). */
export function invalidateAllImagesCache(): void {
  allImagesWalkCache = null;
}

function walkAllLibraryImages(LIBRARY_DIR: string): LibraryImageBase[] {
  const objects = stmts.getAllObjects.all();
  const results: LibraryImageBase[] = [];

  for (const obj of objects) {
    const objDir = path.join(LIBRARY_DIR, obj.folderName);
    if (!fs.existsSync(objDir)) continue;

    for (const file of fs.readdirSync(objDir)) {
      const lower = file.toLowerCase();
      if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png')) continue;
      if (lower.includes('_thn.')) continue;
      if (file.startsWith('sky_') || file.startsWith('gallery_')) continue;

      const parsed = parseFilename(file);
      const filePath = `${obj.folderName}/${file}`;
      results.push({
        name: file,
        path: filePath,
        date: sessionNightFor(parsed) || 'unknown',
        objectId: obj.objectId,
        objectName: obj.objectName || obj.objectId,
        objectType: obj.objectType,
        distanceLy: obj.distanceLy ?? null,
        downloadUrl: `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(filePath)}`,
      });
    }
  }

  // Sort is independent of favorite state, so we do it once before caching.
  results.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return results;
}

/**
 * Return all stacked JPG images across every library object, with favorite state.
 *
 * If neither `limit` nor `offset` is provided, returns every item (legacy behavior),
 * with `total === items.length` and `nextOffset === null`. When pagination params
 * are provided, items are sliced and `nextOffset` indicates the next page start.
 */
export function getAllLibraryImages(
  userId = '',
  options: GetAllLibraryImagesOptions = {}
): GetAllLibraryImagesResult {
  const LIBRARY_DIR = getLibraryDir();
  ensureLibraryDir();

  const now = Date.now();
  let base: LibraryImageBase[];
  if (allImagesWalkCache && allImagesWalkCache.dir === LIBRARY_DIR && allImagesWalkCache.expiresAt > now) {
    base = allImagesWalkCache.entries;
  } else {
    base = walkAllLibraryImages(LIBRARY_DIR);
    allImagesWalkCache = { dir: LIBRARY_DIR, entries: base, expiresAt: now + ALL_IMAGES_WALK_TTL_MS };
  }

  // Favorite state is per-user and read fresh every call so toggles show up
  // immediately. Order is preserved from the cached (already-sorted) base list.
  const favoriteSet = new Set(getImageFavorites(userId));
  const results: LibraryImageEntry[] = base.map(e => ({ ...e, isFavorite: favoriteSet.has(e.path) }));

  const total = results.length;
  const paginated = options.limit !== undefined || options.offset !== undefined;
  if (!paginated) {
    return { items: results, total, nextOffset: null };
  }

  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  // Clamp limit to [1, 500]. If caller passed an invalid value (NaN, <=0), fall
  // back to the default page size of 100 rather than 4xx — iOS gallery treats
  // out-of-range values as "use the default".
  const rawLimit = options.limit;
  let limit: number;
  if (rawLimit === undefined || !Number.isFinite(rawLimit) || rawLimit < 1) {
    limit = 100;
  } else {
    limit = Math.min(500, Math.floor(rawLimit));
  }

  const items = results.slice(offset, offset + limit);
  const end = offset + items.length;
  const nextOffset = end < total ? end : null;
  return { items, total, nextOffset };
}

/** List all stacked JPG images across all sessions for an object. */
export function getStackedImages(objectId: string): Array<{ name: string; path: string; date: string; downloadUrl: string }> {
  const LIBRARY_DIR = getLibraryDir();
  const folderName = getFolderName(objectId);
  const objDir = path.join(LIBRARY_DIR, folderName);
  if (!fs.existsSync(objDir)) return [];

  const results: Array<{ name: string; path: string; date: string; downloadUrl: string }> = [];
  const files = fs.readdirSync(objDir);

  for (const file of files) {
    const lower = file.toLowerCase();
    if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png')) continue;
    if (lower.includes('_thn.')) continue; // skip thumbnails
    if (file.startsWith('sky_') || file.startsWith('gallery_')) continue; // skip managed images

    const parsed = parseFilename(file);
    const filePath = `${folderName}/${file}`;
    results.push({
      name: file,
      path: filePath,
      date: sessionNightFor(parsed) || 'unknown',
      downloadUrl: `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(filePath)}`,
    });
  }

  // Sort newest first
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results;
}

// ─── Gallery image (per-object) ─────────────────────────────────────────────

/** Get the gallery image path plus the user-set flag for an object. */
export function getGalleryImageRow(objectId: string): { galleryImage: string | null; userSet: boolean } {
  const row = stmts.getGalleryImage.get(objectId);
  return { galleryImage: row?.galleryImage ?? null, userSet: Boolean(row?.galleryImageUserSet) };
}

/** Get the custom gallery image path for an object (null if none set). */
export function getGalleryImage(objectId: string): string | null {
  return getGalleryImageRow(objectId).galleryImage;
}

/** Set (or clear) the custom gallery image for an object (auto-assigned, not user-chosen). */
export function setGalleryImage(objectId: string, imagePath: string | null): void {
  stmts.setGalleryImage.run(imagePath, objectId);
}

/** Set the gallery image as explicitly chosen by the user (preserved across restarts). */
export function setGalleryImageUserChosen(objectId: string, imagePath: string | null): void {
  stmts.setGalleryImageUserSet.run(imagePath, objectId);
}

// ─── Session image (per-session "crowned" preview) ──────────────────────────

/** Get the designated session image path (relative) for a session, or null. */
export function getSessionImage(objectId: string, date: string): string | null {
  const row = stmts.getSessionImage.get(objectId, date);
  return row?.sessionImage ?? null;
}

/** Set (or clear) the designated session image for a session. */
export function setSessionImage(objectId: string, date: string, imagePath: string | null): void {
  stmts.setSessionImage.run(imagePath, objectId, date);
}

// ─── Object image resolution ─────────────────────────────────────────────────

/** `catalog-source:hubble|wiki|dss2` sentinel → cached master path on disk. */
export function resolveCatalogSourceSentinel(value: string, resolvedId: string): string | null {
  const match = value.match(/^catalog-source:(hubble|wiki|dss2)$/);
  if (!match) return null;
  const source = match[1];
  const candidate = source === 'hubble' ? hubbleImagePath(resolvedId)
    : source === 'wiki' ? wikiImagePath(resolvedId)
    : imageCachePath(resolvedId);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the authoritative source image path for an object.
 * Priority: user-set override > galleryImageSource setting > best local catalog
 * image > telescope fallback. Triggers a one-time catalog prefetch when no
 * catalog image is cached yet. Never reaches out to the telescope live.
 *
 * Returns an absolute path, or null if nothing is available.
 */
export async function resolveObjectImagePath(
  objectId: string,
  preferOverride?: 'sky' | 'telescope',
): Promise<string | null> {
  const row = getGalleryImageRow(objectId);
  const settings = getSettingsData();
  const preferSkySurvey = preferOverride
    ? preferOverride === 'sky'
    : typeof settings.galleryImageSource === 'string'
      ? settings.galleryImageSource !== 'telescope'
      : true;

  const catalogId = normalizeCatalogId(objectId);
  const resolvedId = caldwellToNgcId(catalogId) ?? catalogId;

  if (row.userSet && row.galleryImage) {
    const sentinel = resolveCatalogSourceSentinel(row.galleryImage, resolvedId);
    if (sentinel) return sentinel;
    const abs = path.join(getLibraryDir(), row.galleryImage);
    if (fs.existsSync(abs)) return abs;
    console.warn(`[gallery] ${objectId}: userSet galleryImage="${row.galleryImage}" did not resolve `
      + `(sentinel=${row.galleryImage.startsWith('catalog-source:')}, abs=${abs}); falling back to sky survey`);
  }

  if (!preferSkySurvey && row.galleryImage) {
    const sentinel = resolveCatalogSourceSentinel(row.galleryImage, resolvedId);
    if (sentinel) return sentinel;
    const abs = path.join(getLibraryDir(), row.galleryImage);
    if (fs.existsSync(abs)) return abs;
  }

  const cached = findCachedMaster(resolvedId);
  if (cached) return cached.path;

  try {
    const dsoEntry = getDsoById(resolvedId);
    const fov = fovForEntry(dsoEntry?.majorAxisArcmin ?? null);
    const fetched = await prefetchSkyImage(resolvedId, {
      fov,
      ra: dsoEntry?.ra != null ? dsoEntry.ra * 15 : undefined,
      dec: dsoEntry?.dec,
    });
    if (fetched) return fetched;
  } catch { /* external service unavailable */ }

  if (row.galleryImage) {
    const abs = path.join(getLibraryDir(), row.galleryImage);
    if (fs.existsSync(abs)) return abs;
  }

  return null;
}
