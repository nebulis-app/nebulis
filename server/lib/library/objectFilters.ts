export interface LibraryObjectFilter {
  id: string;
  label: string;
  matchTypes: string[];
  matchMode?: 'exact' | 'contains';
}

export const SOLAR_SYSTEM_OBJECT_TYPES = [
  'Star',
  'Planet',
  'Natural Satellite',
  'Dwarf Planet',
  'Asteroid',
  'Comet',
] as const;

export const LIBRARY_OBJECT_FILTERS: LibraryObjectFilter[] = [
  { id: 'all', label: 'All', matchTypes: [] },
  { id: 'solar-system', label: 'Solar System', matchTypes: [...SOLAR_SYSTEM_OBJECT_TYPES], matchMode: 'exact' },
  { id: 'galaxy', label: 'Galaxy', matchTypes: ['Galaxy'] },
  { id: 'nebula', label: 'Nebula', matchTypes: ['Nebula'] },
  { id: 'cluster', label: 'Cluster', matchTypes: ['Cluster'] },
  { id: 'supernova-remnant', label: 'Supernova Remnant', matchTypes: ['Supernova Remnant'] },
  { id: 'planetary-nebula', label: 'Planetary Nebula', matchTypes: ['Planetary Nebula'] },
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
  if (!normalized) return [];

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
