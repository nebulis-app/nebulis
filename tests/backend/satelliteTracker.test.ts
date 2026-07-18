import { describe, it, expect } from 'vitest';
import {
  satelliteTracker,
  normalizeObservationTimestamp,
} from '../../server/lib/satelliteTracker';

describe('normalizeObservationTimestamp', () => {
  // Regression coverage for the CDT bug: new Date("...no Z...") is parsed as
  // LOCAL time by V8, not UTC, silently shifting the satellite search window.
  it('appends Z when no timezone is present, producing a UTC instant', () => {
    const withZ = normalizeObservationTimestamp('2026-06-03T02:18:04Z');
    const withoutZ = normalizeObservationTimestamp('2026-06-03T02:18:04');
    expect(withoutZ.toISOString()).toBe(withZ.toISOString());
    expect(withoutZ.toISOString()).toBe('2026-06-03T02:18:04.000Z');
  });

  it('leaves an explicit positive offset untouched (does not double-append Z)', () => {
    const d = normalizeObservationTimestamp('2026-06-03T02:18:04+02:00');
    // 02:18:04 +02:00 == 00:18:04 UTC
    expect(d.toISOString()).toBe('2026-06-03T00:18:04.000Z');
  });

  it('leaves an explicit negative offset untouched', () => {
    const d = normalizeObservationTimestamp('2026-06-03T02:18:04-05:00');
    expect(d.toISOString()).toBe('2026-06-03T07:18:04.000Z');
  });

  it('handles an offset without a colon (+0200)', () => {
    const d = normalizeObservationTimestamp('2026-06-03T02:18:04+0200');
    expect(d.toISOString()).toBe('2026-06-03T00:18:04.000Z');
  });

  it('converts a space separator to T before checking for a timezone', () => {
    const d = normalizeObservationTimestamp('2026-06-03 02:18:04');
    expect(d.toISOString()).toBe('2026-06-03T02:18:04.000Z');
  });

  it('handles a space separator combined with an explicit Z', () => {
    const d = normalizeObservationTimestamp('2026-06-03 02:18:04Z');
    expect(d.toISOString()).toBe('2026-06-03T02:18:04.000Z');
  });

  it('produces an invalid Date for unparseable input', () => {
    const d = normalizeObservationTimestamp('not-a-timestamp');
    expect(isNaN(d.getTime())).toBe(true);
  });
});

describe('filterVisibleSatellites — invalid timestamp short-circuit', () => {
  it('returns no candidates or near-misses when the timestamp cannot be parsed', () => {
    const result = satelliteTracker.filterVisibleSatellites([], {
      timestamp: 'garbage',
      exposureSeconds: 30,
      observerLat: 40,
      observerLon: -105,
      imageCenterRA: 10,
      imageCenterDEC: 20,
      fovWidthDeg: 1,
      fovHeightDeg: 1,
    });
    expect(result).toEqual({ candidates: [], nearMisses: [] });
  });
});

describe('angularDistance', () => {
  it('is zero for the same point', () => {
    expect(satelliteTracker.angularDistance(10, 20, 10, 20)).toBeCloseTo(0, 9);
  });

  it('computes 90 degrees between two equatorial points a quarter-circle apart', () => {
    expect(satelliteTracker.angularDistance(0, 0, 90, 0)).toBeCloseTo(90, 6);
  });

  it('computes 180 degrees for antipodal equatorial points', () => {
    expect(satelliteTracker.angularDistance(0, 0, 180, 0)).toBeCloseTo(180, 6);
  });

  it('computes a pure declination difference directly', () => {
    expect(satelliteTracker.angularDistance(10, 20, 10, 21)).toBeCloseTo(1, 6);
  });

  it('takes the shortest path across the RA 0/360 wrap', () => {
    // RA=1 to RA=359 are 2 degrees apart the short way, not 358.
    expect(satelliteTracker.angularDistance(1, 0, 359, 0)).toBeCloseTo(2, 6);
  });
});

