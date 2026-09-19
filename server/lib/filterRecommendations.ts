/**
 * Filter recommendations per DSO object type — server-side copy.
 *
 * Logic is identical to src/lib/filterRecommendations.ts.  The two live in
 * separate compilation roots (server/ vs src/), so they cannot import from
 * each other — same duplication pattern this codebase already uses for e.g.
 * ProcessingStatus (server/lib/library/objects.ts) vs
 * src/lib/processingStatus.ts, or TYPE_CODE_BY_LABEL in dsoCatalog.ts.
 *
 * If you update the rules here, keep src/lib/filterRecommendations.ts in sync.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

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
  color: FilterRecommendationKey;
  mono: FilterRecommendationKey;
}

// ─── Per-type recommendation table ───────────────────────────────────────────

// More-specific (mode:'all') rules first — same ordering as
// src/lib/filterRecommendations.ts; keep the two in sync.
const RULES: Array<{
  match: string[];
  mode?: 'all' | 'any';
  color: FilterRecommendationKey;
  mono: FilterRecommendationKey;
}> = [
  { match: ['emission', 'reflection'], mode: 'all', color: 'ha-dual',        mono: 'ha-oiii' },
  { match: ['cluster', 'nebula'],      mode: 'all', color: 'ha-dual',        mono: 'sho' },
  { match: ['emission'],                             color: 'ha-dual',        mono: 'sho' },
  { match: ['reflection'],                           color: 'no-filter-lrgb', mono: 'lrgb' },
  { match: ['planetary'],                            color: 'ha-dual',        mono: 'oiii-ha' },
  { match: ['supernova'],                            color: 'ha-dual',        mono: 'sho' },
  { match: ['dark'],                                 color: 'ha-dual',        mono: 'ha-oiii' },
  { match: ['nebula'],                               color: 'ha-dual',        mono: 'ha-oiii' },
  { match: ['globular'],                             color: 'no-filter-lrgb', mono: 'lrgb' },
  { match: ['open cluster'],                         color: 'no-filter-lrgb', mono: 'lrgb' },
  { match: ['galaxy'],                               color: 'no-filter-lrgb', mono: 'luminance' },
  { match: ['star cloud', 'star association', '*ass'], color: 'no-filter-lrgb', mono: 'lrgb' },
  { match: ['double star', '**'],                    color: 'no-filter',      mono: 'no-filter' },
];

/**
 * Return filter recommendations for a given object type string
 * (case-insensitive).  Falls back to a broadband default for unknown types.
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

  return { color: 'no-filter-lrgb', mono: 'lrgb' };
}
