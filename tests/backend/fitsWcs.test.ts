import { describe, it, expect } from 'vitest';
import {
  parseRaToDegs,
  parseDecToDegs,
  headerNumber,
  readCdMatrix,
  imageAngleToSkyPA,
  sensorRotationFromCd,
} from '../../server/lib/fitsWcs';

/**
 * The FITS header is the only contract Nebulis shares with capture software it
 * has never seen, so these tests are written per-writer-convention rather than
 * per-function: each case is a spelling some real program emits.
 */

describe('parseRaToDegs', () => {
  // 18h 18m 48s = 274.7 deg. Every one of these spellings appears in the wild.
  it('reads space-separated sexagesimal hours (OBJCTRA: MaxIm DL, TheSkyX, APT, SGP)', () => {
    expect(parseRaToDegs('18 18 48.00')).toBeCloseTo(274.7, 4);
  });

  it('reads colon-separated sexagesimal hours', () => {
    expect(parseRaToDegs('18:18:48.00')).toBeCloseTo(274.7, 4);
  });

  it('reads h/m/s letters', () => {
    expect(parseRaToDegs('18h18m48.0s')).toBeCloseTo(274.7, 4);
    expect(parseRaToDegs('18h 18m 48.0s')).toBeCloseTo(274.7, 4);
  });

  it('reads a bare decimal as degrees, not as hours', () => {
    // The regression this guards: treating '274.700' as 274h would give 4120°.
    expect(parseRaToDegs('274.700')).toBeCloseTo(274.7, 4);
    expect(parseRaToDegs('0')).toBe(0);
  });

  it('tolerates a missing seconds field', () => {
    expect(parseRaToDegs('18 18')).toBeCloseTo(274.5, 4);
  });

  it('normalizes into [0, 360)', () => {
    expect(parseRaToDegs('23 59 59')).toBeGreaterThanOrEqual(0);
    expect(parseRaToDegs('23 59 59')).toBeLessThan(360);
  });

  it('answers 0 for unparseable text rather than NaN', () => {
    // NaN would poison every angular-distance comparison into `false`, so a bad
    // header would silently pass filters instead of failing them.
    expect(parseRaToDegs('not a coordinate')).toBe(0);
  });
});

describe('parseDecToDegs', () => {
  it('reads space-separated sexagesimal degrees and keeps the arcminutes', () => {
    // The old parser returned -13 here: an 0.82 deg error, wider than most FOVs.
    expect(parseDecToDegs('-13 49 00.0')).toBeCloseTo(-13.81667, 4);
  });

  it('applies the sign to all three components, not just the degrees', () => {
    expect(parseDecToDegs('-13 49 30')).toBeCloseTo(-13.825, 4);
    expect(parseDecToDegs('+22 00 52.0')).toBeCloseTo(22.01444, 4);
  });

  it('reads colon-separated and symbol-separated forms', () => {
    expect(parseDecToDegs('-13:49:00')).toBeCloseTo(-13.81667, 4);
    expect(parseDecToDegs('22° 00′ 52.0″')).toBeCloseTo(22.01444, 4);
  });

  it('reads a bare decimal as degrees', () => {
    expect(parseDecToDegs('-13.8167')).toBeCloseTo(-13.8167, 4);
  });
});

describe('headerNumber', () => {
  it('reads a numeric card', () => {
    expect(headerNumber({ EXPTIME: 10 }, 'EXPTIME')).toBe(10);
  });

  it('reads a QUOTED numeric card', () => {
    // parseFitsHeader returns a string for any quoted card. A strict
    // `typeof === 'number'` test reported EXPTIME as a missing header and
    // skipped identification entirely.
    expect(headerNumber({ EXPTIME: '10.0' }, 'EXPTIME')).toBe(10);
  });

  it('falls through key aliases in order', () => {
    expect(headerNumber({ EXPOSURE: 30 }, 'EXPTIME', 'EXPOSURE', 'EXP')).toBe(30);
  });

  it('is undefined for absent, non-numeric, and non-finite values', () => {
    expect(headerNumber({}, 'EXPTIME')).toBeUndefined();
    expect(headerNumber({ EXPTIME: 'Light' }, 'EXPTIME')).toBeUndefined();
    expect(headerNumber({ EXPTIME: Infinity }, 'EXPTIME')).toBeUndefined();
  });
});

