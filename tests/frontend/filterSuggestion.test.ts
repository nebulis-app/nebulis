import { describe, it, expect } from 'vitest';
import { suggestFilter } from '../../src/lib/filterSuggestion';
import type { ObjectIntegrationProgress } from '../../src/lib/api/library';

const progress = (filters: [string | null, number][]): ObjectIntegrationProgress => ({
  objectId: 'NGC6888',
  complete: filters.every(([, left]) => left === 0),
  filters: filters.map(([filter, remainingSec]) => ({ filter, goalSec: 36_000, exposureSec: 36_000 - remainingSec, remainingSec })),
});

describe('suggestFilter', () => {
  const goals = progress([['L', 8 * 3600], ['D2', 4 * 3600], ['D1', 2 * 3600], ['R', 0]]);

  it('picks the filter with the most time left under a dark sky', () => {
    expect(suggestFilter(goals, { minSeparation: Infinity, illumination: 90 })).toMatchObject({ filter: 'L', band: 'broadband', ruledOutByMoon: [] });
    expect(suggestFilter(goals, { minSeparation: 80, illumination: 10 })?.filter).toBe('L');
  });

  it('keeps to narrowband filters when the Moon is too close for broadband', () => {
    const s = suggestFilter(goals, { minSeparation: 35, illumination: 80 });
    expect(s).toMatchObject({ filter: 'D2', band: 'narrowband', remainingSec: 4 * 3600 });
    expect(s?.ruledOutByMoon.map(f => f.filter)).toEqual(['L']);
  });

  it('says nothing when there is nothing to suggest', () => {
    expect(suggestFilter(undefined, { minSeparation: 20, illumination: 50 })).toBeNull();
    expect(suggestFilter(progress([['L', 3600]]), { minSeparation: 20, illumination: 90 })).toBeNull();
    expect(suggestFilter(progress([['D2', 0]]), { minSeparation: Infinity, illumination: 0 })).toBeNull();
  });
});
