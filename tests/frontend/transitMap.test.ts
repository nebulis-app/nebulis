import { describe, expect, it } from 'vitest';
import { scaleBarKm, toLocalKm } from '../../src/lib/transitMap';

describe('toLocalKm', () => {
  it('puts a point north or east of the site at the right distance', () => {
    const site = { lat: 48, lon: 2 };
    expect(toLocalKm(site, { lat: 48.1, lon: 2 }).y).toBeCloseTo(11.06, 1);
    expect(toLocalKm(site, { lat: 48.1, lon: 2 }).x).toBeCloseTo(0, 6);
    // A degree of longitude shrinks with the cosine of the latitude.
    expect(toLocalKm(site, { lat: 48, lon: 2.1 }).x).toBeCloseTo(111.32 * 0.1 * Math.cos(48 * Math.PI / 180), 3);
    expect(toLocalKm(site, { lat: 47.9, lon: 1.9 }).x).toBeLessThan(0);
  });
});

describe('scaleBarKm', () => {
  it('picks a round length about a quarter of the span', () => {
    expect(scaleBarKm(40)).toBe(10);
    expect(scaleBarKm(18)).toBe(5);
    expect(scaleBarKm(7)).toBe(2);
    expect(scaleBarKm(3)).toBe(1);
    expect(scaleBarKm(300)).toBe(100);
  });
});
