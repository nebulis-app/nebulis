export interface LibraryObjectFilter {
  id: string;
  label: string;
  matchTypes: string[];
  matchMode?: 'exact' | 'contains';
}

/**
 * Types that place an object inside the solar system.
 *
 * `Star` is deliberately absent. It used to be here, which filed every object
 * typed `Star` under the Solar System chip: true only of the Sun, and wrong for
 * anything else that carries the type. Stars have their own chip below, and the
 * Sun files under that one. Membership here is a claim about the type, not
 * about a particular object, so no object name belongs in this file.
 */
export const SOLAR_SYSTEM_OBJECT_TYPES = [
  'Planet',
  'Natural Satellite',
  'Dwarf Planet',
  'Asteroid',
  'Comet',
] as const;

/** The chip for objects with no resolvable type. Objects store the literal
 *  string "Unknown" (resolveCatalogMeta's fallback), but an older row can carry
 *  NULL, and both must land here or the worklist is incomplete. */
export const UNKNOWN_FILTER_ID = 'unknown';

/** Star types, matched exactly. Kept as an explicit list rather than a
 *  word-boundary match on "star", which would also swallow `Star Cloud` (a
 *  Milky Way region, not a star). */
export const STAR_OBJECT_TYPES = [
  'Star',
  'Double Star',
  'Binary Star',
  'Variable Star',
] as const;

export const LIBRARY_OBJECT_FILTERS: LibraryObjectFilter[] = [
  { id: 'all', label: 'All', matchTypes: [] },
  { id: 'solar-system', label: 'Solar System', matchTypes: [...SOLAR_SYSTEM_OBJECT_TYPES], matchMode: 'exact' },
  // Comet is in both: it is a solar system object, and it is also common enough
  // as a target to deserve its own chip instead of being buried in the group.
  { id: 'comet', label: 'Comet', matchTypes: ['Comet'], matchMode: 'exact' },
  { id: 'star', label: 'Star', matchTypes: [...STAR_OBJECT_TYPES], matchMode: 'exact' },
  { id: 'galaxy', label: 'Galaxy', matchTypes: ['Galaxy'] },
  { id: 'nebula', label: 'Nebula', matchTypes: ['Nebula'] },
  { id: 'cluster', label: 'Cluster', matchTypes: ['Cluster'] },
  { id: 'supernova-remnant', label: 'Supernova Remnant', matchTypes: ['Supernova Remnant'] },
  { id: 'planetary-nebula', label: 'Planetary Nebula', matchTypes: ['Planetary Nebula'] },
  // Last, and deliberately present even when it is empty: this is the worklist
  // of objects whose type nothing could resolve, which is exactly the set a
  // user wants to find and correct by hand.
  { id: UNKNOWN_FILTER_ID, label: 'Unknown', matchTypes: ['Unknown'], matchMode: 'exact' },
];

function normalizeType(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function typeMatches(objectType: string, matchType: string): boolean {
  const normalizedMatch = normalizeType(matchType);
  return new RegExp(`(^|\\b)${escapeRegExp(normalizedMatch)}(\\b|$)`).test(objectType);
}

export function getLibraryObjectFilterTags(objectType: string | null | undefined): string[] {
  const normalized = normalizeType(objectType ?? '');
  // A missing type and the literal "Unknown" are the same thing to a user
  // looking for objects to correct, so both tag as unknown.
  if (!normalized) return [UNKNOWN_FILTER_ID];

  const tags: string[] = [];
  for (const filter of LIBRARY_OBJECT_FILTERS) {
    if (filter.id === 'all') continue;
    const matches = filter.matchMode === 'exact'
      ? filter.matchTypes.some(type => normalized === normalizeType(type))
      : filter.matchTypes.some(type => typeMatches(normalized, type));
    if (matches) {
      tags.push(filter.id);
    }
  }
  return tags;
}
