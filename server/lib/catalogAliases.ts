/**
 * Canonical ID resolution for cross-catalog aliases.
 *
 * Every object has exactly one canonical ID — the "most primary" designation
 * across all catalog tiers. All image files and catalogCache rows are keyed
 * under the canonical ID so lookups always hit regardless of which alias the
 * caller provides.
 *
 * Priority: M# > NGC#/IC# > Sh2-N > C# (Caldwell resolves to NGC/IC)
 *
 * The alias map is DERIVED, not hand-written: the ~110 NGC→Messier entries
 * come from OpenNGC's own `messier` cross-references, the ~107 Caldwell entries
 * from CALDWELL_TO_NGC, and the Sharpless entries from the Sharpless catalog's
 * ngcRef / messierRef. Only the genuinely non-derivable cases are listed by
 * hand in MANUAL_ALIASES. tests/backend/aliasResolution.test.ts pins the
 * result against a snapshot of the old hand-written map.
 *
 * Note: M24 (Sagittarius Star Cloud), M40 (Winnecke 4), and M45 (Pleiades)
 * have no NGC/IC designations so no alias is needed for them.
 */
import openNgcJson from '../data/openngc.json';
import { CALDWELL_TO_NGC } from './caldwellCatalog.js';
import { SHARPLESS_CATALOG } from './sharplessCatalog.js';

const collapse = (s: string): string =>
  s.toUpperCase().replace(/\s+/g, '').replace(/^(NGC|IC)0*(\d)/, '$1$2');

/**
 * Genuinely non-derivable aliases. Each earns its place:
 *  - C9 (Cave Nebula) has no NGC/IC designation and shares its position with
 *    Sh2-155, which outranks Caldwell.
 *  - M102 is a historical dispute; NGC 5866 (Spindle Galaxy) is the modern
 *    consensus identification.
 *  - IC 2118 and NGC 1909 are both in live use for the Witch Head Nebula.
 *  - Different telescopes name the Moon and Sun differently (Dwarf uses
 *    "Lunar"/"Solar" capture modes; Seestar uses "Moon"/"Sun").
 */
const MANUAL_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['C9', 'SH2-155'],
  ['M102', 'NGC5866'],
  ['NGC1909', 'IC2118'],
  ['LUNAR', 'Moon'],
  ['SOLAR', 'Sun'],
];

/** Maps normalised alias (uppercase, no spaces) → canonical ID string. */
const ALIASES: Map<string, string> = (() => {
  const m = new Map<string, string>();
  const put = (alias: string, canonical: string) => {
    const k = collapse(alias);
    if (k && !m.has(k)) m.set(k, canonical);
  };

  // NGC/IC → Messier, from OpenNGC's own `messier` cross-references. A Messier
  // row's ngcName is its primary NGC number; designation-shaped commonNames
  // carry secondary ones (M76's row lists both NGC650 and NGC651).
  if (Array.isArray(openNgcJson)) {
    for (const row of openNgcJson as Array<Record<string, unknown>>) {
      if (!row || typeof row !== 'object' || row.messier == null) continue;
      const mId = `M${row.messier as string | number}`;
      // Only NGC/IC-shaped cross-refs. Some rows carry ngcName "M040" or
      // "Mel022" (Melotte), which are not useful "also known as" designations.
      const refs = [row.ngcName, ...((row.commonNames as string[] | undefined) ?? [])];
      for (const ref of refs) {
        if (typeof ref === 'string' && /^(NGC|IC)\d/.test(collapse(ref))) put(ref, mId);
      }
    }
  }

  // Sharpless → Messier / NGC / IC, from the Sharpless catalog's cross-refs.
  // Messier wins over NGC when both are present (same physical nebula).
  for (const e of SHARPLESS_CATALOG) {
    if (e.messierRef) put(e.id, collapse(e.messierRef));
    else if (e.ngcRef) put(e.id, collapse(e.ngcRef));
  }

  // Caldwell C# → NGC/IC, from the Caldwell catalog. C9/C41/C99 are absent
  // there by design (no NGC/IC, or already keyed by C-number in OpenNGC).
  for (const [num, ngc] of Object.entries(CALDWELL_TO_NGC)) put(`C${num}`, ngc);

  for (const [alias, canonical] of MANUAL_ALIASES) m.set(collapse(alias), canonical);

  return m;
})();

/**
 * Catalog designations that `normalizeDesignation` / `resolveCanonicalId`
 * recognise. Anything not matching this shape (custom object names, comet
 * designations like "C-2023 A3", free text) is returned untouched.
 *
 * This is a WHOLE-STRING match, not a prefix match. "M31" is a designation;
 * "M31_mosaic", "M31_Ha", "NGC2244SatelliteCluster" are variant/custom names
 * that merely start like one. A prefix match here silently uppercased the whole
 * string (`M31_mosaic` → `M31_MOSAIC`), which rekeyed a live library object and
 * orphaned its files. The optional single trailing letter covers component
 * designations such as NGC7318A / NGC7318B; anything past that (another letter,
 * an underscore, a word) means it is not a bare designation.
 */
