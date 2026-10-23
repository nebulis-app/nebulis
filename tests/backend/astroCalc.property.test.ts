import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { altAz, decToDegs, maxPossibleAltitude, raToDegs, raToHours } from '../../server/lib/astroCalc';

/**
 * Property tests for the pure coordinate math in astroCalc. No DB, no I/O.
 */

const NUM_RUNS = 200;
const EPS = 1e-6;

const raArb = fc.double({ min: 0, max: 24, maxExcluded: true, noNaN: true });
const decArb = fc.double({ min: -90, max: 90, noNaN: true });
const latArb = fc.double({ min: -89.9, max: 89.9, noNaN: true });
const lonArb = fc.double({ min: -180, max: 180, noNaN: true });
const dateArb = fc
  .integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2060, 0, 1) })
  .map(ms => new Date(ms));

/** Sexagesimal RA string the way catalogs write it: "05h 34m 31.94s". */
function formatRa(hours: number): { text: string; value: number } {
  const totalCentis = Math.round(hours * 360000); // hundredths of a second
  const h = Math.floor(totalCentis / 360000);
  const m = Math.floor((totalCentis % 360000) / 6000);
  const s = (totalCentis % 6000) / 100;
  return {
    text: `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${s.toFixed(2)}s`,
    value: h + m / 60 + s / 3600,
  };
}

/** Sexagesimal Dec string: "+22° 00′ 52.2″" / "-05° 23′ 28.0″". */
function formatDec(deg: number): { text: string; value: number } {
  const sign = deg < 0 ? '-' : '+';
  const tenths = Math.round(Math.abs(deg) * 36000); // tenths of an arcsecond
  const d = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const value = (sign === '-' ? -1 : 1) * (d + m / 60 + s / 3600);
  return { text: `${sign}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${s.toFixed(1)}″`, value };
}

describe('altAz - property tests', () => {
  it('altitude is in [-90, 90] and azimuth in [0, 360] for every input', () => {
    fc.assert(
      fc.property(raArb, decArb, latArb, lonArb, dateArb, (ra, dec, lat, lon, date) => {
        const { alt, az } = altAz(ra, dec, lat, lon, date);
        expect(Number.isFinite(alt)).toBe(true);
        expect(Number.isFinite(az)).toBe(true);
        expect(alt).toBeGreaterThanOrEqual(-90);
        expect(alt).toBeLessThanOrEqual(90);
        expect(az).toBeGreaterThanOrEqual(0);
        expect(az).toBeLessThanOrEqual(360);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never exceeds the culmination altitude from maxPossibleAltitude', () => {
    fc.assert(
      fc.property(raArb, decArb, latArb, lonArb, dateArb, (ra, dec, lat, lon, date) => {
        expect(altAz(ra, dec, lat, lon, date).alt).toBeLessThanOrEqual(maxPossibleAltitude(lat, dec) + EPS);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never drops below the lower-culmination altitude', () => {
    fc.assert(
      fc.property(raArb, decArb, latArb, lonArb, dateArb, (ra, dec, lat, lon, date) => {
        // Lower culmination: the object's altitude 12h after transit.
        const minAlt = Math.abs(lat + dec) - 90;
        expect(altAz(ra, dec, lat, lon, date).alt).toBeGreaterThanOrEqual(minAlt - EPS);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is periodic in RA: ra and ra+24h describe the same sky position', () => {
    fc.assert(
      fc.property(raArb, decArb, latArb, lonArb, dateArb, (ra, dec, lat, lon, date) => {
        const a = altAz(ra, dec, lat, lon, date);
        const b = altAz(ra + 24, dec, lat, lon, date);
        expect(b.alt).toBeCloseTo(a.alt, 6);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a celestial pole sits at altitude equal to the observer latitude (same hemisphere)', () => {
    fc.assert(
      fc.property(raArb, latArb, lonArb, dateArb, (ra, lat, lon, date) => {
        const pole = lat >= 0 ? 90 : -90;
        expect(altAz(ra, pole, lat, lon, date).alt).toBeCloseTo(Math.abs(lat), 6);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('maxPossibleAltitude - property tests', () => {
  it('stays in [-90, 90] for valid lat/dec and peaks when dec equals lat', () => {
    fc.assert(
      fc.property(latArb, decArb, (lat, dec) => {
        const m = maxPossibleAltitude(lat, dec);
        expect(m).toBeLessThanOrEqual(90);
        expect(m).toBeGreaterThanOrEqual(-90);
        expect(maxPossibleAltitude(lat, lat)).toBe(90);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('RA / Dec parsing - property tests', () => {
  it('sexagesimal RA round-trips through raToHours', () => {
    fc.assert(
      fc.property(raArb, hours => {
        const { text, value } = formatRa(hours);
        expect(raToHours(text)).toBeCloseTo(value, 9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('raToDegs is always 15 x raToHours, for sexagesimal and decimal-hour strings', () => {
    fc.assert(
      fc.property(raArb, fc.boolean(), (hours, sexagesimal) => {
        const text = sexagesimal ? formatRa(hours).text : hours.toFixed(6);
        expect(raToDegs(text)).toBeCloseTo(raToHours(text) * 15, 9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('numbers pass through unchanged', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), n => {
        expect(raToHours(n)).toBe(n);
        expect(raToDegs(n)).toBe(n);
        expect(decToDegs(n)).toBe(n);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('sexagesimal Dec round-trips through decToDegs, including the sign of -00°', () => {
    fc.assert(
      fc.property(decArb, deg => {
        const { text, value } = formatDec(deg);
        expect(decToDegs(text)).toBeCloseTo(value, 9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws and always returns a finite number for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), s => {
        for (const v of [raToHours(s), raToDegs(s), decToDegs(s)]) {
          expect(typeof v).toBe('number');
          expect(Number.isNaN(v)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
