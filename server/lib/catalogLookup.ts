// The one place app code reads a catalog entry. It layers the user's
// overrides (catalogOverrides table) over the static catalog in server/data,
// which stays free of any database dependency.

import { getBaseCatalogEntry } from '../data/catalog.js';
import { mergeOverride, entryFromOverride } from './catalogOverrides.js';
import type { CatalogEntry } from './types/catalog.js';

export type { CatalogEntry };
export { searchCatalog, getAllCatalogEntries, getAlsoKnownAs, findCatalogEntryByExactName } from '../data/catalog.js';

/**
 * Get a catalog entry by ID. Checks curated entries first (which have
 * descriptions), then falls back to the comprehensive OpenNGC database.
 *
 * User overrides are layered on top: any non-null override field wins over the
 * static source. If no static entry exists but an override row does, a
 * synthetic entry is returned. This is how users add objects the bundled
 * catalogs don't know about.
 */
export function getCatalogEntry(id: string): CatalogEntry | undefined {
  const base = getBaseCatalogEntry(id);
  if (base) return mergeOverride(base, id);
  return entryFromOverride(id);
}
