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
import { createHash } from 'crypto';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { resolveLibraryFile } from './fileResolver.js';
import { normalizeCatalogId } from '../telescopeFiles.js';
import { listObjectFiles, getObjectLayout } from './libraryLayout.js';
import { resolverFor, sessionDateForRow, type LibraryFileRow } from './libraryFiles.js';
import {
  stmts,
  getFolderName,
  ensureLibraryDir,
  resolveContainedObjectDir,
  findFallbackObservationImage,
  LIBRARY_API_BASE,
} from './objects.js';
import { isRenderableProcessedName } from './processed.js';
import { isDwarfThumbnailPreviewName } from './dwarfRestack.js';
import { isDwarfInternalArtifact } from './importFilter.js';
import { getImageFavorites } from './favorites.js';
import { parseGalleryCrop, type GalleryCrop } from './galleryCrop.js';
import { caldwellToNgcId } from '../caldwellCatalog.js';
import { hubbleImagePath, wikiImagePath, imageCachePath, fovForEntry, findCachedMaster } from '../catalogPrefetch.js';
import { prefetchSkyImage } from '../skyImage.js';
import { isMovingObject } from './movingObject.js';
import { getById as getDsoById } from '../dsoCatalog.js';
import { getSettingsData } from '../telescopes.js';
import { parseBuiltinArtSentinel, ensureBuiltinArtFile, type BuiltinArtTheme } from './builtinArt.js';

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
  /** Grid-card JPEG (server resize + disk cache). Always safe for an `<img>`;
   *  for a raw TIFF master it is the only renderable form. */
  thumbUrl: string;
  /** Larger JPEG tier (2048 px) for the full-screen viewer, so a client never
   *  fetches or decodes a 30-100 MB original just to show it. `downloadUrl`
   *  stays the path to the true original for the Download button. */
  previewUrl: string;
  isFavorite: boolean;
  /** True for a user-uploaded post-processing result (sessionProcessedImages),
   *  false for a raw telescope file. Lets the Gallery page offer a "processed
   *  only" view without a second endpoint. */
  isProcessed: boolean;
  /** Made or changed in the image editor: an "...E.jpg" variant of a raw file, or a processed picture it created. */
  isEdited: boolean;
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
let allImagesWalkCache: { dir: string; linkedSig: string; entries: LibraryImageBase[]; expiresAt: number } | null = null;

/** Changes whenever a linked source adds, drops or marks missing a file, so a
 *  link / rescan / unlink (including a scheduled rescan) shows in the Gallery
 *  immediately instead of after the TTL. Those paths live in librarySources.ts,
 *  which doesn't import this module, so they can't call invalidateAllImagesCache. */
function linkedFilesSignature(): string {
  const r = db.prepare<[], { n: number; maxId: number | null; missing: number }>(
    `SELECT COUNT(*) AS n, MAX(id) AS maxId, COUNT(missingSince) AS missing
       FROM libraryFiles WHERE sourceId IS NOT NULL`,
  ).get();
  return r ? `${r.n}:${r.maxId ?? 0}:${r.missing}` : '';
}

/** The linked rows that belong in an image grid: renderable formats only, no
 *  sub-frames or telescope previews (a linked night can hold hundreds of subs),
 *  the same managed-name filters as the disk walk, and nothing the last rescan
 *  found missing or whose source is disabled. */
