import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeBestImagingWindow } from '../../src/lib/bestImagingWindow';

// M42 (Orion Nebula): RA 5.59h, Dec -5.39°
// From 40°N, it peaks at ~44° altitude and is best visible Oct–Feb.
const M42_RA = 5.59;
const M42_DEC = -5.39;
const LAT = 40;
const LON = -105; // Mountain West USA

// Pin tests to a specific date so month-index arithmetic is stable
const FIXED_DATE = new Date('2025-01-01T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_DATE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computeBestImagingWindow', () => {
  it('returns exactly 12 monthly samples', () => {
    const w = computeBestImagingWindow(M42_RA, M42_DEC, LAT, LON);
    expect(w.months).toHaveLength(12);
  });

  it('month labels cycle through Jan–Dec from the starting month', () => {
    const w = computeBestImagingWindow(M42_RA, M42_DEC, LAT, LON);
    const labels = w.months.map(m => m.label);
    // Starting from January 2025
    expect(labels[0]).toBe('Jan');
    expect(labels[11]).toBe('Dec');
  });

  it('M42 is above 20° minAlt during at least some months', () => {
    const w = computeBestImagingWindow(M42_RA, M42_DEC, LAT, LON);
    expect(w.everVisible).toBe(true);
  });

  it('peakMonth has the highest maxAlt', () => {
    const w = computeBestImagingWindow(M42_RA, M42_DEC, LAT, LON);
    expect(w.peakMonth).not.toBeNull();
    for (const m of w.months) {
      expect(w.peakMonth!.maxAlt).toBeGreaterThanOrEqual(m.maxAlt);
    }
  });

  it('windowStart and windowEnd are non-null when object is ever visible', () => {
    const w = computeBestImagingWindow(M42_RA, M42_DEC, LAT, LON);
    expect(w.windowStart).not.toBeNull();
    expect(w.windowEnd).not.toBeNull();
  });

  it('an object at the south pole is never visible from 40°N', () => {
    // Dec -90° never rises above 0° from any northern latitude
    const w = computeBestImagingWindow(0, -90, LAT, LON, 20);
    expect(w.everVisible).toBe(false);
    expect(w.windowStart).toBeNull();
  });

  it('joins a visible season that wraps the array start into one window', () => {
    // Sampling starts in January, and M42 is best Oct–Feb, so the visible run
    // straddles the array boundary (Jan/Feb at the front, Oct–Dec at the back).
    // The reported window must span the whole season, not be truncated to the
    // longer half.
    const w = computeBestImagingWindow(M42_RA, M42_DEC, LAT, LON, 20);
    const visibleLabels = w.months.filter(m => m.aboveMinAlt).map(m => m.label);
    // The contiguous window must cover every visible month.
    const labels = w.months.map(m => m.label);
    const startIdx = labels.indexOf(w.windowStart!);
    const endIdx = labels.indexOf(w.windowEnd!);
    const inWindow = new Set<string>();
    for (let i = 0, idx = startIdx; ; i++, idx = (idx + 1) % 12) {
      inWindow.add(labels[idx]);
      if (idx === endIdx) break;
      if (i > 12) break; // guard
    }
    for (const vl of visibleLabels) {
      expect(inWindow.has(vl)).toBe(true);
    }
  });

  it('all maxAlt values are numbers', () => {
    const w = computeBestImagingWindow(M42_RA, M42_DEC, LAT, LON);
    for (const m of w.months) {
      expect(typeof m.maxAlt).toBe('number');
      expect(isNaN(m.maxAlt)).toBe(false);
    }
  });
});
