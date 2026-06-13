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
  /** Source URL for the curated description (set by build-catalog-curated.mjs). */
  wikiUrl?: string | null;
  /** Major axis in arcminutes. Mirrors client src/types/index.ts CatalogEntry. */
  majorAxisArcmin?: number | null;
  /** Formatted angular size string, e.g. "13.2' x 7.9'" (arcminutes). */
  size?: string | null;
}
