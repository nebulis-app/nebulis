import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { altAz as clientAltAz } from '../../src/lib/altaz';
import { altAz as serverAltAz } from '../../server/lib/astroCalc';

/**
 * Cross-implementation property test.
 *
 * The header comment in src/lib/altaz.ts states the client port "must match
 * exactly" the server formula in server/lib/astroCalc.ts. If anyone tweaks
 * one without the other, observers see the chart diverge from the planner's
 * stored altitudes.
 *
 * This test pins both functions to the same numeric output for any RA/Dec
 * and any observer location at a fixed reference instant.
 */

// Fixed reference time so we exercise the formulas, not the Date constructor.
// Using a real moment in time keeps GMST values realistic.
const REFERENCE_DATE = new Date('2025-06-21T03:14:15Z');

describe('altAz client port matches server implementation', () => {
  it('returns the same alt and az for any valid input within 1e-5 degrees', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 24, noNaN: true }),       // RA hours
        fc.double({ min: -90, max: 90, noNaN: true }),     // Dec deg
        fc.double({ min: -90, max: 90, noNaN: true }),     // observer lat
        fc.double({ min: -180, max: 180, noNaN: true }),   // observer lon
        (ra, dec, lat, lon) => {
          const c = clientAltAz(ra, dec, lat, lon, REFERENCE_DATE);
          const s = serverAltAz(ra, dec, lat, lon, REFERENCE_DATE);

          expect(Math.abs(c.alt - s.alt)).toBeLessThan(1e-5);
          expect(Math.abs(c.az - s.az)).toBeLessThan(1e-5);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('agrees on a hand-picked set of canonical observer/target pairs', () => {
    const cases = [
      { ra: 0, dec: 0, lat: 0, lon: 0 },
      { ra: 6, dec: 45, lat: 40.7128, lon: -74.006 },
      { ra: 12, dec: -30, lat: -33.8688, lon: 151.2093 },
      { ra: 18, dec: 60, lat: 51.5074, lon: -0.1278 },
      { ra: 23.99, dec: -89.9, lat: -89, lon: 179 },
      { ra: 2.53, dec: 89.26, lat: 40.7128, lon: -74.006 }, // Polaris from NYC
    ];

    for (const { ra, dec, lat, lon } of cases) {
      const c = clientAltAz(ra, dec, lat, lon, REFERENCE_DATE);
      const s = serverAltAz(ra, dec, lat, lon, REFERENCE_DATE);
      expect(c.alt).toBeCloseTo(s.alt, 5);
      expect(c.az).toBeCloseTo(s.az, 5);
    }
  });
});
