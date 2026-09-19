/**
 * Filter recommendations per DSO object type.
 *
 * Provides opinionated, astro-community-standard guidance for:
 *  - COLOUR rigs (OSC/DSLR/colour camera) — which filters to reach for
 *  - MONO rigs (mono camera with filter wheel) — which filter set gives the
 *    most science/art per clear hour
 *
 * Intentionally kept as a pure-logic module (no JSX) so it can be imported by
 * server-side routes without pulling in any React dependency.  The companion
 * `FilterRecommendationBadge.tsx` component owns rendering.
 *
 * Recommendation keys map to human-readable labels and a concise rationale
 * shown in the tooltip.  A null colour or mono recommendation means the type
 * does not apply (e.g. double stars don't benefit from any filter).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The exhaustive set of filter recommendations Nebulis can emit.
 *
 * 'no-filter'        — No filter needed; broadband LRGB or white-light
 * 'no-filter-lrgb'   — No filter; broadband LRGB gives the best colour rendition
 * 'ha-dual'          — Ha or a dual narrowband pass (L-Extreme, Duo-Band, etc.)
 * 'ha-oiii'          — Ha and OIII both essential (classic narrowband pair)
 * 'sho'              — Full SHO / Hubble palette (Ha + SII + OIII)
 * 'oiii-ha'          — OIII primary, Ha secondary (PN / SNR emphasis)
 * 'lrgb'             — Standard LRGB (galaxies, star clusters, reflection nebulae)
 * 'luminance'        — Luminance / clear filter priority (galaxies in LP skies)
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

export interface FilterRecommendationMeta {
  label: string;
  /** Short label for tight UI contexts (badges, chips). */
  short: string;
  /** One-sentence rationale shown in a tooltip. */
  rationale: string;
}

/** Display metadata for every recommendation key. */
export const FILTER_RECOMMENDATION_META: Record<FilterRecommendationKey, FilterRecommendationMeta> = {
  'no-filter': {
    label: 'No filter',
    short: 'None',
    rationale: 'No filter needed — the signal is broad-spectrum; a filter would only cut throughput.',
  },
  'no-filter-lrgb': {
    label: 'No filter — broadband LRGB',
    short: 'LRGB',
    rationale: 'No filter needed; broadband LRGB gives the best colour rendition for this object type.',
  },
  'ha-dual': {
    label: 'Ha or dual narrowband',
    short: 'Ha / Dual-NB',
    rationale:
      'Ha boosts emission detail; a dual-pass filter (L-Extreme, Duo-Band, etc.) works well for one-shot-colour rigs under light pollution.',
  },
  'ha-oiii': {
    label: 'Ha and OIII essential',
    short: 'Ha + OIII',
    rationale: 'Both Ha and OIII lines carry significant emission; pairing them unlocks the full two-colour structure.',
  },
  'sho': {
    label: 'SHO (Hubble palette)',
    short: 'SHO',
    rationale:
      'SII, Ha, and OIII each reveal distinct structures in this object — the Hubble palette makes the most of all three.',
  },
  'oiii-ha': {
    label: 'OIII primary, Ha secondary',
    short: 'OIII + Ha',
    rationale:
      'OIII dominates (planetary nebulae / SNRs are rich in doubly-ionised oxygen); add Ha for the envelope and filaments.',
  },
  'lrgb': {
    label: 'Broadband LRGB',
    short: 'LRGB',
    rationale: 'Standard LRGB — luminance for resolution, RGB for true colour; narrowband adds little for this type.',
  },
  'luminance': {
    label: 'Luminance / clear filter',
    short: 'Lum',
    rationale:
      'Luminance or clear filter first for detail; add narrowband (Ha, OIII) only if light pollution is severe or you want extra contrast.',
  },
};

// ─── Per-type recommendation table ───────────────────────────────────────────

export interface FilterRecommendation {
  /** Recommendation for an OSC/DSLR or colour-camera rig. */
  color: FilterRecommendationKey;
  /** Recommendation for a dedicated mono camera with filter wheel. */
  mono: FilterRecommendationKey;
}

/**
 * Object-type strings that map to a narrowband-heavy recommendation.
 * Matched case-insensitively and by substring so partial / variant labels
 * ("Emission/Reflection Nebula", "HII Region", etc.) still resolve correctly.
 */