function linkedGalleryRows(objectId?: string): Array<{ objectId: string; relPath: string; fileName: string; date: string }> {
  const rows = db.prepare<[], Pick<LibraryFileRow, 'objectId' | 'relPath' | 'fileName' | 'role' | 'captureDate' | 'captureTime' | 'sessionDateOverride' | 'sourceId'>>(
    `SELECT f.objectId, f.relPath, f.fileName, f.role, f.captureDate, f.captureTime, f.sessionDateOverride, f.sourceId
       FROM libraryFiles f JOIN librarySources s ON s.id = f.sourceId
      WHERE f.sourceId IS NOT NULL AND f.missingSince IS NULL AND s.enabled = 1`,
  ).all();
  const out: Array<{ objectId: string; relPath: string; fileName: string; date: string }> = [];
  for (const row of rows) {
    if (objectId !== undefined && row.objectId !== objectId) continue;
    if (row.role === 'sub' || row.role === 'thumbnail' || row.role === 'preview') continue;
    const file = row.fileName;
    if (!isRenderableProcessedName(file)) continue;
    if (file.toLowerCase().includes('_thn.')) continue;
    if (file.startsWith('sky_') || file.startsWith('gallery_')) continue;
    if (isDwarfThumbnailPreviewName(file)) continue;
    if (isDwarfInternalArtifact(file)) continue;
    out.push({ objectId: row.objectId, relPath: row.relPath, fileName: file, date: sessionDateForRow(row) || 'unknown' });
  }
  return out;
}

/** The file name the image editor gives a "Save as new version" copy of a raw picture: `<object>_<date>-<time>E.jpg`. */
const EDITOR_VARIANT_NAME = /\d{8}-\d{6}E\.[a-z0-9]+$/i;
/** The note the image editor stamps on a processed picture it creates (see ImageEditorModal). */
const IMAGE_EDITOR_NOTE = 'Created with image editor';

/**
 * The three URLs of an image, stamped with the file's mtime. The picture routes let a browser keep a response for
 * hours, so an image the editor saved over in place would otherwise keep showing its old pixels at the same URL.
 */
function stampedUrls(filePath: string, absPath: string): { downloadUrl: string; thumbUrl: string; previewUrl: string } {
  let version = '';
  try { version = `&v=${Math.floor(fs.statSync(absPath).mtimeMs)}`; } catch { /* missing file: leave the URLs as they were */ }
  const q = encodeURIComponent(filePath);
  const urls = renderUrls(filePath);
  return {
    downloadUrl: `${LIBRARY_API_BASE}/file?path=${q}${version}`,
    thumbUrl: urls.thumbUrl + version,
    previewUrl: urls.previewUrl + version,
  };
}

/** Drop the cached walk so the next call re-scans disk (e.g. after an import). */
export function invalidateAllImagesCache(): void {
  allImagesWalkCache = null;
}

/**
 * Grid and preview URLs for one image. A Dwarf's 32-bit float `.tif` master reads as clipped white through the
 * generic resize route, so TIFFs go through /tiff-thumbnail, which decodes the true samples and autostretches them
 * (the same split getLocalSessions makes for an observation's files).
 */
function renderUrls(libPath: string): { thumbUrl: string; previewUrl: string } {
  const q = encodeURIComponent(libPath);
  if (/\.tiff?$/i.test(libPath)) {
    return {
      thumbUrl: `${LIBRARY_API_BASE}/tiff-thumbnail?path=${q}`,
      previewUrl: `${LIBRARY_API_BASE}/tiff-thumbnail?size=preview&path=${q}`,
    };
  }
  return {
    thumbUrl: `${LIBRARY_API_BASE}/file/thumbnail?path=${q}`,
    previewUrl: `${LIBRARY_API_BASE}/file/thumbnail?w=2048&h=2048&path=${q}`,
  };
}

