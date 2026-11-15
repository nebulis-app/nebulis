/**
 * Explore's catalog filter: "show me the IC objects". A catalog here is a designation family, and an object belongs
 * to it when ANY of its designations is in the family. The storage id is only one of them (a record's id is M, then
 * NGC/IC, then Sh2, then C), so IC405's id is IC405 but it is also Caldwell 31 and Sh2-229, and M31 is also NGC 224.
 * Matching on the id alone would leave the Messier objects out of NGC and the Caldwell objects out of Caldwell.
 */
import { designationsFor, type DsoEntry } from '../dsoCatalog.js';

export const EXPLORE_CATALOG_IDS = ['messier', 'ngc', 'ic', 'caldwell', 'sharpless'] as const;
export type ExploreCatalogId = (typeof EXPLORE_CATALOG_IDS)[number];

export function isExploreCatalogId(v: string): v is ExploreCatalogId {
  return (EXPLORE_CATALOG_IDS as readonly string[]).includes(v);
}

const FAMILY: Record<ExploreCatalogId, RegExp> = {
  messier: /^M\d/i,
  ngc: /^NGC\d/i,
  ic: /^IC\d/i,
  caldwell: /^C\d/i,
  sharpless: /^SH2-?\d/i,
};

/** Which catalogs an entry belongs to, computed once per entry. */
const membership = new Map<string, ReadonlySet<ExploreCatalogId>>();

export function catalogsOf(entry: DsoEntry): ReadonlySet<ExploreCatalogId> {
  const known = membership.get(entry.id);
  if (known) return known;
  const designations = [entry.id, ...designationsFor(entry)];
  const found = new Set<ExploreCatalogId>();
  for (const id of EXPLORE_CATALOG_IDS) {
    if (designations.some(d => FAMILY[id].test(d))) found.add(id);
  }
  membership.set(entry.id, found);
  return found;
}

export function inCatalog(entry: DsoEntry, catalog: ExploreCatalogId | undefined): boolean {
  return catalog === undefined || catalogsOf(entry).has(catalog);
}

/** The number and any letter suffix a designation carries in a catalog: `M31` is 31, `NGC1976A` is 1976 + "A". */
const NUMBERED: Record<ExploreCatalogId, RegExp> = {
  messier: /^M(\d+)([A-Za-z]?)$/i,
  ngc: /^NGC(\d+)([A-Za-z]?)$/i,
  ic: /^IC(\d+)([A-Za-z]?)$/i,
  caldwell: /^C(\d+)([A-Za-z]?)$/i,
  sharpless: /^SH2-?(\d+)([A-Za-z]?)$/i,
};

const numberCache = new Map<string, readonly [number, string]>();

/**
 * Where an entry sits in a catalog's own numbering, as a sortable pair. With no catalog, the number is the one in
 * the entry's own id, so a list that mixes catalogs still runs in a stable, numbered order. An entry with no number
 * in the catalog sorts last.
 */
export function catalogNumber(entry: DsoEntry, catalog: ExploreCatalogId | undefined): readonly [number, string] {
  const key = `${catalog ?? '*'}|${entry.id}`;
  const known = numberCache.get(key);
  if (known) return known;
  let found: readonly [number, string] = [Number.POSITIVE_INFINITY, ''];
  const candidates = catalog ? [entry.id, ...designationsFor(entry)] : [entry.id];
  const patterns = catalog ? [NUMBERED[catalog]] : Object.values(NUMBERED);
  outer: for (const d of candidates) {
    for (const re of patterns) {
      const m = re.exec(d.replace(/\s+/g, ''));
      if (m) { found = [Number(m[1]), (m[2] ?? '').toUpperCase()]; break outer; }
    }
  }
  numberCache.set(key, found);
  return found;
}
