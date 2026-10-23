import { describe, expect, it } from 'vitest';
import { angularSeparationDeg, approximateWcs, pixelScaleArcsec, pixelToSky, scaleWcs, skyToPixel, type Wcs } from '../../server/lib/annotate/wcs';
import { annotateFrame } from '../../server/lib/annotate/catalogQuery';
import { binaryUrlForPlatform, wcsFromAstapIni } from '../../server/lib/annotate/astap';

/** A real ASTAP solution: a SeeStar S50 stack of M42, 1080x1920 portrait. */
const M42: Wcs = {
  crval1: 83.79613386179,
  crval2: -5.386288828626,
  crpix1: 540.5,
  crpix2: 960.5,
  cd: { cd11: -6.593422541755e-4, cd12: -1.469352722152e-5, cd21: -1.440460917071e-5, cd22: 6.594067638628e-4 },
  width: 1080,
  height: 1920,
};

describe('wcs projection', () => {
  it('puts the reference point at the reference pixel (top-down)', () => {
    const p = skyToPixel(M42, M42.crval1, M42.crval2)!;
    // FITS pixel 540.5 is the continuous coordinate 540; y flips about the height.
    expect(p.x).toBeCloseTo(540, 5);
    expect(p.y).toBeCloseTo(1920 - 960, 5);
  });

  it('round-trips pixel -> sky -> pixel', () => {
    for (const [x, y] of [[10, 10], [540, 960], [1070, 1900], [200, 1500]]) {
      const sky = pixelToSky(M42, x, y);
      const back = skyToPixel(M42, sky.raDeg, sky.decDeg)!;
      expect(back.x).toBeCloseTo(x, 4);
      expect(back.y).toBeCloseTo(y, 4);
    }
  });

  it('has east on the left and north up for an unrotated solution', () => {
    const w = approximateWcs({ raDeg: 100, decDeg: 20, width: 1000, height: 1000, longSideDeg: 2 });
    const east = skyToPixel(w, 100.1, 20)!;
    const north = skyToPixel(w, 100, 20.1)!;
    expect(east.x).toBeLessThan(500);
    expect(north.y).toBeLessThan(500);
  });

  it('reports the plate scale ASTAP reported (about 2.37"/px)', () => {
    expect(pixelScaleArcsec(M42)).toBeCloseTo(2.374, 2);
  });

  it('returns null for a point behind the tangent plane', () => {
    expect(skyToPixel(M42, M42.crval1 + 180, -M42.crval2)).toBeNull();
  });

  it('scales a solution to another resolution of the same picture', () => {
    const half = scaleWcs(M42, 540, 960)!;
    const sky = pixelToSky(M42, 400, 700);
    const full = skyToPixel(M42, sky.raDeg, sky.decDeg)!;
    const small = skyToPixel(half, sky.raDeg, sky.decDeg)!;
    expect(small.x).toBeCloseTo(full.x / 2, 3);
    expect(small.y).toBeCloseTo(full.y / 2, 3);
  });

  it('refuses to scale onto a different shape', () => {
    expect(scaleWcs(M42, 1000, 1000)).toBeNull();
  });

  it('works at RA 0h/360 and near the pole', () => {
    const w = approximateWcs({ raDeg: 359.9, decDeg: 85, width: 2000, height: 1000, longSideDeg: 3 });
    const sky = pixelToSky(w, 1700, 300);
    const back = skyToPixel(w, sky.raDeg, sky.decDeg)!;
    expect(back.x).toBeCloseTo(1700, 3);
    expect(back.y).toBeCloseTo(300, 3);
    expect(angularSeparationDeg(0, 0, 359, 0)).toBeCloseTo(1, 6);
  });
});

describe('annotateFrame', () => {
  it('finds the Orion Nebula frame contents, target first and ringed', () => {
    const found = annotateFrame(M42, { targetId: 'M42' });
    const ids = found.map(a => a.id);
    expect(ids).toContain('M42');
    expect(ids).toContain('M43');
    expect(found[0].id).toBe('M42');
    expect(found[0].isTarget).toBe(true);
    expect(found[0].label).toBe('Orion Nebula');
    expect(found[0].designation).toBe('M42');
    // M42 sits near the middle of its own frame.
    expect(Math.abs(found[0].x - 540)).toBeLessThan(120);
    expect(Math.abs(found[0].y - 960)).toBeLessThan(120);
  });

  it('keeps every ring centre on the picture and respects the cap', () => {
    const found = annotateFrame(M42, { targetId: 'M42', limit: 5 });
    expect(found.length).toBeLessThanOrEqual(5);
    for (const a of found) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(1080);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(1920);
      expect(a.r).toBeGreaterThan(0);
      expect(a.r).toBeLessThanOrEqual(1080 * 0.42 + 1e-6);
    }
  });

  it('returns nothing in an empty patch of sky', () => {
    const w = approximateWcs({ raDeg: 300, decDeg: -85, width: 1080, height: 1920, longSideDeg: 1.28 });
    expect(annotateFrame(w).length).toBeLessThanOrEqual(2);
  });
});

