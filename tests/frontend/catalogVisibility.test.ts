import { describe, it, expect } from 'vitest';
import { isObservableFromSite, maxAltitudeForDec, wallObservableCounts } from '../../src/lib/catalogVisibility';

describe('catalog visibility', () => {
  it('hides a southern target that never rises from the north', () => {
    expect(maxAltitudeForDec(-60, 40)).toBeLessThan(0);
    expect(isObservableFromSite(-60, 40, 20)).toBe(false);
  });

  it('keeps a northern target well above the minimum', () => {
    expect(maxAltitudeForDec(61.4, 40)).toBeGreaterThan(60);
    expect(isObservableFromSite(61.4, 40, 20)).toBe(true);
  });

  it('hides an object that rises but never clears the minimum altitude', () => {
    // dec -20 from lat 40 peaks at 30°, so it is visible but below a 40° floor.
    expect(maxAltitudeForDec(-20, 40)).toBe(30);
    expect(isObservableFromSite(-20, 40, 40)).toBe(false);
    expect(isObservableFromSite(-20, 40, 20)).toBe(true);
  });

  it('does not hide objects with no known position or no site', () => {
    expect(isObservableFromSite(null, 40, 20)).toBe(true);
    expect(isObservableFromSite(-60, null, 20)).toBe(true);
  });

  it('counts a wall tile plus the objects folded into its frame', () => {
    const tiles = [
      { dec: 61.4, imaged: true, mergedIds: ['M43'] },   // imaged, two objects
      { dec: -60, imaged: false, mergedIds: [] },        // never rises from lat 40
      { dec: 20, imaged: false, mergedIds: [] },
    ];
    expect(wallObservableCounts(tiles, 40, 20)).toEqual({ total: 3, imaged: 2 });
    expect(wallObservableCounts(tiles, null, 20)).toEqual({ total: 4, imaged: 2 });
  });
});
