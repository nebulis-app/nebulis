/**
 * Normalized search + display-name helpers for DSO catalog entries.
 *
 * Handles common matching gotchas:
 *   - Leading zeros in NGC/IC names (NGC0224 ↔ NGC224)
 *   - Whitespace variance (M 42 ↔ M42)
 *   - Case insensitivity
 *   - Messier-number-only queries ("42" finds M42)
 *
 * And suppresses "fake" common names like `"Messier 42"` so they don't
 * clutter the UI next to the short identifier.
 */

interface SearchableEntry {
  id: string;
  ngcName: string;
  name: string;
  constellation: string | null;
  commonNames: string[];
  /** Optional — not present on PlannerTarget, only on DsoEntry. */
  messier?: number | null;
}

/**
 * Canonical form for substring search: lowercase, strip spaces, and collapse
 * leading zeros after an alpha prefix (so "NGC0224" and "NGC 224" normalize
 * to the same string). Digit-only queries pass through unchanged.
 */
export function normalizeSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/([a-z])0+(\d)/g, '$1$2');
}

/**
 * Substring-match a query against every indexable field of a DSO entry.
 * Both sides are passed through {@link normalizeSearch} so e.g. "ngc224",
 * "NGC 0224" and "224" all match "NGC0224".
 */
export function matchesSearch(entry: SearchableEntry, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;

  const fields: string[] = [
    entry.id,
    entry.ngcName,
    entry.name,
    entry.constellation ?? '',
    ...entry.commonNames,
  ];

  if (entry.messier != null) {
    fields.push(`M${entry.messier}`);
    fields.push(String(entry.messier));
  }

  for (const field of fields) {
    if (normalizeSearch(field).includes(q)) return true;
  }
  return false;
}

/**
 * A `name` field is a "real" common name if it doesn't match any known
 * catalog-identifier pattern. Regex covers: Messier, M, NGC, IC, UGC, PGC,
 * ESO, Sharpless/Sh2, Melotte, Collinder, Abell, Palomar, Terzan, vdB, LDN,
 * LBN, Ced, PK, Caldwell, Hickson, Arp, VV, DDO, Mrk. Each allows digits,
 * dashes, and letter suffixes ("NGC4565A", "Sh2-155", "M40").
 */
const CATALOG_ID_RE =
  /^(messier|m|ngc|ic|ugc|pgc|eso|sh\s*2?|sharpless|mel|cr|abell|palomar|terzan|vdb|ldn|lbn|ced|pk|caldwell|hickson|arp|vv|ddo|mrk)\s*[-\d]+[a-z]?\s*$/i;

function isCatalogIdName(name: string): boolean {
  return CATALOG_ID_RE.test(name.trim());
}

/**
 * Resolve the display names for a catalog entry.
 *
 * `short` is always the short scientific identifier (M42, NGC7000, IC434) —
 * the large label shown in the row. `common` is the human-friendly name only
 * if one exists; returns `null` for entries whose `name` is just a catalog
 * identifier placeholder (e.g. `"Messier 40"` when the real Messier 40 has
 * no common name).
 */
/**
 * Format an object's display title as "M104 (Sombrero Galaxy)" — scientific
 * ID first, common name in parentheses only when it differs from the ID.
 *
 * @param catalogId  The catalog/scientific identifier (e.g. "M 104", "NGC4594")
 * @param objectName The stored display/common name (e.g. "Sombrero Galaxy")
 * @param fallback   Used when both above are absent (typically the raw objectId)
 */
export function formatObjectTitle(
  catalogId: string | null | undefined,
  objectName: string | null | undefined,
  fallback: string
): string {
  const short = (catalogId || fallback).toUpperCase().replace(/\s+/g, '');
  const common = (objectName || '').trim();

  if (!common) return short;
  if (common.toUpperCase().replace(/\s+/g, '') === short) return short;
  if (isCatalogIdName(common)) return short;

  return `${short} (${common})`;
}
