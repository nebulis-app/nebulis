import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  isCanonicalResizedFilename,
  resizedImagePath,
  CANONICAL_THUMBNAIL_SIZES,
} from '../../server/lib/catalogPrefetch';

describe('isCanonicalResizedFilename', () => {
  it('accepts every path resizedImagePath() produces for a canonical size', () => {
    for (const { w, h, fit } of CANONICAL_THUMBNAIL_SIZES) {
      for (const source of ['dss2', 'wiki', 'hubble'] as const) {
        const name = path.basename(resizedImagePath('M31', w, h, fit, source));
        expect(isCanonicalResizedFilename(name)).toBe(true);
      }
    }
  });

  it('accepts old-format names with no source segment', () => {
    expect(isCanonicalResizedFilename('M31_384x384.jpg')).toBe(true);
    expect(isCanonicalResizedFilename('C9_1920x1080_cover.jpg')).toBe(true);
  });

  it('does not confuse the cover fit with the inside fit', () => {
    // 1920x1080 is canonical only as `cover`.
    expect(isCanonicalResizedFilename('M31_dss2_1920x1080_cover.jpg')).toBe(true);
    expect(isCanonicalResizedFilename('M31_dss2_1920x1080.jpg')).toBe(false);
    // 384x384 is canonical only as `inside`.
    expect(isCanonicalResizedFilename('M31_dss2_384x384.jpg')).toBe(true);
    expect(isCanonicalResizedFilename('M31_dss2_384x384_cover.jpg')).toBe(false);
  });

  it('rejects arbitrary client-requested sizes (the ones the pruner evicts)', () => {
    expect(isCanonicalResizedFilename('M31_dss2_417x931.jpg')).toBe(false);
    expect(isCanonicalResizedFilename('NGC7000_dss2_200x200.jpg')).toBe(false);
    expect(isCanonicalResizedFilename('IC1318_dss2_1000x1000_cover.jpg')).toBe(false);
  });

  it('rejects non-resize files and malformed names', () => {
    expect(isCanonicalResizedFilename('M31_master.jpg')).toBe(false);
    expect(isCanonicalResizedFilename('.DS_Store')).toBe(false);
    expect(isCanonicalResizedFilename('M31_dss2_384x384.webp')).toBe(false);
  });

  it('tolerates an id that itself contains an underscore or hyphen', () => {
    const name = path.basename(resizedImagePath('ESO351-030', 600, 400, 'inside', 'dss2'));
    expect(name).toContain('600x400');
    expect(isCanonicalResizedFilename(name)).toBe(true);
  });
});
