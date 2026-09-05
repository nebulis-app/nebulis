/**
 * Result status for a cached catalog description.
 *
 * Single source of truth for the `catalogCache.status` column (server/lib/db.ts):
 * `CatalogCacheRow` in catalogPrefetch.ts and the pack `descriptions.json` schema
 * in catalogPack/manifest.ts both derive from this. The pack installer writes a
 * description entry's status straight into catalogCache
 * (catalogPack/install.ts), so the two must never drift apart.
 *
 * Kept in this dependency-free module on purpose: catalogPack/manifest.ts is
 * imported at the top of scripts/build-catalog-pack.ts before DATA_DIR is set,
 * so it must not pull in catalogPrefetch.ts (which opens the SQLite DB).
 */
export const CATALOG_DESCRIPTION_STATUSES = ['ok', 'not_found', 'error'] as const;
export type CatalogDescriptionStatus = (typeof CATALOG_DESCRIPTION_STATUSES)[number];

export interface CatalogEntry {
  id: string;
  name: string;
  type: string;
  constellation: string;
  magnitude?: number;
  description: string;
  ra?: string;
  dec?: string;
  distanceLy?: number;
  /** Source URL for the curated description (e.g. the object's Wikipedia page). */
  wikiUrl?: string | null;
  /** Major axis in arcminutes. Mirrors client src/types/index.ts CatalogEntry. */
  majorAxisArcmin?: number | null;
  /** Formatted angular size string, e.g. "13.2' x 7.9'" (arcminutes). */
  size?: string | null;
  /** Other designations for this object: NGC cross-refs, Caldwell, Sharpless, common names. */
  alsoKnownAs?: string[];
}
