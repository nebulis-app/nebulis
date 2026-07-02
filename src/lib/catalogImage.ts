/**
 * Shared DSS2 thumbnail sizing helper for catalog sky images.
 *
 * Mirrors `fovForEntry()` in server/lib/catalogPrefetch.ts exactly. Any
 * client code that wants to hit the disk-cached prefetch files must use
 * this helper to produce the same URL the server wrote.
 */

/**
 * Standard thumbnail dimensions for grid tiles, previews, and gallery cards.
 * The server resizes from a single master image once and caches the result on
 * disk — subsequent same-size requests are instant. Use one canonical pair so
 * the resize cache is hit on every tile render.
 */
const CATALOG_IMAGE_WIDTH = 384;
const CATALOG_IMAGE_HEIGHT = 384;

/**
 * Pick a DSS2 field of view that frames the object nicely.
 *
 * - Very small PNe / distant galaxies → 0.3° (minimum — prevents zoom so
 *   far in that DSS2 pixels become visible)
 * - Medium objects → size × 2.5 (shows context around the object)
 * - Large nebulae → 3° (capped because DSS2 resolution gets blotchy beyond)
 */
function fovForSize(majorAxisArcmin: number | null | undefined): number {
  if (majorAxisArcmin == null || !Number.isFinite(majorAxisArcmin)) return 1.0;
  const raw = (majorAxisArcmin / 60) * 2.5;
  return Math.max(0.3, Math.min(3.0, raw));
}

/**
 * Build the canonical catalog thumbnail URL for this object.
 *
 * If `majorAxisArcmin` is omitted, the URL leaves the fov query param off,
 * and the **server** auto-scales the FOV by looking up the catalog entry
 * and applying `fovForEntry()`. Either way, client + server land on the
 * same cache file the bulk prefetch wrote.
 *
 * Passing `majorAxisArcmin` explicitly is purely a short-circuit for
 * contexts where the client already has the value — it saves the server
 * a catalog lookup but produces the same URL either way.
 */
export function getCatalogThumbnailUrl(
  catalogId: string,
  majorAxisArcmin?: number | null,
  width: number = CATALOG_IMAGE_WIDTH,
  height: number = CATALOG_IMAGE_HEIGHT,
): string {
  const base = `/api/catalog/${encodeURIComponent(catalogId)}/image?w=${width}&h=${height}`;
  if (majorAxisArcmin == null) return base;
  return `${base}&fov=${fovForSize(majorAxisArcmin)}`;
}

/**
 * Direct static URL for the pre-generated DSS2 thumbnail. No routing overhead,
 * 30-day browser cache. Use this as the primary src on catalog grids and let the
 * API URL be the onError fallback (handles objects whose best source isn't dss2).
 */
export function getCatalogStaticThumbnailUrl(catalogId: string): string {
  const normalized = catalogId.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9_.-]/g, '_');
  return `/sky-cache/resized/${normalized}_dss2_${CATALOG_IMAGE_WIDTH}x${CATALOG_IMAGE_HEIGHT}.jpg`;
}

// ─── Per-source pinning ─────────────────────────────────────────────────
//
// A `galleryImage` value of `catalog-source:<source>` means "the user
// explicitly picked this cached master variant in the modal". Stored as a
// string sentinel rather than a separate DB column so no schema migration
// is needed — the colon makes it unambiguous against file paths under
// LIBRARY_DIR (which never contain colons).

type CatalogSourceId = 'hubble' | 'wiki' | 'dss2';

const SOURCE_SENTINEL_PREFIX = 'catalog-source:';

export function makeSourceSentinel(source: CatalogSourceId): string {
  return `${SOURCE_SENTINEL_PREFIX}${source}`;
}

export function parseSourceSentinel(value: string | null | undefined): CatalogSourceId | null {
  if (!value || !value.startsWith(SOURCE_SENTINEL_PREFIX)) return null;
  const s = value.slice(SOURCE_SENTINEL_PREFIX.length);
  return s === 'hubble' || s === 'wiki' || s === 'dss2' ? s : null;
}

/**
 * Build a thumbnail URL pinned to a specific cached master source.
 * Falls back through the default priority on the server if the requested
 * source isn't on disk, so this never produces a hard 404 for a wiped
 * variant — it just renders whatever else is cached.
 */
export function getCatalogSourceThumbnailUrl(
  catalogId: string,
  source: CatalogSourceId,
  width: number = CATALOG_IMAGE_WIDTH,
  height: number = CATALOG_IMAGE_HEIGHT,
): string {
  return `/api/catalog/${encodeURIComponent(catalogId)}/image`
    + `?w=${width}&h=${height}&source=${source}`;
}
