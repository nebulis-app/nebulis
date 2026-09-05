import { describe, it, expect } from 'vitest';
import * as satellite from 'satellite.js';
import {
  satelliteTracker,
  normalizeObservationTimestamp,
  type ObservationParams,
} from '../../server/lib/satelliteTracker';
import type { TLERecord } from '../../server/lib/satelliteCatalog';

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
    expect(result.candidates).toEqual([]);
    expect(result.nearMisses).toEqual([]);
    // Nothing was evaluated, so every rejection reason is still zero.
    expect(Object.values(result.rejections).every(n => n === 0)).toBe(true);
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

// ─── Field-of-view and exposure-length regressions ───────────────────
//
// The identification pipeline was tuned around a ~0.7 deg field and a ~10 s
// sub. Each block below covers a way that assumption broke for other rigs.

describe('fovOffsets / satelliteCrossesFOV — sensor rotation', () => {
  // Before rotation existed the test compared fovWidthDeg against the RA offset
  // and fovHeightDeg against the DEC offset, i.e. it assumed the sensor's +x
  // axis points east. Every rotator, every manually clocked camera and every
  // alt-az field-rotation offset therefore tested a rectangle turned off the
  // frame's real footprint, worst at high aspect ratios.
  const centreRA = 100, centreDEC = 20;
  // A tall narrow frame makes the orientation unmistakable.
  const fovW = 0.2, fovH = 0.8;

  it('defaults to +x pointing east, matching the pre-rotation behaviour', () => {
    const withDefault = satelliteTracker.satelliteCrossesFOV(centreRA, centreDEC + 0.3, centreRA, centreDEC, fovW, fovH);
    const withEast = satelliteTracker.satelliteCrossesFOV(centreRA, centreDEC + 0.3, centreRA, centreDEC, fovW, fovH, 90);
    expect(withDefault).toBe(withEast);
  });

  it('puts the long axis north-south when +x points east', () => {
    // 0.3 deg north is inside the 0.8 deg dimension.
    expect(satelliteTracker.satelliteCrossesFOV(centreRA, centreDEC + 0.3, centreRA, centreDEC, fovW, fovH, 90)).toBe(true);
  });

  it('puts the long axis east-west when +x points north', () => {
    // Same probe, camera turned a quarter turn: now outside the 0.2 deg dimension.
    expect(satelliteTracker.satelliteCrossesFOV(centreRA, centreDEC + 0.3, centreRA, centreDEC, fovW, fovH, 0)).toBe(false);
  });

  it('projects a point onto the sensor axes', () => {
    // +x east: north maps to -v, east maps to +u.
    const { u, v } = satelliteTracker.fovOffsets(centreRA, centreDEC + 0.5, centreRA, centreDEC, 90);
    expect(u).toBeCloseTo(0, 9);
    expect(v).toBeCloseTo(-0.5, 9);
  });

  it('still applies cos(dec) foreshortening under rotation', () => {
    const nearPole = 80;
    const { u } = satelliteTracker.fovOffsets(centreRA + 1, nearPole, centreRA, nearPole, 90);
    expect(u).toBeCloseTo(Math.cos(nearPole * Math.PI / 180), 6);
  });
});

