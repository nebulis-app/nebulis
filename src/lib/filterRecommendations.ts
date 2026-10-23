/**
 * Filter recommendations per deep-sky object type.
 *
 * Pure logic: this module answers "which filters suit this object?" and
 * returns stable keys. The human-readable labels and rationale sentences live
 * in `src/locales/<lang>/catalogs.json` under `filterRecommendations`, and are
 * resolved by `src/components/ui/FilterRecommendationPanel.tsx`.
 *
 * Keeping the copy out of here is deliberate. The app ships four languages
 * (see src/locales/CONTRIBUTING-TRANSLATIONS.md), so a table of English
 * sentences in a .ts file would be invisible both to translators and to
 * tests/frontend/i18nKeys.test.ts, which only checks literal `t()` calls.
 *
 * Each object type yields a pair of recommendations, one per rig:
 *   - color — OSC / DSLR / color camera
 *   - mono  — mono camera with a filter wheel
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The exhaustive set of recommendations this module can emit.
 *
 *   'no-filter'      — no filter at all; the type gains nothing from one
 *   'no-filter-lrgb' — broadband; no narrowband filter, shoot LRGB
 *   'ha-dual'        — Ha, or a dual-pass filter (L-Extreme, Duo-Band, …)
 *   'ha-oiii'        — Ha and OIII are both essential
 *   'sho'            — full SHO / Hubble palette (Ha + SII + OIII)
 *   'oiii-ha'        — OIII primary, Ha secondary
 *   'lrgb'           — standard LRGB
 *   'luminance'      — luminance / clear filter first
 */
export const FILTER_RECOMMENDATION_KEYS = [
  'no-filter',
  'no-filter-lrgb',
  'ha-dual',
  'ha-oiii',
  'sho',
  'oiii-ha',
  'lrgb',
  'luminance',
] as const;

export type FilterRecommendationKey = (typeof FILTER_RECOMMENDATION_KEYS)[number];

export interface FilterRecommendation {
  /** Recommendation for an OSC / DSLR / color-camera rig. */
  color: FilterRecommendationKey;
  /** Recommendation for a dedicated mono camera with a filter wheel. */
  mono: FilterRecommendationKey;
}

/**
 * Narrowing guard for a key that arrived from outside this module (an older or
 * newer server payload, a cached response). Without it, a key this build does
 * not know about would index into the panel's lookup tables and throw during
 * render instead of degrading to the generic broadband chip.
 */
export function isFilterRecommendationKey(value: unknown): value is FilterRecommendationKey {
  return (
    typeof value === 'string' &&
    (FILTER_RECOMMENDATION_KEYS as readonly string[]).includes(value)
  );
}

/** Broadband fallback for anything unrecognised — safe and non-committal. */
export const DEFAULT_FILTER_RECOMMENDATION: FilterRecommendation = {
  color: 'no-filter-lrgb',
  mono: 'lrgb',
};

/** A fresh copy of the default, so a caller that mutates the result of
 *  `filterRecommendations` cannot corrupt the shared constant for every
 *  later call. */
function broadbandDefault(): FilterRecommendation {
  return { ...DEFAULT_FILTER_RECOMMENDATION };
}

// ─── Per-type recommendation table ───────────────────────────────────────────

/**
 * Rules are matched case-insensitively by substring against the object's type
 * string, in array order — so more specific rules must come first. That is what
 * makes "Emission/Reflection Nebula" hit the hybrid rule before the plain
 * `emission` rule, and "Cluster + Nebula" hit the combined rule before the
 * generic `nebula` rule below it.
 *
 * The type strings this is written against are the real ones in the catalog
 * data (server/data/dso-catalog.json): "Emission Nebula", "Dark Nebula",
 * "Spiral Galaxy", "Cluster + Nebula", "Star Cloud", and so on.
 */