describe('satelliteCrossesFOV', () => {
  it('is true exactly at the FOV center', () => {
    expect(satelliteTracker.satelliteCrossesFOV(10, 20, 10, 20, 1, 1)).toBe(true);
  });

  it('excludes a point just outside the RA half-width on the equator', () => {
    expect(satelliteTracker.satelliteCrossesFOV(10.6, 0, 10, 0, 1, 1)).toBe(false);
  });

  it('includes a point just inside the RA half-width on the equator', () => {
    expect(satelliteTracker.satelliteCrossesFOV(10.4, 0, 10, 0, 1, 1)).toBe(true);
  });

  it('handles the RA 0/360 wrap when checking a wide FOV', () => {
    expect(satelliteTracker.satelliteCrossesFOV(1, 0, 359, 0, 5, 5)).toBe(true);
  });

  it('handles the RA 0/360 wrap when the FOV is too narrow to include it', () => {
    expect(satelliteTracker.satelliteCrossesFOV(1, 0, 359, 0, 1, 1)).toBe(false);
  });

  it('applies cos(dec) foreshortening: a wide raw RA delta near the pole still falls inside a narrow FOV', () => {
    // 5 degrees of raw RA at dec=80 foreshortens to ~0.87 degrees.
    expect(satelliteTracker.satelliteCrossesFOV(15, 80, 10, 80, 2, 2)).toBe(true);
  });

  it('the same raw RA delta at the equator (no foreshortening) falls outside the same FOV', () => {
    expect(satelliteTracker.satelliteCrossesFOV(15, 0, 10, 0, 2, 2)).toBe(false);
  });

  it('excludes a point just outside the DEC half-height', () => {
    expect(satelliteTracker.satelliteCrossesFOV(10, 20.6, 10, 20, 5, 1)).toBe(false);
  });

  it('includes a point just inside the DEC half-height', () => {
    expect(satelliteTracker.satelliteCrossesFOV(10, 20.4, 10, 20, 5, 1)).toBe(true);
  });
});

describe('computeMotionAngle', () => {
  it('returns null for a track with fewer than 2 points', () => {
    expect(satelliteTracker.computeMotionAngle([])).toBeNull();
    expect(satelliteTracker.computeMotionAngle([{ ra: 1, dec: 1, time: '' }])).toBeNull();
  });

  it('reports 0 degrees for pure northward (+DEC) motion', () => {
    const track = [{ ra: 10, dec: 0, time: '' }, { ra: 10, dec: 5, time: '' }];
    expect(satelliteTracker.computeMotionAngle(track)).toBeCloseTo(0, 6);
  });

  it('reports 90 degrees for pure eastward (+RA) motion at dec=0', () => {
    const track = [{ ra: 10, dec: 0, time: '' }, { ra: 15, dec: 0, time: '' }];
    expect(satelliteTracker.computeMotionAngle(track)).toBeCloseTo(90, 6);
  });

  it('reports 180 degrees for pure southward (-DEC) motion', () => {
    const track = [{ ra: 10, dec: 5, time: '' }, { ra: 10, dec: 0, time: '' }];
    expect(satelliteTracker.computeMotionAngle(track)).toBeCloseTo(180, 6);
  });

  it('reports 270 degrees for pure westward (-RA) motion at dec=0', () => {
    const track = [{ ra: 15, dec: 0, time: '' }, { ra: 10, dec: 0, time: '' }];
    expect(satelliteTracker.computeMotionAngle(track)).toBeCloseTo(270, 6);
  });

  it('handles eastward motion across the RA 0/360 wrap as a small positive delta', () => {
    const track = [{ ra: 359, dec: 0, time: '' }, { ra: 1, dec: 0, time: '' }];
    expect(satelliteTracker.computeMotionAngle(track)).toBeCloseTo(90, 6);
  });

  it('handles westward motion across the RA 0/360 wrap as a small negative delta', () => {
    const track = [{ ra: 1, dec: 0, time: '' }, { ra: 359, dec: 0, time: '' }];
    expect(satelliteTracker.computeMotionAngle(track)).toBeCloseTo(270, 6);
  });
});

describe('isIlluminated', () => {
  const AU_KM = 149597870.7;
  const sunPos = { x: AU_KM, y: 0, z: 0 };
  const leoDist = 6771; // ~400km altitude

  function atPhaseAngle(deg: number) {
    const rad = (deg * Math.PI) / 180;
    return { x: leoDist * Math.cos(rad), y: leoDist * Math.sin(rad), z: 0 };
  }

  it('is illuminated when facing the Sun (trivial angle < 90 branch)', () => {
    expect(satelliteTracker.isIlluminated(atPhaseAngle(0), sunPos)).toBe(true);
  });

  it('is illuminated at a 100-degree phase angle, still above the shadow cone', () => {
    expect(satelliteTracker.isIlluminated(atPhaseAngle(100), sunPos)).toBe(true);
  });

  it('is in shadow at a 120-degree phase angle, inside the shadow cone', () => {
    expect(satelliteTracker.isIlluminated(atPhaseAngle(120), sunPos)).toBe(false);
  });

  it('is in shadow directly antisolar (180 degrees), deep in the umbra', () => {
    expect(satelliteTracker.isIlluminated(atPhaseAngle(180), sunPos)).toBe(false);
  });
});
