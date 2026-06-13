import { describe, it, expect } from 'vitest';
import { altAz, getNightWindow, altitudeCurve, visibilityWindow } from '../../server/lib/astroCalc';

// Test location: New York City
const LAT = 40.7128;
const LON = -74.006;
const DATE = new Date('2024-01-15T00:00:00Z');

describe('altAz', () => {
  it('Polaris altitude is close to observer latitude at mid-northern site', () => {
    // Polaris: RA ~2.53h, Dec ~89.26°
    const result = altAz(2.53, 89.26, LAT, LON, DATE);
    // Altitude of Polaris should be roughly equal to latitude (within ~2°)
    expect(result.alt).toBeGreaterThan(LAT - 3);
    expect(result.alt).toBeLessThan(LAT + 3);
  });

  it('altitude is always in range [-90, 90]', () => {
    const testCases = [
      { ra: 0, dec: 0 },
      { ra: 6, dec: 45 },
      { ra: 12, dec: -30 },
      { ra: 18, dec: 90 },
      { ra: 23.99, dec: -90 },
    ];
    for (const { ra, dec } of testCases) {
      const result = altAz(ra, dec, LAT, LON, DATE);
      expect(result.alt).toBeGreaterThanOrEqual(-90);
      expect(result.alt).toBeLessThanOrEqual(90);
    }
  });

  it('azimuth is always in range [0, 360)', () => {
    const testCases = [
      { ra: 0, dec: 0 },
      { ra: 6, dec: 45 },
      { ra: 12, dec: -30 },
      { ra: 18, dec: 90 },
      { ra: 23.99, dec: -90 },
    ];
    for (const { ra, dec } of testCases) {
      const result = altAz(ra, dec, LAT, LON, DATE);
      expect(result.az).toBeGreaterThanOrEqual(0);
      expect(result.az).toBeLessThanOrEqual(360);
    }
  });

  it('celestial south pole has negative altitude from northern hemisphere', () => {
    const result = altAz(0, -90, LAT, LON, DATE);
    expect(result.alt).toBeLessThan(0);
  });

  it('returns consistent results for a known date (2024-01-15T00:00:00Z)', () => {
    const result = altAz(5.92, 7.41, LAT, LON, DATE); // Betelgeuse approx
    // Computed values from astroCalc for Betelgeuse from NYC at this exact
    // UTC time. Asserting concrete numbers (±0.1°) catches a regression in
    // the coordinate-transform math — `typeof === 'number'` and `isFinite`
    // alone are TS-level shape checks that any garbage non-NaN passes.
    expect(result.alt).toBeCloseTo(35.36, 1);
    expect(result.az).toBeCloseTo(113.70, 1);
  });
});

describe('getNightWindow', () => {
  it('returns concrete astronomical-night bounds for NYC on 2024-01-15', () => {
    // Computed: dusk ≈ 2024-01-14T23:29Z, dawn ≈ 2024-01-15T10:42Z.
    // suncalc + getNightWindow's logic is deterministic for fixed inputs;
    // assert near-equality so a precision change shows up. Previously the
    // test only checked "is a Date with a non-NaN timestamp", which any
    // valid Date trivially satisfies.
    const nw = getNightWindow(DATE, LAT, LON);
    expect(nw.nightStart?.toISOString().slice(0, 16)).toBe('2024-01-14T23:29');
    expect(nw.nightEnd?.toISOString().slice(0, 16)).toBe('2024-01-15T10:42');
  });

  it('nightStart is before nightEnd (dusk before dawn)', () => {
    const nw = getNightWindow(DATE, LAT, LON);
    expect(nw.nightStart!.getTime()).toBeLessThan(nw.nightEnd!.getTime());
  });

  it('works for a summer date (shorter night at northern latitudes)', () => {
    const summerDate = new Date('2024-06-21T00:00:00Z');
    const nw = getNightWindow(summerDate, LAT, LON);
    // In summer, nights are shorter but should still exist at 40°N
    expect(nw.nightStart).not.toBeNull();
    expect(nw.nightEnd).not.toBeNull();
    if (nw.nightStart && nw.nightEnd) {
      const durationMs = nw.nightEnd.getTime() - nw.nightStart.getTime();
      const durationHours = durationMs / 3600000;
      // Summer night at 40°N: roughly 4-8 hours of astronomical darkness
      expect(durationHours).toBeGreaterThan(2);
      expect(durationHours).toBeLessThan(12);
    }
  });

  it('works for a winter date (longer night at northern latitudes)', () => {
    const winterDate = new Date('2024-12-21T00:00:00Z');
    const nw = getNightWindow(winterDate, LAT, LON);
    expect(nw.nightStart).not.toBeNull();
    expect(nw.nightEnd).not.toBeNull();
    if (nw.nightStart && nw.nightEnd) {
      const durationMs = nw.nightEnd.getTime() - nw.nightStart.getTime();
      const durationHours = durationMs / 3600000;
      // Winter night at 40°N: roughly 10-15 hours of astronomical darkness
      expect(durationHours).toBeGreaterThan(8);
      expect(durationHours).toBeLessThan(18);
    }
  });

  it('returns non-null for typical mid-latitude locations', () => {
    const locations = [
      { lat: 40.7128, lon: -74.006 },   // New York
      { lat: 34.0522, lon: -118.2437 }, // Los Angeles
      { lat: 51.5074, lon: -0.1278 },   // London
    ];
    for (const { lat, lon } of locations) {
      const nw = getNightWindow(DATE, lat, lon);
      expect(nw.nightStart).not.toBeNull();
      expect(nw.nightEnd).not.toBeNull();
    }
  });
});