const RULES: ReadonlyArray<{
  /** Substrings to look for. All must appear when `mode` is `'all'`. */
  match: readonly string[];
  mode?: 'all' | 'any';
  color: FilterRecommendationKey;
  mono: FilterRecommendationKey;
}> = [
  // ── Emission + reflection hybrids ───────────────────────────────────────
  // e.g. "Emission/Reflection Nebula" — an Ha patch inside a blue reflection
  // complex, so the narrowband rule would throw away half the object.
  { match: ['emission', 'reflection'], mode: 'all', color: 'ha-dual', mono: 'ha-oiii' },

  // ── Cluster + nebula ────────────────────────────────────────────────────
  // The nebulosity is the point, so Ha wins over plain broadband.
  { match: ['cluster', 'nebula'], mode: 'all', color: 'ha-dual', mono: 'sho' },

  // ── Emission nebulae and HII regions ────────────────────────────────────
  // Classic hydrogen-alpha targets. On a color camera a dual-pass filter
  // doubles as light-pollution rejection and an Ha boost; a mono rig can use
  // the full SHO palette.
  { match: ['emission'], color: 'ha-dual', mono: 'sho' },

  // ── Reflection nebulae ──────────────────────────────────────────────────
  // Scattered blue starlight is a continuum source: a narrowband filter would
  // reject nearly all of it. Broadband is the only correct answer.
  { match: ['reflection'], color: 'no-filter-lrgb', mono: 'lrgb' },

  // ── Planetary nebulae ───────────────────────────────────────────────────
  // Driven by OIII, the dominant line; Ha picks up the outer envelope.
  { match: ['planetary'], color: 'ha-dual', mono: 'oiii-ha' },

  // ── Supernova remnants ──────────────────────────────────────────────────
  // Shock-excited filaments: OIII and Ha, with SII for the full palette.
  { match: ['supernova'], color: 'ha-dual', mono: 'sho' },

  // ── Dark nebulae ────────────────────────────────────────────────────────
  // A dark nebula is an absence of light, read as a silhouette against a rich
  // star field. It has no emission lines of its own, so a narrowband filter
  // would discard exactly the background stars the silhouette is defined by.
  // Broadband (LRGB) keeps them, and keeps the dust lane's true color.
  { match: ['dark'], color: 'no-filter-lrgb', mono: 'lrgb' },

  // ── Generic "Nebula" ────────────────────────────────────────────────────
  // Unqualified, so lean narrowband: most objects typed plainly "Nebula" in
  // the catalog are emission objects.
  { match: ['nebula'], color: 'ha-dual', mono: 'ha-oiii' },

  // ── Globular clusters ───────────────────────────────────────────────────
  // Resolving individual stars needs maximum bandwidth.
  { match: ['globular'], color: 'no-filter-lrgb', mono: 'lrgb' },

  // ── Open clusters ───────────────────────────────────────────────────────
  { match: ['open cluster'], color: 'no-filter-lrgb', mono: 'lrgb' },

  // ── Galaxies (all sub-types: spiral, barred, irregular, lenticular,
  //    starburst, group, pair, triplet …) ─────────────────────────────────
  // Broadband is standard. Ha genuinely helps face-on spirals with active
  // star formation (M51, M101), but that is target-specific rather than
  // type-level guidance.
  { match: ['galaxy'], color: 'no-filter-lrgb', mono: 'luminance' },

  // ── Star clouds / associations ──────────────────────────────────────────
  { match: ['star cloud', 'star association'], color: 'no-filter-lrgb', mono: 'lrgb' },

  // ── Double stars ────────────────────────────────────────────────────────
  // A filter only dims one component and shifts its color, which is the one
  // thing a double-star observation is trying to measure.
  { match: ['double star'], color: 'no-filter', mono: 'no-filter' },
];

/**
 * Return filter recommendations for an object type string.
 *
 * Matching is case-insensitive and substring-based, so variant labels
 * ("Emission/Reflection Nebula", "Barred Spiral Galaxy") resolve without an
 * exact-string table. Unrecognised, empty, null and undefined types all fall
 * through to the broadband default rather than throwing.
 */
export function filterRecommendations(objectType: string | null | undefined): FilterRecommendation {
  const type = (objectType ?? '').toLowerCase().trim();
  if (!type) return broadbandDefault();

  for (const rule of RULES) {
    const patterns = rule.match.map(p => p.toLowerCase());
    const matches =
      rule.mode === 'all'
        ? patterns.every(p => type.includes(p))
        : patterns.some(p => type.includes(p));
    if (matches) return { color: rule.color, mono: rule.mono };
  }

  return broadbandDefault();
}
