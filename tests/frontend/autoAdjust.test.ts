import { describe, it, expect } from 'vitest';
import { computeAutoAdjust } from '../../src/lib/autoAdjust';

/** RGBA pixels from [r, g, b] triples. */
function pixels(colours: Array<[number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(colours.length * 4);
  colours.forEach(([r, g, b], i) => out.set([r, g, b, 255], i * 4));
  return out;
}

describe('computeAutoAdjust', () => {
  it('returns no change for an empty or fully transparent picture', () => {
    expect(computeAutoAdjust(new Uint8ClampedArray(0))).toEqual({ brightness: 0, contrast: 0, saturation: 0 });
    expect(computeAutoAdjust(new Uint8ClampedArray(16))).toEqual({ brightness: 0, contrast: 0, saturation: 0 });
  });

  it('returns no tone change for a single flat colour', () => {
    const flat = pixels(Array.from({ length: 400 }, () => [90, 90, 90] as [number, number, number]));
    const r = computeAutoAdjust(flat);
    expect(r.contrast).toBe(0);
    expect(r.brightness).toBe(0);
  });

  it('stretches a dull, narrow-range picture with more contrast and a darker background', () => {
    // Grey-ish sky at ~0.30 with brighter structure up to ~0.60.
    const dull = pixels(Array.from({ length: 1000 }, (_, i) => {
      const v = 76 + Math.floor((i / 1000) * 77);
      return [v, v, v] as [number, number, number];
    }));
    const r = computeAutoAdjust(dull);
    expect(r.contrast).toBeGreaterThan(30);
    expect(r.brightness).toBeLessThan(0);
  });

  it('keeps every value inside the slider range', () => {
    const extreme = pixels(Array.from({ length: 1000 }, (_, i) =>
      (i % 2 ? [255, 0, 0] : [1, 0, 0]) as [number, number, number]));
    for (const v of Object.values(computeAutoAdjust(extreme))) {
      expect(v).toBeGreaterThanOrEqual(-100);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('adds saturation to a washed-out picture and removes some from an oversaturated one', () => {
    const washed = pixels(Array.from({ length: 1000 }, () => [110, 100, 100] as [number, number, number]));
    const vivid = pixels(Array.from({ length: 1000 }, () => [200, 40, 40] as [number, number, number]));
    expect(computeAutoAdjust(washed).saturation).toBeGreaterThan(0);
    expect(computeAutoAdjust(vivid).saturation).toBeLessThan(0);
  });
});