describe('segmentCrossesFOV', () => {
  // Point sampling alone misses a transit shorter than one sampling step —
  // ~29% of otherwise-detectable trails on a 0.24 deg field. Clipping the
  // segment between consecutive samples makes the question exact.
  const centreRA = 100, centreDEC = 20, fov = 0.1;

  it('is true for a segment whose endpoints are both outside', () => {
    const a = { ra: centreRA - 1, dec: centreDEC };
    const b = { ra: centreRA + 1, dec: centreDEC };
    expect(satelliteTracker.satelliteCrossesFOV(a.ra, a.dec, centreRA, centreDEC, fov, fov)).toBe(false);
    expect(satelliteTracker.satelliteCrossesFOV(b.ra, b.dec, centreRA, centreDEC, fov, fov)).toBe(false);
    expect(satelliteTracker.segmentCrossesFOV(a, b, centreRA, centreDEC, fov, fov)).toBe(true);
  });

  it('is false for a segment that passes wide of the frame', () => {
    const a = { ra: centreRA - 1, dec: centreDEC + 5 };
    const b = { ra: centreRA + 1, dec: centreDEC + 5 };
    expect(satelliteTracker.segmentCrossesFOV(a, b, centreRA, centreDEC, fov, fov)).toBe(false);
  });

  it('is true when an endpoint is inside', () => {
    const a = { ra: centreRA, dec: centreDEC };
    const b = { ra: centreRA + 1, dec: centreDEC };
    expect(satelliteTracker.segmentCrossesFOV(a, b, centreRA, centreDEC, fov, fov)).toBe(true);
  });

  it('is false for a zero-length segment outside the frame', () => {
    const a = { ra: centreRA + 5, dec: centreDEC };
    expect(satelliteTracker.segmentCrossesFOV(a, a, centreRA, centreDEC, fov, fov)).toBe(false);
  });

  it('follows the sensor rotation like the point test does', () => {
    // A north-south segment offset 0.25 deg EAST of centre, against a tall
    // 0.2 x 0.8 deg frame. The offset is wider than the short half-dimension
    // (0.1) but inside the long one (0.4), so which axis points east decides
    // the answer. A segment through the centre would cross at any rotation and
    // prove nothing.
    const eastOffsetRA = 0.25 / Math.cos(centreDEC * Math.PI / 180);
    const a = { ra: centreRA + eastOffsetRA, dec: centreDEC - 0.3 };
    const b = { ra: centreRA + eastOffsetRA, dec: centreDEC + 0.3 };
    // +x north: the 0.8 deg dimension runs east-west and swallows the offset.
    expect(satelliteTracker.segmentCrossesFOV(a, b, centreRA, centreDEC, 0.2, 0.8, 0)).toBe(true);
    // +x east: the offset is outside the 0.2 deg dimension at every point.
    expect(satelliteTracker.segmentCrossesFOV(a, b, centreRA, centreDEC, 0.2, 0.8, 90)).toBe(false);
  });
});