const RULES: Array<{
  /** Substring patterns — all must appear (AND) or at least one (OR, default). */
  match: string[];
  mode?: 'all' | 'any';
  color: FilterRecommendationKey;
  mono: FilterRecommendationKey;
}> = [
  // ── Rules with mode:'all' (more specific) come first ────────────────────
  // This ensures "Emission/Reflection Nebula" hits the hybrid rule before the
  // plain 'emission' rule, and "Cluster + Nebula" hits the combined rule
  // before the plain 'nebula' rule.

  // ── Emission/Reflection hybrids ─────────────────────────────────────────
  // e.g. "Emission/Reflection Nebula" — Ha patch + reflection component.
  {
    match: ['emission', 'reflection'],
    mode: 'all',
    color: 'ha-dual',
    mono: 'ha-oiii',
  },
  // ── Cluster + Nebula ────────────────────────────────────────────────────
  // The nebulosity matters — Ha wins over plain broadband.
  {
    match: ['cluster', 'nebula'],
    mode: 'all',
    color: 'ha-dual',
    mono: 'sho',
  },

  // ── Single-term rules (more general) ────────────────────────────────────

  // ── Emission nebulae & HII regions ──────────────────────────────────────
  // Classic hydrogen-alpha targets.  On a colour camera a dual-pass filter
  // (L-Extreme, Duo-Band) doubles as LP rejection + Ha boost.  Mono rigs
  // benefit from the full SHO palette whenever the object is large enough.
  {
    match: ['emission'],
    color: 'ha-dual',
    mono: 'sho',
  },
  // ── Reflection nebulae ──────────────────────────────────────────────────
  // Scattered blue starlight — filters reduce signal; broadband is king.
  {
    match: ['reflection'],
    color: 'no-filter-lrgb',
    mono: 'lrgb',
  },
  // ── Planetary nebulae ───────────────────────────────────────────────────
  // Driven by OIII (the dominant line); Ha reveals the outer envelope.
  // Smart-telescope note: these are typically small — mosaic rarely needed.
  {
    match: ['planetary'],
    color: 'ha-dual',
    mono: 'oiii-ha',
  },
  // ── Supernova remnants ──────────────────────────────────────────────────
  // Shockwave plasma: OIII + Ha / SII filaments.
  {
    match: ['supernova'],
    color: 'ha-dual',
    mono: 'sho',
  },
  // ── Dark nebulae ────────────────────────────────────────────────────────
  // Imaged by contrast against a rich background (Milky Way / emission).
  // Ha or SHO on the background field shows the dusty lane; broadband works
  // equally well for a widefield dark-lane shot.
  {
    match: ['dark'],
    color: 'ha-dual',
    mono: 'ha-oiii',
  },
  // ── Generic / unnamed nebulae ───────────────────────────────────────────
  // When the type is simply "Nebula", lean narrowband as a safe default.
  {
    match: ['nebula'],
    color: 'ha-dual',
    mono: 'ha-oiii',
  },
  // ── Globular clusters ───────────────────────────────────────────────────
  // Dense star balls — resolving individual stars needs maximum bandwidth.
  {
    match: ['globular'],
    color: 'no-filter-lrgb',
    mono: 'lrgb',
  },
  // ── Open clusters ───────────────────────────────────────────────────────
  {
    match: ['open cluster'],
    color: 'no-filter-lrgb',
    mono: 'lrgb',
  },
  // ── Galaxies (all sub-types) ─────────────────────────────────────────────
  // Broadband is the standard; a luminance filter can help in LP skies.
  // Ha has real value for face-on spirals with active star formation (M51,
  // M101), but that is target-specific, not type-level guidance.
  {
    match: ['galaxy'],
    color: 'no-filter-lrgb',
    mono: 'luminance',
  },
  // ── Star clouds / associations ──────────────────────────────────────────
  {
    match: ['star cloud', 'star association', '*ass'],
    color: 'no-filter-lrgb',
    mono: 'lrgb',
  },
  // ── Double stars ────────────────────────────────────────────────────────
  {
    match: ['double star', '**'],
    color: 'no-filter',
    mono: 'no-filter',
  },
];

/**
 * Return filter recommendations for a given object type string (case-insensitive).
 * Falls back to a broadband default for unrecognised types.
 */
export function filterRecommendations(objectType: string | null | undefined): FilterRecommendation {
  const type = (objectType ?? '').toLowerCase().trim();

  for (const rule of RULES) {
    const patterns = rule.match.map(p => p.toLowerCase());
    const matches =
      rule.mode === 'all'
        ? patterns.every(p => type.includes(p))
        : patterns.some(p => type.includes(p));
    if (matches) return { color: rule.color, mono: rule.mono };
  }

  // Unknown / "Other" — default to broadband LRGB (safe, non-committal)
  return { color: 'no-filter-lrgb', mono: 'lrgb' };
}
