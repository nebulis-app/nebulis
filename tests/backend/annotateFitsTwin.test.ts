import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findFitsTwin } from '../../server/lib/annotate/annotateService';
import { angularSeparationDeg, hasNormalParity, pixelToSky, skyToPixel, wcsFromFitsSolution, type Wcs } from '../../server/lib/annotate/wcs';

/**
 * A real Dwarf 3 stack (3840x2160, target in Perseus), solved twice by ASTAP:
 * once from `stacked-16_….fits` and once from its `stacked.jpg` twin. The two
 * agree on the sky but not on handedness, because Dwarf writes its FITS rows
 * top-down while ASTAP reads a JPG as bottom-up.
 */
const DWARF_FITS_SOLVE: Wcs = {
  crval1: 60.195917137766770, crval2: 36.282983303191479, crpix1: 1920.5, crpix2: 1080.5,
  cd: { cd11: 6.3072975960869854e-4, cd12: 4.4695451866093826e-4, cd21: -4.4707053295457998e-4, cd22: 6.3072168558329391e-4 },
  width: 3840, height: 2160,
};
const DWARF_JPG_SOLVE: Wcs = {
  crval1: 60.195588749896736, crval2: 36.283100336896013, crpix1: 1920.5, crpix2: 1080.5,
  cd: { cd11: 6.3061561520236090e-4, cd12: -4.4662319993362326e-4, cd21: -4.4693333343598791e-4, cd22: -6.2977458428487042e-4 },
  width: 3840, height: 2160,
};

describe('FITS row direction', () => {
  it('reads a mirrored-parity solution as a top-down array and a normal one as bottom-up', () => {
    expect(hasNormalParity(DWARF_JPG_SOLVE.cd)).toBe(true);
    expect(hasNormalParity(DWARF_FITS_SOLVE.cd)).toBe(false);
    expect(wcsFromFitsSolution(DWARF_FITS_SOLVE).yDown).toBe(true);
    expect(wcsFromFitsSolution(DWARF_JPG_SOLVE).yDown).toBe(false);
  });

  it("puts the FITS solution on the JPG's pixels within a few arcseconds", () => {
    const fromFits = wcsFromFitsSolution(DWARF_FITS_SOLVE);
    for (const [x, y] of [[100, 100], [3700, 100], [1920, 1080], [200, 2000], [3600, 2000]]) {
      const a = pixelToSky(DWARF_JPG_SOLVE, x, y);
      const b = pixelToSky(fromFits, x, y);
      expect(angularSeparationDeg(a.raDeg, a.decDeg, b.raDeg, b.decDeg) * 3600).toBeLessThan(10);
    }
  });

  it('without the row-direction fix the same solution lands mirrored, far off', () => {
    const a = pixelToSky(DWARF_JPG_SOLVE, 3700, 100);
    const b = pixelToSky(DWARF_FITS_SOLVE, 3700, 100);
    expect(angularSeparationDeg(a.raDeg, a.decDeg, b.raDeg, b.decDeg)).toBeGreaterThan(0.5);
  });

  it('round-trips a top-down solution', () => {
    const w = wcsFromFitsSolution(DWARF_FITS_SOLVE);
    const sky = pixelToSky(w, 1234, 567);
    const back = skyToPixel(w, sky.raDeg, sky.decDeg)!;
    expect(back.x).toBeCloseTo(1234, 3);
    expect(back.y).toBeCloseTo(567, 3);
  });
});

describe('findFitsTwin', () => {
  let dir: string;
  const touch = (name: string, mtime?: number) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
    return f;
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('pairs a SeeStar stack with the FITS of the same name', () => {
    const jpg = touch('Stacked_60_M 13_10.0s_IRCUT_20260530-211100.jpg');
    const fit = touch('Stacked_60_M 13_10.0s_IRCUT_20260530-211100.fit');
    expect(findFitsTwin(jpg)).toBe(fit);
  });

  it("pairs a Dwarf's stacked.jpg with its highest-count stacked-N FITS", () => {
    const jpg = touch('stacked.jpg');
    touch('stacked-9_HD 1_15s60_Astro_20260403-221000000.fits', 1_000_000);
    const final = touch('stacked-16_HD 1_15s60_Astro_20260403-221747737.fits', 2_000_000);
    touch('HD 1_15s60_Astro_20260403-234221897_22C.fits'); // a sub-frame, never a twin
    expect(findFitsTwin(jpg)).toBe(final);
    expect(findFitsTwin(touch('img_stacked_all.tif'))).toBe(final);
  });

  it('does not pair an ordinary image with an unrelated FITS in its folder', () => {
    touch('stacked-16_HD 1_15s60_Astro_20260403-221747737.fits');
    expect(findFitsTwin(touch('holiday.jpg'))).toBeNull();
  });

  it('returns null when there is nothing to pair', () => {
    expect(findFitsTwin(touch('stacked.jpg'))).toBeNull();
  });
});