describe('altitudeCurve', () => {
  // Get a real night window to use for tests
  const nw = getNightWindow(DATE, LAT, LON);
  const nightStart = nw.nightStart!;
  const nightEnd = nw.nightEnd!;

  it('returns an array of points', () => {
    const curve = altitudeCurve(5.92, 7.41, LAT, LON, nightStart, nightEnd);
    expect(Array.isArray(curve)).toBe(true);
    expect(curve.length).toBeGreaterThan(0);
  });

  it('each point has time (ISO string) and finite alt/az in valid ranges', () => {
    const curve = altitudeCurve(5.92, 7.41, LAT, LON, nightStart, nightEnd);
    for (const point of curve) {
      // ISO 8601 round-trip pins the format. `typeof === 'string'` alone
      // would accept anything stringy.
      expect(new Date(point.time).toISOString()).toBe(point.time);
      // alt is constrained by physics — anything outside [-90, 90] is a bug
      // even if `typeof === 'number'` passes. az wraps to [0, 360).
      expect(point.alt).toBeGreaterThanOrEqual(-90);
      expect(point.alt).toBeLessThanOrEqual(90);
      expect(point.az).toBeGreaterThanOrEqual(0);
      expect(point.az).toBeLessThan(360);
    }
  });

  it('all altitudes are in valid range [-90, 90]', () => {
    const curve = altitudeCurve(5.92, 7.41, LAT, LON, nightStart, nightEnd);
    for (const point of curve) {
      expect(point.alt).toBeGreaterThanOrEqual(-90);
      expect(point.alt).toBeLessThanOrEqual(90);
    }
  });

  it('step size affects number of points', () => {
    const curve30 = altitudeCurve(5.92, 7.41, LAT, LON, nightStart, nightEnd, 30);
    const curve15 = altitudeCurve(5.92, 7.41, LAT, LON, nightStart, nightEnd, 15);
    // Halving the step size should roughly double the points
    expect(curve15.length).toBeGreaterThan(curve30.length);
    expect(curve15.length).toBeLessThanOrEqual(curve30.length * 2 + 1);
  });

  it('first point time matches nightStart', () => {
    const curve = altitudeCurve(5.92, 7.41, LAT, LON, nightStart, nightEnd);
    expect(curve[0].time).toBe(nightStart.toISOString());
  });
});

describe('visibilityWindow', () => {
  const nw = getNightWindow(DATE, LAT, LON);
  const nightStart = nw.nightStart!;
  const nightEnd = nw.nightEnd!;

  it('returns rises/sets/maxAlt/maxAltTime for a visible object', () => {
    // Betelgeuse (RA ~5.92h, Dec ~7.41°) — visible the entire NYC astro night
    // on 2024-01-15. Computed by astroCalc: it's already up at dusk
    // (rises === nightStart), sets around 08:49 UTC, peaks ~56.7° altitude.
    // Previously the test only checked the object's *property keys* existed,
    // not the actual numbers — sets/maxAlt could regress silently.
    const result = visibilityWindow(5.92, 7.41, LAT, LON, nightStart, nightEnd, 10);
    expect(result.rises?.getTime()).toBe(nightStart.getTime());
    expect(result.sets?.toISOString().slice(0, 16)).toBe('2024-01-15T08:49');
    expect(result.maxAlt).toBeCloseTo(56.7, 1);
    expect(result.maxAltTime).toBeInstanceOf(Date);
  });

  it('a circumpolar object at high declination has rises equal to nightStart', () => {
    // Polaris-like object: Dec ~89°, always above horizon at 40°N
    // With minAlt=0, it should be visible the entire night
    const result = visibilityWindow(2.53, 89.26, LAT, LON, nightStart, nightEnd, 0);
    expect(result.rises).not.toBeNull();
    expect(result.rises!.getTime()).toBe(nightStart.getTime());
  });

  it('an object that never rises above minAlt returns null rises', () => {
    // Celestial south pole object: Dec=-89° from 40°N, always well below horizon
    const result = visibilityWindow(0, -89, LAT, LON, nightStart, nightEnd, 20);
    expect(result.rises).toBeNull();
    expect(result.maxAlt).toBeLessThan(0);
  });

  it('horizonProfile blocks objects at low altitudes', () => {
    // Create a horizon profile that blocks everything below 40° in all directions
    const highHorizon = new Array(36).fill(40);
    // Betelgeuse max alt from NYC in January is roughly 50-60°, but it will be
    // blocked for much of its path by a 40° horizon
    const withProfile = visibilityWindow(5.92, 7.41, LAT, LON, nightStart, nightEnd, 10, highHorizon);
    const withoutProfile = visibilityWindow(5.92, 7.41, LAT, LON, nightStart, nightEnd, 10);

    // With a high horizon profile, the visible window should be shorter or absent
    if (withProfile.rises && withoutProfile.rises && withProfile.sets && withoutProfile.sets) {
      const profileDuration = withProfile.sets.getTime() - withProfile.rises.getTime();
      const normalDuration = withoutProfile.sets.getTime() - withoutProfile.rises.getTime();
      expect(profileDuration).toBeLessThanOrEqual(normalDuration);
    } else {
      // If the profile blocks the object entirely, rises should be null
      // while without profile it should be visible
      expect(withoutProfile.rises).not.toBeNull();
    }
  });
});
