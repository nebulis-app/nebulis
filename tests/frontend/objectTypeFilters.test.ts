import { describe, it, expect } from 'vitest';
import type { LibraryObjectFilter } from '../../src/lib/api/library';
import {
  buildTypeFilters,
  matchesFilter,
  defaultEnabledIds,
  filterLabel,
  typeFilterId,
  groupMatchesType,
  ALL_FILTER_ID,
  FAVORITES_FILTER_ID,
} from '../../src/lib/objectTypeFilters';

// Mirrors the curated groups the server serves from
// server/lib/library/objectFilters.ts (only the ones the tests exercise).
const GROUPS: LibraryObjectFilter[] = [
  { id: 'all', label: 'All', matchTypes: [] },
  { id: 'solar-system', label: 'Solar System', matchTypes: ['Star', 'Planet', 'Comet', 'Asteroid'], matchMode: 'exact' },
  { id: 'galaxy', label: 'Galaxy', matchTypes: ['Galaxy'] },
  { id: 'nebula', label: 'Nebula', matchTypes: ['Nebula'] },
];

describe('buildTypeFilters', () => {
  it('counts distinct types and sorts by count desc then label', () => {
    const filters = buildTypeFilters(['Galaxy', 'Comet', 'Galaxy', 'Galaxy', 'Comet', 'Open Cluster']);
    expect(filters).toEqual([
      { id: 'type:galaxy', label: 'Galaxy', count: 3 },
      { id: 'type:comet', label: 'Comet', count: 2 },
      { id: 'type:open cluster', label: 'Open Cluster', count: 1 },
    ]);
  });

  it('case-folds duplicates but keeps the first-seen casing as the label', () => {
    const filters = buildTypeFilters(['emission nebula', 'Emission Nebula', 'EMISSION NEBULA']);
    expect(filters).toEqual([{ id: 'type:emission nebula', label: 'emission nebula', count: 3 }]);
  });

  it('skips empty, whitespace, null, and Unknown types', () => {
    const filters = buildTypeFilters([null, undefined, '', '   ', 'Unknown', 'unknown', 'Comet']);
    expect(filters).toEqual([{ id: 'type:comet', label: 'Comet', count: 1 }]);
  });

  it('trims surrounding whitespace before counting', () => {
    const filters = buildTypeFilters(['  Comet  ', 'Comet']);
    expect(filters).toEqual([{ id: 'type:comet', label: 'Comet', count: 2 }]);
  });

  it('ids match typeFilterId for the same raw type', () => {
    const [filter] = buildTypeFilters(['Reflection Nebula']);
    expect(filter.id).toBe(typeFilterId('  reflection nebula '));
  });

  it('excludes types whose label collides with a curated group label', () => {
    // "Galaxy" is both a raw type in the data AND the "Galaxy" group's label.
    // Without exclusion this would render two identically-labeled chips.
    const filters = buildTypeFilters(['Galaxy', 'Spiral Galaxy', 'Comet'], GROUPS);
    expect(filters.map(f => f.label).sort()).toEqual(['Comet', 'Spiral Galaxy']);
  });

  it('collision exclusion is case-insensitive', () => {
    const filters = buildTypeFilters(['galaxy', 'GALAXY'], GROUPS);
    expect(filters).toEqual([]);
  });

  it('with no groups passed, nothing is excluded (backward-compatible default)', () => {
    const filters = buildTypeFilters(['Galaxy']);
    expect(filters).toEqual([{ id: 'type:galaxy', label: 'Galaxy', count: 1 }]);
  });
});

describe('matchesFilter', () => {
  it('matches everything for the All id', () => {
    expect(matchesFilter(ALL_FILTER_ID, { objectType: 'Comet' }, GROUPS)).toBe(true);
    expect(matchesFilter(ALL_FILTER_ID, { objectType: null }, GROUPS)).toBe(true);
  });

  it('matches only favorites for the Favorites id', () => {
    expect(matchesFilter(FAVORITES_FILTER_ID, { objectType: 'Comet', isFavorite: true }, GROUPS)).toBe(true);
    expect(matchesFilter(FAVORITES_FILTER_ID, { objectType: 'Comet', isFavorite: false }, GROUPS)).toBe(false);
    expect(matchesFilter(FAVORITES_FILTER_ID, { objectType: 'Comet' }, GROUPS)).toBe(false);
  });

  it('exact-matches a granular type id, case-insensitively', () => {
    expect(matchesFilter('type:comet', { objectType: 'Comet' }, GROUPS)).toBe(true);
    expect(matchesFilter('type:comet', { objectType: 'comet' }, GROUPS)).toBe(true);
    expect(matchesFilter('type:comet', { objectType: 'Emission Nebula' }, GROUPS)).toBe(false);
    expect(matchesFilter('type:comet', { objectType: null }, GROUPS)).toBe(false);
  });

  it('uses precomputed filterTags for a group when present (Library path)', () => {
    // filterTags is authoritative: match even if objectType would not word-match.
    expect(matchesFilter('galaxy', { objectType: 'anything', filterTags: ['galaxy'] }, GROUPS)).toBe(true);
    expect(matchesFilter('galaxy', { objectType: 'Galaxy', filterTags: [] }, GROUPS)).toBe(false);
  });

  it('falls back to matchTypes/matchMode when no filterTags (Image Gallery path)', () => {
    // contains group: "Emission Nebula" contains the word "nebula"
    expect(matchesFilter('nebula', { objectType: 'Emission Nebula' }, GROUPS)).toBe(true);
    // exact group: only listed types
    expect(matchesFilter('solar-system', { objectType: 'Comet' }, GROUPS)).toBe(true);
    expect(matchesFilter('solar-system', { objectType: 'Dwarf Planet' }, GROUPS)).toBe(false);
  });

  it('returns false for an unknown group id', () => {
    expect(matchesFilter('does-not-exist', { objectType: 'Galaxy' }, GROUPS)).toBe(false);
  });
});

describe('groupMatchesType', () => {
  it('contains-matches on word boundaries, not substrings', () => {
    const nebula = GROUPS.find(g => g.id === 'nebula')!;
    expect(groupMatchesType(nebula, 'Planetary Nebula')).toBe(true);
    expect(groupMatchesType(nebula, 'Nebulosity')).toBe(false); // "nebula" is not a whole word here
    expect(groupMatchesType(nebula, null)).toBe(false);
  });
});

describe('defaultEnabledIds', () => {
  it('is every group except All', () => {
    expect(defaultEnabledIds(GROUPS)).toEqual(['solar-system', 'galaxy', 'nebula']);
  });
});

describe('filterLabel', () => {
  const types = buildTypeFilters(['Comet']);
  it('resolves special, type, and group ids to labels', () => {
    expect(filterLabel(ALL_FILTER_ID, GROUPS, types)).toBe('All');
    expect(filterLabel(FAVORITES_FILTER_ID, GROUPS, types)).toBe('Favorites');
    expect(filterLabel('type:comet', GROUPS, types)).toBe('Comet');
    expect(filterLabel('galaxy', GROUPS, types)).toBe('Galaxy');
    expect(filterLabel('unknown-id', GROUPS, types)).toBe('unknown-id');
  });
});