const DESIGNATION_RE =
  /^(?:SH2-\d+|(?:NGC|IC|CED|VDB|LBN|LDN|UGC|PGC|ARP|MEL|STOCK|HCG|M|C|B)\d+[A-Z]?)$/;

/**
 * Fold a catalog designation into one canonical spelling: uppercase, no
 * spaces, no zero-padding after an NGC/IC prefix, and the Sharpless form
 * written as "SH2-N". Idempotent, and a no-op for anything that is not a
 * catalog designation.
 *
 *   "ngc 224"      → "NGC224"
 *   "NGC0224"      → "NGC224"
 *   "Sh2-155" / "sharpless 155" → "SH2-155"
 *   "Caldwell 5"   → "C5"      "Messier 31" → "M31"
 *   "My Nebula"    → "My Nebula"  (unchanged)
 */
export function normalizeDesignation(id: string): string {
  let s = id.trim().toUpperCase().replace(/\s+/g, '');
  s = s
    .replace(/^SHARPLESS-?/, 'SH2-')
    .replace(/^SH2-?(\d)/, 'SH2-$1')
    .replace(/^CALDWELL-?(\d)/, 'C$1')
    .replace(/^MESSIER-?(\d)/, 'M$1')
    .replace(/^BARNARD-?(\d)/, 'B$1');
  if (!DESIGNATION_RE.test(s)) return id.trim();
  // Collapse zero-padding: "NGC0224" → "NGC224", "IC0405" → "IC405".
  s = s.replace(/^(NGC|IC)0*(\d)/, '$1$2');
  return s;
}

/**
 * Resolve any catalog alias to its canonical ID.
 *
 * Canonical means: the single ID under which images and descriptions are
 * stored on disk and in catalogCache. A recognised designation always comes
 * back in canonical spelling (see `normalizeDesignation`); anything that is
 * not a designation is returned unchanged.
 */
export function resolveCanonicalId(id: string): string {
  const key = normalizeDesignation(id).toUpperCase().replace(/\s+/g, '');
  if (ALIASES.has(key)) return ALIASES.get(key)!;
  // Not an alias: a recognised designation still comes back normalized so
  // "ngc 224" and "NGC0224" key the same object; free text is left alone.
  return DESIGNATION_RE.test(key) ? key : id;
}

/** Reverse map: canonical ID (uppercase) → all aliases that resolve to it. */
const REVERSE_ALIASES = new Map<string, string[]>();
for (const [alias, canonical] of ALIASES) {
  const c = canonical.toUpperCase();
  if (!REVERSE_ALIASES.has(c)) REVERSE_ALIASES.set(c, []);
  REVERSE_ALIASES.get(c)!.push(alias);
}

/**
 * Return all Caldwell/Sharpless alias strings that point at this canonical ID.
 * Returns human-readable forms: 'C13', 'Sh2-298', etc.
 */
export function getAliasesFor(canonicalId: string): string[] {
  const key = canonicalId.toUpperCase().replace(/\s+/g, '');
  return (REVERSE_ALIASES.get(key) ?? []).map(a =>
    a.startsWith('SH2-') ? `Sh2-${a.slice(4)}` : a,
  );
}

/** All known aliases that map to the given canonical ID (e.g. "NGC7331" → ["C30"]). */
export function getAliasesForCanonical(canonicalId: string): string[] {
  return getAliasesFor(canonicalId);
}

/**
 * Apply the user's catalog-nomenclature preference to a canonical ID, for
 * naming purposes only (folder names, not the on-disk/DB canonical key).
 *
 * When `preferCaldwell` is set and the canonical ID has a Caldwell alias
 * (e.g. "IC342" ← "C5"), returns the Caldwell form instead. Otherwise returns
 * the canonical ID unchanged. Callers must keep using the canonical ID (from
 * `resolveCanonicalId`) as the dedup/storage key; only the folder name should
 * use this preference.
 */
export function applyCatalogPreference(canonicalId: string, preferCaldwell: boolean): string {
  if (!preferCaldwell) return canonicalId;
  const caldwellAlias = getAliasesFor(canonicalId).find(a => /^C\d+$/.test(a));
  return caldwellAlias ?? canonicalId;
}

/**
 * Expand a search term to include its normalized designation, canonical ID,
 * and every known alias. So "C30", "caldwell 30", "NGC 7331" and "ngc7331"
 * all resolve to the same object, and "NGC6611" also matches "M16".
 * Returns unique terms; the original term is always first.
 */
export function expandSearchAliases(term: string): string[] {
  const raw = term.trim();
  const terms = new Set<string>([raw]);

  const normalized = normalizeDesignation(raw);
  if (normalized !== raw) terms.add(normalized);

  const canonical = resolveCanonicalId(raw);
  if (canonical !== raw) terms.add(canonical);

  for (const alias of getAliasesForCanonical(canonical)) {
    terms.add(alias);
    // Also the collapsed form ("Sh2-155" → "SH2-155") so id equality checks hit.
    terms.add(normalizeDesignation(alias));
  }
  return Array.from(terms);
}