describe('readCdMatrix', () => {
  it('reads a full CD matrix', () => {
    const cd = readCdMatrix({ CD1_1: -0.001, CD1_2: 0, CD2_1: 0, CD2_2: 0.001 });
    expect(cd).toEqual({ cd11: -0.001, cd12: 0, cd21: 0, cd22: 0.001 });
  });

  it('defaults omitted off-diagonal elements to zero', () => {
    // WCS lets a zero CDi_j be omitted. Requiring all four treated the common
    // unrotated solution as "no WCS at all" and silently dropped both the
    // trail-angle filter and the sensor rotation.
    expect(readCdMatrix({ CD1_1: -0.001, CD2_2: 0.001 }))
      .toEqual({ cd11: -0.001, cd12: 0, cd21: 0, cd22: 0.001 });
  });

  it('rejects a degenerate matrix rather than reporting a rotation of zero', () => {
    expect(readCdMatrix({ CD1_1: 0, CD2_2: 0 })).toBeNull();
    expect(readCdMatrix({ CD1_2: 0.001, CD2_1: 0.001, CD1_1: 0.001, CD2_2: 0.001 })).toBeNull();
  });

  it('falls back to the CDELT + CROTA2 convention', () => {
    const cd = readCdMatrix({ CDELT1: -0.001, CDELT2: 0.001, CROTA2: 0 });
    expect(cd).not.toBeNull();
    expect(cd!.cd11).toBeCloseTo(-0.001, 9);
    expect(cd!.cd22).toBeCloseTo(0.001, 9);
    expect(cd!.cd12).toBeCloseTo(0, 9);
    expect(cd!.cd21).toBeCloseTo(0, 9);
  });

  it('applies CROTA2 rotation in the CDELT fallback', () => {
    const cd = readCdMatrix({ CDELT1: 0.001, CDELT2: 0.001, CROTA2: 90 })!;
    expect(cd.cd11).toBeCloseTo(0, 9);
    expect(cd.cd21).toBeCloseTo(0.001, 9);
  });

  it('prefers an explicit CD matrix over CDELT when both are present', () => {
    const cd = readCdMatrix({ CD1_1: -0.002, CD2_2: 0.002, CDELT1: -0.001, CDELT2: 0.001 })!;
    expect(cd.cd11).toBe(-0.002);
  });

  it('is null when the header carries no WCS at all', () => {
    expect(readCdMatrix({ NAXIS1: 1920 })).toBeNull();
  });
});

describe('sensorRotationFromCd', () => {
  it('reports 90 degrees (+x points east) for a CD matrix with east along +x', () => {
    // This is the orientation satelliteTracker assumed unconditionally before
    // rotation existed, so it must still come out of an east-aligned solution.
    expect(sensorRotationFromCd({ cd11: 0.001, cd12: 0, cd21: 0, cd22: 0.001 })).toBeCloseTo(90, 6);
  });

  it('reports 0 degrees (+x points north) when the camera is turned a quarter turn', () => {
    expect(sensorRotationFromCd({ cd11: 0, cd12: 0.001, cd21: 0.001, cd22: 0 })).toBeCloseTo(0, 6);
  });

  it('is always in [0, 360)', () => {
    const pa = sensorRotationFromCd({ cd11: -0.001, cd12: 0, cd21: -0.001, cd22: 0 });
    expect(pa).toBeGreaterThanOrEqual(0);
    expect(pa).toBeLessThan(360);
  });
});

describe('imageAngleToSkyPA', () => {
  // trailDetector reports the trail's own direction (0 deg = +x), so a
  // detector angle of 0 must map to the sky direction of the +x axis.
  const eastAlongX = { cd11: 0.001, cd12: 0, cd21: 0, cd22: 0.001 };

  it('maps a trail along +x to the sky PA of the +x axis', () => {
    expect(imageAngleToSkyPA(0, eastAlongX)).toBeCloseTo(90, 6);
    expect(imageAngleToSkyPA(0, eastAlongX)).toBeCloseTo(sensorRotationFromCd(eastAlongX), 6);
  });

  it('maps a trail along +y to north for an east-aligned sensor', () => {
    expect(imageAngleToSkyPA(90, eastAlongX)).toBeCloseTo(0, 6);
  });

  it('follows the sensor rotation', () => {
    const northAlongX = { cd11: 0, cd12: 0.001, cd21: 0.001, cd22: 0 };
    expect(imageAngleToSkyPA(0, northAlongX)).toBeCloseTo(0, 6);
  });

  it('is always in [0, 360)', () => {
    for (const a of [0, 45, 90, 135, 179]) {
      const pa = imageAngleToSkyPA(a, eastAlongX);
      expect(pa).toBeGreaterThanOrEqual(0);
      expect(pa).toBeLessThan(360);
    }
  });
});
