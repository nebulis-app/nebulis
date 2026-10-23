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
 * The alias map is read off server/data/dso-catalog.json: each record's id is
 * the canonical id and every other designation on it (Messier, NGC/IC,
 * Caldwell, Sharpless, Melotte, LBN, historical duplicate numbers) is an alias
 * of it. Only the Moon/Sun capture-mode names are listed here, since they are
 * not deep-sky objects. tests/backend/aliasResolution.test.ts pins the result.
 *
 * Note: a canonical id is a storage key. Changing which record a designation
 * sits on rekeys library objects and moves their files at the next boot (see
 * the alias migration in library/objects.ts), so a designation belongs on a
 * record only when it is the same physical object.
 */
import { DSO_RECORDS, displayDesignation, normalizeCatalogNumber } from './dsoCatalogData.js';

const collapse = (s: string): string => normalizeCatalogNumber(s) ?? s.toUpperCase().replace(/\s+/g, '');

/**
 * Different telescopes name the Moon and Sun differently (Dwarf uses
 * "Lunar"/"Solar" capture modes; Seestar uses "Moon"/"Sun").
 */
const MANUAL_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['LUNAR', 'Moon'],
  ['SOLAR', 'Sun'],
];

/** Maps normalised alias (uppercase, no spaces) → canonical ID string. */
const ALIASES: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const record of DSO_RECORDS) {
    for (const d of record.designations) {
      if (d === record.id) continue;
      const k = collapse(d);
      if (k && !m.has(k)) m.set(k, record.id);
    }
  }
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
  /^(?:SH2-\d+|(?:NGC|IC|CED|VDB|LBN|LDN|UGC|PGC|ARP|MEL|CR|STOCK|HCG|M|C|B)\d+[A-Z]?)$/;

/**
 * Fold a catalog designation into one canonical spelling: uppercase, no
 * spaces, no zero-padding after any catalog prefix, and the Sharpless form
 * written as "SH2-N". Idempotent, and a no-op for anything that is not a
 * catalog designation.
 *
 *   "ngc 224"      → "NGC224"
 *   "NGC0224"      → "NGC224"     "Mel022" → "MEL22"
 *   "Sh2-155" / "sharpless 155" → "SH2-155"
 *   "Caldwell 5"   → "C5"      "Messier 31" → "M31"
 *   "My Nebula"    → "My Nebula"  (unchanged)
 */
export function normalizeDesignation(id: string): string {
  return normalizeCatalogNumber(id) ?? id.trim();
}

/**
 * True when `id` (after the same case/space/prefix normalization
 * `normalizeDesignation` applies) is shaped like a bare catalog designation —
 * "IC4605", "ngc 7000", "Messier 31" — rather than free text. Used to gate a
 * rewrite on "this is provably a designation" instead of "this merely starts
 * like one", the same distinction `DESIGNATION_RE`'s doc comment above exists
 * to enforce.
 */
export function isDesignationShaped(id: string): boolean {
  return normalizeCatalogNumber(id) !== null;
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
  const alias = ALIASES.get(key);
  if (alias !== undefined) return alias;
  // Not an alias: a recognised designation still comes back normalized so
  // "ngc 224" and "NGC0224" key the same object; free text is left alone.
  // Checked first: an out-of-range number ("NGC2244389") also fits DESIGNATION_RE.
  const folded = foldDescriptiveName(id);
  if (folded) return resolveCanonicalId(folded);
  return DESIGNATION_RE.test(key) ? key : id;
}

/** The word after a designation that makes a name a variant of it (the same list normalizeCatalogId strips). */
const VARIANT_TAIL = /^(?:mosai[ck]|mosiac|panel|ha|oiii|sii|sho|hoo|rgb|lrgb|nb|narrowband|broadband|luminance|lum|bicolor|tricolor|hargb|photo|video)\d*$/i;

/** Highest number each catalog has, so a longer digit run cannot be a real designation. */
const MAX_CATALOG_NUMBER: Readonly<Record<string, number>> = { NGC: 7840, IC: 5386, M: 110 };

/**
 * The designation a free-text target name starts with, when the rest is only a
 * description or a stray number. Telescopes name targets "NGC 2244 Satellite
 * Cluster" or "10P Tempel"; left alone those became objects of their own that
 * never grouped with NGC 2244 or 10P.
 *
 *   "NGC2244SatelliteCluster", "NGC 2244 Satellite Cluster" → "NGC2244"
 *   "10PTempel", "161PHartley-IRAS"                        → "10P", "161P"
 *   "NGC2244389" (an out-of-range number: a frame count ran onto the name) → "NGC2244"
 *
 * Whole-string and strict, for the reason DESIGNATION_RE explains: the tail must
 * begin a new capitalised word, so "NGC7318A", "M31_mosaic" and "C2023A3" never
 * match. Returns null when the name is not of this shape.
 */
export function foldDescriptiveName(id: string): string | null {
  const s = id.trim().replace(/\s+/g, '');
  // An imaging variant ("M16Ha", "NGC7000Narrowband") is its own object, grouped under the base at display time; folding it onto
  // the base would merge two different pictures of one target.
  if (VARIANT_TAIL.test(s.replace(/^(?:NGC|IC|M|\d{1,4}P)\d*/i, ''))) return null;
  const periodic = s.match(/^(\d{1,4}P)(?=[A-Z][a-z])[A-Za-z][A-Za-z'-]*$/);
  if (periodic) return periodic[1];
  const named = s.match(/^(NGC|IC|M)(\d{1,4})(?=[A-Z][a-z])[A-Za-z][A-Za-z'-]*$/);
  if (named) {
    const max = MAX_CATALOG_NUMBER[named[1]];
    return Number(named[2]) >= 1 && Number(named[2]) <= max ? `${named[1]}${Number(named[2])}` : null;
  }
  // Six or seven digits: a four-digit number with a two or three digit count after it.
  const run = s.match(/^(NGC|IC)([1-9]\d{5,6})$/i);
  if (run) {
    const prefix = run[1].toUpperCase();
    const max = MAX_CATALOG_NUMBER[prefix];
    if (Number(run[2]) <= max) return null;
    // Longest leading number that is a real designation, leaving 2 or 3 stray digits.
    for (let len = Math.min(4, run[2].length - 2); len >= 1; len--) {
      const n = Number(run[2].slice(0, len));
      if (run[2].length - len <= 3 && n >= 1 && n <= max) return `${prefix}${n}`;
    }
  }
  return null;
}

/** Reverse map: canonical ID (uppercase) → all aliases that resolve to it. */
const REVERSE_ALIASES = new Map<string, string[]>();
for (const [alias, canonical] of ALIASES) {
  const c = canonical.toUpperCase();
  const list = REVERSE_ALIASES.get(c);
  if (list) list.push(alias);
  else REVERSE_ALIASES.set(c, [alias]);
}

/**
 * Return every alias that points at this canonical ID (Messier, NGC/IC,
 * Caldwell, Sharpless, Melotte, LBN, duplicate numbers), in display form:
 * 'C13', 'Sh2-298', 'Mel22'.
 */
export function getAliasesFor(canonicalId: string): string[] {
  const key = canonicalId.toUpperCase().replace(/\s+/g, '');
  return (REVERSE_ALIASES.get(key) ?? []).map(displayDesignation);
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