describe('filterVisibleSatellites — exposure length and field size', () => {
  // A real ISS element set and a real pass, so the orbital mechanics under
  // these assertions are not synthetic.
  const REC: TLERecord = {
    name: 'ISS (ZARYA)',
    noradId: 25544,
    line1: '1 25544U 98067A   24170.51782528  .00016717  00000-0  30167-3 0  9998',
    line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49640970 40000',
  };
  const LAT = 32.8, LON = -96.8;
  const satrec = satellite.twoline2satrec(REC.line1, REC.line2);
  const observerGd = {
    longitude: satellite.degreesToRadians(LON),
    latitude: satellite.degreesToRadians(LAT),
    height: 0,
  };

  /** Topocentric RA/DEC of the ISS at `when`, as the tracker computes it. */
  function topo(when: Date): { ra: number; dec: number } {
    const pv = satellite.propagate(satrec, when) as { position?: satellite.EciVec3<number> };
    if (!pv?.position) throw new Error('propagation failed');
    return satelliteTracker.eciToTopoRaDec(pv.position, satellite.gstime(when), observerGd);
  }

  /** A moment when this ISS pass is well up and sunlit, so horizon and shadow
   *  filters are not what any of these tests are measuring. */
  const passTime = (() => {
    for (let m = 0; m < 6000; m++) {
      const d = new Date(Date.UTC(2024, 5, 18, 0, 0, 0) + m * 60000);
      const pv = satellite.propagate(satrec, d) as { position?: satellite.EciVec3<number> };
      if (!pv?.position) continue;
      const look = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(pv.position, satellite.gstime(d)));
      if (look.elevation > 1.0 && satelliteTracker.isIlluminated(pv.position, satelliteTracker.getSunPositionECI(d))) {
        return d;
      }
    }
    throw new Error('no usable ISS pass found in the search range');
  })();

  function paramsFor(overrides: Partial<ObservationParams> & { exposureSeconds: number; timestamp: string }): ObservationParams {
    const centre = topo(passTime);
    return {
      observerLat: LAT,
      observerLon: LON,
      imageCenterRA: centre.ra,
      imageCenterDEC: centre.dec,
      fovWidthDeg: 1.28,
      fovHeightDeg: 0.73,
      ...overrides,
    };
  }

  // The pre-filter used to run once, at the shutter opening, against a radius
  // capped at 15 deg. At ~1.2 deg/s only crossings within +-12.5 s of the
  // opening could start inside that radius, so a 60 s sub searched ~21% of its
  // own window and a 300 s sub ~4%. Conventional rigs shoot 120-600 s subs.
  it.each([10, 30, 60, 120, 300, 600])(
    'finds a satellite crossing 80%% of the way through a %i second exposure',
    (exposureSeconds) => {
      const crossOffset = exposureSeconds * 0.8;
      const shutterOpen = new Date(passTime.getTime() - crossOffset * 1000);
      const { candidates, rejections } = satelliteTracker.filterVisibleSatellites(
        [REC],
        paramsFor({ exposureSeconds, timestamp: shutterOpen.toISOString() }),
      );
      expect(candidates.length, `rejected as ${JSON.stringify(rejections)}`).toBe(1);
      expect(candidates[0].noradId).toBe(25544);
    },
  );

  // Endpoint-to-endpoint velocity is a chord across a curved path, so it
  // understates the rate more the longer the window: the same pass measured
  // 0.89 deg/s over 10 s but 0.21 deg/s over 600 s, dropping under the
  // 0.3 deg/s "slow" gate and rejecting the correct satellite outright.
  it.each([10, 60, 300, 600])(
    'reports a realistic angular velocity over a %i second exposure',
    (exposureSeconds) => {
      const shutterOpen = new Date(passTime.getTime() - exposureSeconds * 0.5 * 1000);
      const { candidates } = satelliteTracker.filterVisibleSatellites(
        [REC],
        paramsFor({ exposureSeconds, timestamp: shutterOpen.toISOString() }),
      );
      expect(candidates.length).toBe(1);
      // The true instantaneous rate for this pass is ~0.85 deg/s.
      expect(candidates[0].velocityDegPerSec).toBeGreaterThan(0.6);
      expect(candidates[0].velocityDegPerSec).toBeLessThan(1.5);
    },
  );

  // A field whose half-diagonal exceeds 15 deg (any lens under ~50 mm on
  // APS-C) had the old cap sitting INSIDE the frame, so satellites visibly in
  // the picture were rejected as 'distance'.
  it('finds a satellite 12 degrees off-axis inside a wide-field frame', () => {
    const centre = topo(passTime);
    const { candidates } = satelliteTracker.filterVisibleSatellites([REC], paramsFor({
      exposureSeconds: 10,
      timestamp: new Date(passTime.getTime() - 5000).toISOString(),
      imageCenterRA: centre.ra + 12 / Math.cos(centre.dec * Math.PI / 180),
      imageCenterDEC: centre.dec,
      fovWidthDeg: 40,
      fovHeightDeg: 27,
    }));
    expect(candidates.length).toBe(1);
  });

  it('still rejects that satellite when the frame is genuinely too narrow to contain it', () => {
    const centre = topo(passTime);
    const { candidates } = satelliteTracker.filterVisibleSatellites([REC], paramsFor({
      exposureSeconds: 10,
      timestamp: new Date(passTime.getTime() - 5000).toISOString(),
      imageCenterRA: centre.ra + 12 / Math.cos(centre.dec * Math.PI / 180),
      imageCenterDEC: centre.dec,
    }));
    expect(candidates.length).toBe(0);
  });

  // The fixed 0.2 s step encoded the Seestar field ("LEO moves ~1 deg/s and
  // FOV is ~0.7 deg wide"). On a 0.24 deg field a transit lasts ~0.2 s, so
  // point sampling missed it outright depending on the shutter phase.
  it.each([1.28, 0.55, 0.24, 0.17, 0.08])(
    'finds a transit across a %s degree field at every shutter phase',
    (fov) => {
      for (const phase of [0, 0.037, 0.081, 0.123, 0.171]) {
        const { candidates } = satelliteTracker.filterVisibleSatellites([REC], paramsFor({
          exposureSeconds: 10,
          timestamp: new Date(passTime.getTime() - 5000 + phase * 1000).toISOString(),
          fovWidthDeg: fov,
          fovHeightDeg: fov,
        }));
        expect(candidates.length, `missed at shutter phase ${phase}`).toBe(1);
      }
    },
  );

  it('caps the track it returns rather than growing it with the exposure', () => {
    const { candidates } = satelliteTracker.filterVisibleSatellites([REC], paramsFor({
      exposureSeconds: 600,
      timestamp: new Date(passTime.getTime() - 300000).toISOString(),
    }));
    expect(candidates.length).toBe(1);
    expect(candidates[0].track.length).toBeLessThanOrEqual(500);
  });
});
