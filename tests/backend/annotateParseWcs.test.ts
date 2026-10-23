import { describe, it, expect } from 'vitest';
import { parseWcs, approximateWcs, skyToPixel, type Wcs } from '../../server/lib/annotate/wcs';

// parseWcs reads the fileWcs cache column back into a Wcs. Every field is
// checked; anything missing or non-finite means "no cached solution" (null).

const STORED = {
  crval1: 83.82,
  crval2: -5.39,
  crpix1: 1024.5,
  crpix2: 576.5,
  cd: { cd11: -0.00066, cd12: 0.00001, cd21: 0.00001, cd22: 0.00066 },
  width: 2048,
  height: 1152,
};

describe('parseWcs', () => {
  it('reads back a well-formed stored solution exactly', () => {
    expect(parseWcs(STORED)).toEqual(STORED);
  });

  it('round-trips through JSON text the way the cache stores it', () => {
    const w = approximateWcs({ raDeg: 10, decDeg: 41, width: 1080, height: 1920, longSideDeg: 1.28 });
    expect(parseWcs(JSON.parse(JSON.stringify(w)))).toEqual(w);
  });

  it('keeps a boolean yDown and ignores a non-boolean one', () => {
    expect(parseWcs({ ...STORED, yDown: true })?.yDown).toBe(true);
    expect(parseWcs({ ...STORED, yDown: false })?.yDown).toBe(false);
    expect(parseWcs({ ...STORED, yDown: 'true' })).not.toHaveProperty('yDown');
  });

  it('drops unknown extra fields', () => {
    expect(parseWcs({ ...STORED, solver: 'astap', extra: 1 })).toEqual(STORED);
  });

  it.each([null, undefined, 42, 'wcs', [1, 2, 3]])('returns null for non-object input %j', (v) => {
    expect(parseWcs(v)).toBeNull();
  });

  it.each(['crval1', 'crval2', 'crpix1', 'crpix2', 'width', 'height'])('returns null when %s is missing', (key) => {
    const copy: Record<string, unknown> = { ...STORED };
    delete copy[key];
    expect(parseWcs(copy)).toBeNull();
  });

  it('returns null when cd is missing or not an object', () => {
    const noCd: Record<string, unknown> = { ...STORED };
    delete noCd.cd;
    expect(parseWcs(noCd)).toBeNull();
    expect(parseWcs({ ...STORED, cd: null })).toBeNull();
    expect(parseWcs({ ...STORED, cd: 0.001 })).toBeNull();
  });

  it.each(['cd11', 'cd12', 'cd21', 'cd22'])('returns null when cd.%s is missing', (key) => {
    const cd: Record<string, unknown> = { ...STORED.cd };
    delete cd[key];
    expect(parseWcs({ ...STORED, cd })).toBeNull();
  });

  it('returns null for numeric strings, NaN, and Infinity (JSON nulls)', () => {
    expect(parseWcs({ ...STORED, crval1: '83.82' })).toBeNull();
    expect(parseWcs({ ...STORED, width: Number.NaN })).toBeNull();
    expect(parseWcs({ ...STORED, cd: { ...STORED.cd, cd22: Infinity } })).toBeNull();
    // JSON.stringify turns NaN into null, so a poisoned cache row parses to null.
    expect(parseWcs(JSON.parse(JSON.stringify({ ...STORED, crpix1: NaN })))).toBeNull();
  });

  it('a parsed solution projects identically to the original', () => {
    const original: Wcs = approximateWcs({ raDeg: 83.82, decDeg: -5.39, width: 2048, height: 1152, longSideDeg: 1.3 });
    const parsed = parseWcs(JSON.parse(JSON.stringify(original)))!;
    expect(skyToPixel(parsed, 83.9, -5.3)).toEqual(skyToPixel(original, 83.9, -5.3));
  });
});