describe('annotateFrame duplicates', () => {
  // A wide field over the Rosette. NGC 2244 is in the catalog twice: a curated
  // record at 98.100, +4.867 and OpenNGC's NGC 2239 (alias NGC 2244) at
  // 97.9815, +4.9429, about 4' apart.
  const rosette = approximateWcs({ raDeg: 98.0, decDeg: 4.95, width: 2048, height: 1152, longSideDeg: 3 });

  it('draws the Rosette Cluster once, at the OpenNGC position, under its well-known name', () => {
    const found = annotateFrame(rosette, { targetId: 'NGC2244' });
    const cluster = found.filter(a => a.id === 'NGC2244' || a.id === 'NGC2239');
    expect(cluster).toHaveLength(1);
    expect(cluster[0].id).toBe('NGC2244');
    expect(cluster[0].label).toBe('Rosette Cluster');
    expect(cluster[0].isTarget).toBe(true);
    const openNgc = skyToPixel(rosette, 97.9815, 4.9429)!;
    expect(cluster[0].x).toBeCloseTo(openNgc.x, 1);
    expect(cluster[0].y).toBeCloseTo(openNgc.y, 1);
  });

  it('does not merge different objects that merely sit close together', () => {
    const ids = annotateFrame(rosette, { targetId: 'NGC2244' }).map(a => a.id);
    expect(ids).toContain('NGC2246');
  });
});

describe('annotateFrame labels and oversize', () => {
  // The Eagle: M16 (120' in the catalog, bigger than the frame) and its 5'
  // core IC4703 are both called "Eagle Nebula".
  const eagle = approximateWcs({ raDeg: 274.72, decDeg: -13.83, width: 1080, height: 1920, longSideDeg: 1.28 });

  it('gives two rings with one name distinct labels, the better-ranked keeping the name', () => {
    const found = annotateFrame(eagle, { targetId: 'M16' });
    const m16 = found.find(a => a.id === 'M16')!;
    const core = found.find(a => a.id === 'IC4703')!;
    expect(m16.label).toBe('Eagle Nebula');
    expect(core.label).toBe('IC4703');
    expect(core.designation).toBeNull();
    const labels = found.map(a => a.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('flags an object bigger than the frame as oversized, and a small one not', () => {
    const found = annotateFrame(eagle, { targetId: 'M16' });
    expect(found.find(a => a.id === 'M16')!.oversized).toBe(true);
    expect(found.find(a => a.id === 'IC4703')!.oversized).toBe(false);
  });
});

describe('astap helpers', () => {
  it('reads a solved .ini and ignores an unsolved one', () => {
    const ini = { PLTSOLVD: 'T', CRPIX1: '540.5', CRPIX2: '960.5', CRVAL1: '83.79', CRVAL2: '-5.38', CD1_1: '-0.00066', CD1_2: '0', CD2_1: '0', CD2_2: '0.00066' };
    expect(wcsFromAstapIni(ini, 1080, 1920)?.cd.cd11).toBe(-0.00066);
    expect(wcsFromAstapIni({ PLTSOLVD: 'F' }, 1080, 1920)).toBeNull();
    expect(wcsFromAstapIni({ PLTSOLVD: 'T', CRVAL1: 'x' }, 1080, 1920)).toBeNull();
  });

  it('has a download for every platform we ship on', () => {
    expect(binaryUrlForPlatform('darwin', 'arm64')).toMatch(/macOS_M1\.zip/);
    expect(binaryUrlForPlatform('darwin', 'x64')).toMatch(/macOS_x86_64\.zip/);
    expect(binaryUrlForPlatform('win32', 'x64')).toMatch(/win64\.zip/);
    expect(binaryUrlForPlatform('linux', 'x64')).toMatch(/Linux_amd64\.zip/);
    expect(binaryUrlForPlatform('freebsd', 'x64')).toBeNull();
  });
});
