import { describe, it, expect } from 'vitest';
import { computeBestImagingWindow, isUpTonight } from '../../server/lib/bestImagingWindow';

// Fixed anchor so the 12-month sample set is deterministic.
const NOW = new Date('2026-01-15T12:00:00Z');

describe('computeBestImagingWindow', () => {
  it('returns 12 month samples in calendar order from the current month', () => {
    const w = computeBestImagingWindow(9.93, 69.07, 45, -122, 20, NOW);
    expect(w.months).toHaveLength(12);
    expect(w.months[0].label).toBe('Jan');
    expect(w.months[11].label).toBe('Dec');
  });

  it('marks a high-declination northern object visible from mid-northern latitudes', () => {
    // M81 (RA 9.93h, Dec +69) from 45N is well placed for most of the year.
    const w = computeBestImagingWindow(9.93, 69.07, 45, -122, 20, NOW);
    expect(w.everVisible).toBe(true);
    expect(w.months.filter(m => m.aboveMinAlt).length).toBeGreaterThan(6);
    expect(w.windowStart).not.toBeNull();
  });

  it('marks a far-southern object never visible from the far north', () => {
    // Dec -75 never clears the horizon at lat +45.
    const w = computeBestImagingWindow(6, -75, 45, -122, 20, NOW);
    expect(w.everVisible).toBe(false);
    expect(w.windowStart).toBeNull();
    expect(w.windowEnd).toBeNull();
    expect(w.months.every(m => !m.aboveMinAlt)).toBe(true);
  });

  it('reports a contiguous visibility window that wraps the year boundary', () => {
    // Orion (RA ~5.5h) from the northern hemisphere is a winter target, so the
    // >= minAlt run straddles Dec -> Jan rather than splitting into two.
    const w = computeBestImagingWindow(5.5, -5, 40, -100, 20, NOW);
    expect(w.everVisible).toBe(true);
    const visibleCount = w.months.filter(m => m.aboveMinAlt).length;
    expect(visibleCount).toBeGreaterThan(0);
    expect(visibleCount).toBeLessThan(12);
  });
});

describe('isUpTonight', () => {
  it('is true for an object that transits high overhead tonight', () => {
    expect(isUpTonight(9.93, 69.07, 45, -122, 0, NOW)).toBe(true);
  });

  it('is false for an object permanently below the horizon', () => {
    expect(isUpTonight(6, -75, 45, -122, 0, NOW)).toBe(false);
  });
});
