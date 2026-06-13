import { describe, it, expect } from 'vitest';
import { shouldImportFile } from '../../server/lib/library/importFilter.js';

const SUBS_ON = { importSubFrames: true, importFits: true, importJpg: true, importThumbnails: true };

describe('shouldImportFile — sub-frames are FITS only', () => {
  it('imports raw .fit light frames when sub-frames are enabled', () => {
    expect(shouldImportFile('Light_M42_10.0s_IRCUT_20260407-043257.fit', SUBS_ON)).toBe(true);
    expect(shouldImportFile('sub_0001_M42_10.0s_IRCUT_20260407-043257.fits', SUBS_ON)).toBe(true);
  });

  it('rejects a frame-named JPG in the _sub folder even with JPG import on', () => {
    // Some firmware drops a Light_*.jpg preview alongside the raw subs. It must
    // never ride in under the sub-frame setting.
    expect(shouldImportFile('Light_M42_10.0s_IRCUT_20260407-043257.jpg', SUBS_ON)).toBe(false);
    expect(shouldImportFile('sub_0001_M42_10.0s_IRCUT_20260407-043257.jpg', SUBS_ON)).toBe(false);
  });

  it('rejects frame-named JPGs whose object name contains spaces', () => {
    // Real SeeStar names carry spaces ("M 16", "C 30"). These previously parsed
    // as 'other' and slipped past the sub-frame gate entirely.
    expect(shouldImportFile('Light_M 16_20.0s_LP_20260604-025129.jpg', SUBS_ON)).toBe(false);
    expect(shouldImportFile('Light_C 30_20.0s_IRCUT_20260604-034020.jpg', SUBS_ON)).toBe(false);
    // The matching raw .fit still imports.
    expect(shouldImportFile('Light_M 16_20.0s_LP_20260604-025129.fit', SUBS_ON)).toBe(true);
  });

  it('rejects all sub-frames when the sub-frame setting is off', () => {
    expect(shouldImportFile('Light_M42_10.0s_IRCUT_20260407-043257.fit', { importSubFrames: false })).toBe(false);
  });

  it('still imports a normal stacked JPG via the JPG setting', () => {
    expect(shouldImportFile('Stacked_30_M42_10.0s_IRCUT_20260407-043257.jpg', SUBS_ON)).toBe(true);
  });
});