function walkAllLibraryImages(LIBRARY_DIR: string): LibraryImageBase[] {
  const objects = stmts.getAllObjects.all();
  const results: LibraryImageBase[] = [];

  for (const obj of objects) {
    const objDir = path.join(LIBRARY_DIR, obj.folderName);
    // A purely linked object has no managed folder at all; its files come in
    // through the linked pass below, so a missing dir only skips this walk.
    if (!fs.existsSync(objDir)) continue;

    // Layout-aware: a nested object's images live inside per-session
    // directories, so a flat readdir would leave it out of the gallery.
    const identity = resolverFor(obj.objectId);
    for (const entry of listObjectFiles(objDir, getObjectLayout(obj.objectId))) {
      const file = entry.fileName;
      const lower = file.toLowerCase();
      // Same renderable-format check as the processed-image pass below, so a
      // raw TIFF master (e.g. Dwarf's img_stacked_all.tif) shows up here too
      // instead of only appearing once it's been re-uploaded as "processed".
      if (!isRenderableProcessedName(file)) continue;
      if (lower.includes('_thn.')) continue;
      if (file.startsWith('sky_') || file.startsWith('gallery_')) continue;
      if (isDwarfThumbnailPreviewName(file)) continue; // Dwarf's own redundant stacked_thumbnail.* preview
      if (isDwarfInternalArtifact(file)) continue; // Dwarf's own working artifacts (img_reference.*/img_stacked_counter.*), not a deliverable image

      const filePath = `${obj.folderName}/${entry.relPath}`;
      results.push({
        name: file,
        path: filePath,
        date: identity.session(entry.relPath) || 'unknown',
        objectId: obj.objectId,
        objectName: obj.objectName || obj.objectId,
        objectType: obj.objectType,
        distanceLy: obj.distanceLy ?? null,
        ...stampedUrls(filePath, path.join(objDir, entry.relPath)),
        isProcessed: false,
        isEdited: EDITOR_VARIANT_NAME.test(file),
      });
    }
  }

  // Linked (non-copied) source files exist only as libraryFiles rows, never
  // under LIBRARY_DIR, so the walk above can't see them. Their relPath is the
  // full `@src/<id>/...` form /library/file already resolves.
  const objById = new Map(objects.map(o => [o.objectId, o]));
  for (const row of linkedGalleryRows()) {
    const obj = objById.get(row.objectId);
    if (!obj) continue;
    results.push({
      name: row.fileName,
      path: row.relPath,
      date: row.date,
      objectId: obj.objectId,
      objectName: obj.objectName || obj.objectId,
      objectType: obj.objectType,
      distanceLy: obj.distanceLy ?? null,
      downloadUrl: `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(row.relPath)}`,
      ...renderUrls(row.relPath),
      isProcessed: false,
      isEdited: EDITOR_VARIANT_NAME.test(row.fileName),
    });
  }

  // Processed images (sessionProcessedImages) live under `<folder>/processed/`,
  // which listObjectFiles deliberately never descends into (it's a reserved
  // dir — see isReservedObjectDir), so they need their own pass. `/library/file`
  // resolves any path under LIBRARY_DIR, so the same downloadUrl shape the raw
  // files use above works unchanged. Not deduped to "one per session" the way
  // the auto-thumbnail pick in observations.ts is — this is a flat image grid,
  // so every processed image gets its own card, same as every raw one does.
  // Restricted to formats a browser can render inline: an XISF/FITS/PSD/RAW
  // deliverable can't go in an `<img>`, and has nowhere else to show here.
  for (const r of db.prepare<[], { objectId: string; date: string | null; filename: string; notes: string }>(
    'SELECT objectId, date, filename, notes FROM sessionProcessedImages',
  ).all()) {
    if (!isRenderableProcessedName(r.filename)) continue;
    if (isDwarfThumbnailPreviewName(r.filename)) continue; // Dwarf's own redundant stacked_thumbnail.* preview
    if (isDwarfInternalArtifact(r.filename)) continue; // Dwarf's own working artifacts (img_reference.*/img_stacked_counter.*), not a deliverable image
    const obj = objById.get(r.objectId);
    if (!obj) continue; // processed row survives a deleted/unknown object; skip rather than fabricate one
    const filePath = `${obj.folderName}/processed/${r.filename}`;
    results.push({
      name: r.filename,
      path: filePath,
      // sessionProcessedImages.date is nullable (a user-uploaded processing
      // result isn't always tied to a session date) — the sort below calls
      // .localeCompare on this field, which throws on null and 500s the
      // whole /library/all-images endpoint. Same 'unknown' fallback the raw
      // walk uses above for the same field.
      date: r.date || 'unknown',
      objectId: obj.objectId,
      objectName: obj.objectName || obj.objectId,
      objectType: obj.objectType,
      distanceLy: obj.distanceLy ?? null,
      ...stampedUrls(filePath, path.join(LIBRARY_DIR, filePath)),
      isProcessed: true,
      isEdited: r.notes === IMAGE_EDITOR_NOTE,
    });
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
  const linkedSig = linkedFilesSignature();
  let base: LibraryImageBase[];
  if (allImagesWalkCache && allImagesWalkCache.dir === LIBRARY_DIR && allImagesWalkCache.linkedSig === linkedSig && allImagesWalkCache.expiresAt > now) {
    base = allImagesWalkCache.entries;
  } else {
    base = walkAllLibraryImages(LIBRARY_DIR);
    allImagesWalkCache = { dir: LIBRARY_DIR, linkedSig, entries: base, expiresAt: now + ALL_IMAGES_WALK_TTL_MS };
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
  // Contained resolution, not `path.join(root, getFolderName(id))`: the folder
  // name falls back to the raw id on a DB miss, so a traversal id would list an
  // arbitrary directory and hand back paths outside the library.
  const objDir = resolveContainedObjectDir(objectId);
  if (!objDir) return [];
  const folderName = getFolderName(objectId);

  const results: Array<{ name: string; path: string; date: string; downloadUrl: string }> = [];
  const identity = resolverFor(objectId);

  // A purely linked object has no managed folder; it still has linked stacks below.
  const managedEntries = fs.existsSync(objDir) ? listObjectFiles(objDir, getObjectLayout(objectId)) : [];
  for (const entry of managedEntries) {
    const file = entry.fileName;
    const lower = file.toLowerCase();
    if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png')) continue;
    if (lower.includes('_thn.')) continue; // skip thumbnails
    if (file.startsWith('sky_') || file.startsWith('gallery_')) continue; // skip managed images
    if (isDwarfThumbnailPreviewName(file)) continue; // Dwarf's own redundant stacked_thumbnail.* preview
    if (isDwarfInternalArtifact(file)) continue; // Dwarf's own working artifacts (img_reference.*/img_stacked_counter.*), not a deliverable image

    const filePath = `${folderName}/${entry.relPath}`;
    results.push({
      name: file,
      path: filePath,
      date: identity.session(entry.relPath) || 'unknown',
      downloadUrl: `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(filePath)}`,
    });
  }

  // Linked stacks, so a linked object can pick its own image as the cover.
  for (const row of linkedGalleryRows(objectId)) {
    if (!/\.(jpe?g|png)$/i.test(row.fileName)) continue; // same formats as the managed list above
    results.push({
      name: row.fileName,
      path: row.relPath,
      date: row.date,
      downloadUrl: `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(row.relPath)}`,
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

/** The user's crop of the object's picture, or null. Only honoured while the
 *  image is user-chosen: an auto-picked image can change under a stale crop. */
export function getGalleryCrop(objectId: string): GalleryCrop | null {
  const row = stmts.getGalleryImage.get(objectId);
  return row?.galleryImageUserSet ? parseGalleryCrop(row.galleryCrop) : null;
}

/** Set (or clear, with null) the crop. Choosing a different image clears it
 *  (see the setGalleryImage* statements), since the old window means nothing
 *  on a new picture. */
export function setGalleryCrop(objectId: string, crop: GalleryCrop | null): void {
  stmts.setGalleryCrop.run(crop ? JSON.stringify(crop) : null, objectId);
}

/** Get the custom gallery image path for an object (null if none set). */
export function getGalleryImage(objectId: string): string | null {
  return getGalleryImageRow(objectId).galleryImage;
}

/** Set (or clear) the custom gallery image for an object (auto-assigned, not user-chosen). */
/** Fill an empty, auto-chosen cover. Used by reads; never replaces a cover that is already set or one the user chose. */
export function setAutoGalleryImage(objectId: string, imagePath: string): void {
  stmts.setAutoGalleryImage.run(imagePath, objectId);
}

/** Clear an auto-chosen cover. Used by reads; never clears a cover the user chose. */
export function clearAutoGalleryImage(objectId: string): void {
  stmts.clearAutoGalleryImage.run(objectId);
}

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

/** Resolve a stored `galleryImage` value to an absolute path, but only when it
 *  stays inside LIBRARY_DIR — or, since a gallery image is one of the
 *  legitimate "DB pointer to a file" cases, inside a linked source's own root
 *  when the value is an indexed `@src/...` path. `galleryImage` is set via PUT
 *  /objects/:objectId/gallery-image, which accepts any string in its request
 *  body — a value like "../../../../etc/passwd" would otherwise let
 *  resolveObjectImagePath hand back an arbitrary path. That return value
 *  reaches `sharp(srcPath)` on the *public* (auth-bypassed)
 *  /objects/:objectId/thumbnail route, so an unvalidated escape would be a
 *  read of arbitrary file content, not just a broken thumbnail (that route no
 *  longer deletes on a decode failure — see its own comment — but never
 *  serving an unvalidated path is still the point). Returns null (same as "no
 *  such file") rather than throwing, so this composes with
 *  resolveObjectImagePath's existing fallback-through-priority-tiers
 *  structure. Resolution + containment for both cases lives in
 *  fileResolver.ts now — see its header. */
function safeGalleryImagePath(galleryImage: string): string | null {
  return resolveLibraryFile(galleryImage)?.abs ?? null;
}

const CATALOG_SOURCE_SENTINEL_RE = /^catalog-source:(hubble|wiki|dss2)$/;

/** True for the `catalog-source:hubble|wiki|dss2` sentinel — a fixed set of
 *  literal values, not a filesystem path, so route-level path validation must
 *  let it through unchanged. */
export function isCatalogSourceSentinel(value: string): boolean {
  return CATALOG_SOURCE_SENTINEL_RE.test(value);
}

/** `catalog-source:hubble|wiki|dss2` sentinel → cached master path on disk. */
export function resolveCatalogSourceSentinel(value: string, resolvedId: string): string | null {
  const match = value.match(CATALOG_SOURCE_SENTINEL_RE);
  if (!match) return null;
  const source = match[1];
  const candidate = source === 'hubble' ? hubbleImagePath(resolvedId)
    : source === 'wiki' ? wikiImagePath(resolvedId)
    : imageCachePath(resolvedId);
  return fs.existsSync(candidate) ? candidate : null;
}

/** `catalog-source:hubble|wiki|dss2` sentinel → the bare source token, or null
 *  for anything that isn't the sentinel (a file path, an empty value). */
export function parseCatalogSourceSentinel(
  value: string | null | undefined,
): 'hubble' | 'wiki' | 'dss2' | null {
  const match = value?.match(CATALOG_SOURCE_SENTINEL_RE);
  if (!match) return null;
  const source = match[1];
  return source === 'hubble' || source === 'wiki' || source === 'dss2' ? source : null;
}

/**
 * The catalog-master source a user has explicitly pinned for an object via the
 * gallery image picker ("use this variant"), or null. Only a user-set
 * `catalog-source:*` value counts — an auto-assigned gallery image, or a pinned
 * personal file, is not a master-source preference.
 *
 * `/api/catalog/:id/image` consults this so the catalog browser renders the
 * same variant the object page does after the user picks one. It never causes a
 * 404: a pin naming a variant that isn't on disk falls through findCachedMaster's
 * normal priority.
 */
export function getPinnedCatalogSource(objectId: string): 'hubble' | 'wiki' | 'dss2' | null {
  const row = getGalleryImageRow(objectId);
  if (!row.userSet) return null;
  return parseCatalogSourceSentinel(row.galleryImage);
}

/**
 * Disk-cache key (basename, no extension) for an object's gallery thumbnail.
 *
 * The prewarm pass in import.ts and the `/objects/:id/thumbnail` route both
 * derive the cached JPEG's filename from this, so it MUST stay a single
 * function: a mismatch silently wastes the entire prewarm (the route recomputes
 * a different name and rerenders on first view). The sha256 hash also keeps the
 * name constant-length regardless of how long a Dwarf's device-folder path
 * runs, which a raw base64url of `path:WxH:mtime` did not (ENAMETOOLONG on
 * sharp's toFile → broken `<img>`).
 */
export function objectThumbnailDiskCacheKey(
  srcPath: string,
  width: number,
  height: number,
  mtimeMs: number,
  crop?: GalleryCrop | null,
): string {
  // The crop only joins the key when there is one, so an uncropped object keeps
  // the exact key the import-time prewarm already wrote.
  const c = crop ? `:crop${crop.x},${crop.y},${crop.zoom}${crop.rotated ? 'r' : ''}` : '';
  return createHash('sha256').update(`${srcPath}:${width}x${height}:${mtimeMs}${c}`).digest('base64url');
}

/** Default square size the `/library/file/thumbnail` route renders when the
 *  request carries no `w`/`h` — which is what every calendar / Nights card
 *  asks for. The session-thumbnail prewarm targets this size. */
export const FILE_THUMBNAIL_DEFAULT_SIZE = 400;

/**
 * Disk-cache key for a per-file thumbnail (`/library/file/thumbnail`).
 *
 * Keyed on the **library-relative** path string exactly as the route receives
 * it in `?path=`, not an absolute path (that is the difference from
 * {@link objectThumbnailDiskCacheKey}). The route and the session-thumbnail
 * prewarm both derive the cached JPEG's name from this, so it MUST stay one
 * function — a mismatch silently wastes the prewarm.
 */
export function fileThumbnailDiskCacheKey(
  relPath: string,
  width: number,
  height: number,
  mtimeMs: number,
): string {
  return createHash('sha256').update(`${relPath}:${width}x${height}:${mtimeMs}`).digest('base64url');
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
  theme: BuiltinArtTheme = 'dark',
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
    const art = parseBuiltinArtSentinel(row.galleryImage);
    if (art) return ensureBuiltinArtFile(art, theme);
    const sentinel = resolveCatalogSourceSentinel(row.galleryImage, resolvedId);
    if (sentinel) return sentinel;
    const abs = safeGalleryImagePath(row.galleryImage);
    if (abs && fs.existsSync(abs)) return abs;
    console.warn('[gallery] %s: userSet galleryImage=%s did not resolve (sentinel=%s, abs=%s); falling back to sky survey',
      objectId, row.galleryImage, row.galleryImage.startsWith('catalog-source:'), abs);
  }

  if (!preferSkySurvey && row.galleryImage) {
    const sentinel = resolveCatalogSourceSentinel(row.galleryImage, resolvedId);
    if (sentinel) return sentinel;
    const abs = safeGalleryImagePath(row.galleryImage);
    if (abs && fs.existsSync(abs)) return abs;
  }

  // A comet or asteroid has no catalog picture and no fixed sky position: asking Sesame, NASA or the sky survey can
  // only fail, slowly. Its own observation image (the galleryImage below) is the only thing it can show.
  if (isMovingObject(objectId)) {
    if (row.galleryImage) {
      const abs = safeGalleryImagePath(row.galleryImage);
      if (abs && fs.existsSync(abs)) return abs;
    }
    // The list call is what normally picks and stores an observation image, so a thumbnail request that lands first
    // (a cached list, a fresh import) finds the row empty. Pick one here too rather than answering 404.
    const fallback = findFallbackObservationImage(objectId);
    if (fallback) {
      stmts.setAutoGalleryImage.run(fallback, objectId);
      const abs = safeGalleryImagePath(fallback);
      if (abs && fs.existsSync(abs)) return abs;
    }
    return null;
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
    const abs = safeGalleryImagePath(row.galleryImage);
    if (abs && fs.existsSync(abs)) return abs;
  }

  return null;
}
