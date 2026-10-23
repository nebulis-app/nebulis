import { describe, it, expect } from 'vitest';
import { exploreCoreEntries, CORE_PER_CATEGORY } from '../../server/lib/explore/core';
import { EXPLORE_CATEGORY_IDS, categoryOf } from '../../server/lib/explore/categories';
import { isShowpiece } from '../../server/lib/explore/showpiece';

describe('Explore core set (what must be cached for offline use)', () => {
  const core = exploreCoreEntries();
  const ids = new Set(core.map(e => e.id));

  it('holds every showpiece, including curated objects OpenNGC lacks', () => {
    expect(core.filter(isShowpiece).length).toBeGreaterThan(40);
    expect(ids.has('B33')).toBe(true);
    expect(ids.has('M31')).toBe(true);
  });

  it('holds the top of every browse category, and stays small enough to prefetch', () => {
    for (const cat of EXPLORE_CATEGORY_IDS.filter(c => c !== 'showpieces')) {
      const inCat = core.filter(e => categoryOf(e) === cat);
      expect(inCat.length, cat).toBeGreaterThan(0);
      expect(inCat.length, cat).toBeLessThanOrEqual(CORE_PER_CATEGORY + 70);
    }
    expect(core.length).toBeLessThan(900);
  });

  it('lists each object once', () => {
    expect(ids.size).toBe(core.length);
  });
});
