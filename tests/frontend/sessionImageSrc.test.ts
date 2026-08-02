import { describe, it, expect } from 'vitest';
import {
  isInlineSafeImage,
  thumbSrcFor,
  previewSrcFor,
  isPoorHeroCandidate,
  canPreviewImage,
} from '../../src/lib/sessionImageSrc';

/**
 * Guards the fix for a real crash: a Dwarf's `img_stacked_all.tif` is a ~100 MB
 * 32-bit float RGB master. It was being auto-selected as an observation's hero
 * and handed straight to an `<img>`, which took Safari down.
 */
const TIFF = {
  name: 'img_stacked_all.tif',
  downloadUrl: '/api/v1/library/file?path=IC1396%2FS%2Fimg_stacked_all.tif',
  thumbUrl: '/api/v1/library/file/thumbnail?path=IC1396%2FS%2Fimg_stacked_all.tif',
  previewUrl: '/api/v1/library/file/thumbnail?w=1200&h=1200&path=IC1396%2FS%2Fimg_stacked_all.tif',
};

const JPG = {
  name: 'stacked.jpg',
  downloadUrl: '/api/v1/library/file?path=IC1396%2FS%2Fstacked.jpg',
  thumbUrl: undefined,
  previewUrl: undefined,
};

/** A 16-bit PNG out of Dwarf stacking: served raw it does not display. */
const PNG16 = {
  name: 'stacked-16_IC 1396.png',
  downloadUrl: '/api/v1/library/file?path=IC1396%2FS%2Fstacked-16.png',
  thumbUrl: '/api/v1/library/file/thumbnail?path=IC1396%2FS%2Fstacked-16.png',
  previewUrl: '/api/v1/library/file/thumbnail?w=1200&h=1200&path=IC1396%2FS%2Fstacked-16.png',
};

describe('isInlineSafeImage', () => {
  it('accepts only JPEG', () => {
    expect(isInlineSafeImage('stacked.jpg')).toBe(true);
    expect(isInlineSafeImage('stacked.JPEG')).toBe(true);
    expect(isInlineSafeImage('img_stacked_all.tif')).toBe(false);
    expect(isInlineSafeImage('stacked-16.png')).toBe(false);
    expect(isInlineSafeImage('light_001.fits')).toBe(false);
  });
});

describe('thumbSrcFor', () => {
  it('never hands a raw TIFF to an img tag', () => {
    expect(thumbSrcFor(TIFF)).toBe(TIFF.thumbUrl);
    expect(thumbSrcFor(TIFF)).not.toContain('library/file?path');
  });

  it('serves a JPEG directly, since converting it would be wasted work', () => {
    expect(thumbSrcFor(JPG)).toBe(JPG.downloadUrl);
  });

  it('converts a 16-bit PNG too', () => {
    expect(thumbSrcFor(PNG16)).toBe(PNG16.thumbUrl);
  });
});

describe('previewSrcFor', () => {
  it('uses the larger rendered tier for a TIFF, not the raw file', () => {
    expect(previewSrcFor(TIFF)).toBe(TIFF.previewUrl);
  });

  it('uses the raw file for a JPEG', () => {
    expect(previewSrcFor(JPG)).toBe(JPG.downloadUrl);
  });

  it('falls back to the thumbnail rather than the raw file when no preview tier exists', () => {
    // Belt and braces: if the server ever stops emitting previewUrl for a
    // non-inline format, the worst case must still not be the 100 MB original.
    const noPreview = { ...TIFF, previewUrl: undefined };
    expect(previewSrcFor(noPreview)).toBe(TIFF.thumbUrl);
  });
});

describe('isPoorHeroCandidate', () => {
  it('rules the 100 MB TIFF out of the automatic pick', () => {
    expect(isPoorHeroCandidate(TIFF)).toBe(true);
  });

  it('leaves the device JPEG preview eligible', () => {
    expect(isPoorHeroCandidate(JPG)).toBe(false);
  });

  it('rules out a 16-bit PNG as well', () => {
    expect(isPoorHeroCandidate(PNG16)).toBe(true);
  });
});

describe('hero ordering (the actual regression)', () => {
  /** Mirrors the pick in ObservationDetail: cheap-first, regardless of how the
   *  file is classified. `stacked.jpg` classifies as a plain image while the
   *  TIFF classifies as `stacked`, so a category-first order picked the TIFF. */
  function pickHero(files: Array<typeof TIFF & { fileType: string; type: string; isThumbnail?: boolean }>) {
    const stackedImages = files.filter(f => f.fileType === 'stacked' && f.type === 'image');
    const stackedImage = stackedImages.find(f => !isPoorHeroCandidate(f)) ?? stackedImages[0];
    const anyImage = files.filter(f => f.type === 'image' && !f.isThumbnail);
    return (stackedImage && !isPoorHeroCandidate(stackedImage) ? stackedImage : undefined)
      ?? anyImage.find(f => !isPoorHeroCandidate(f))
      ?? stackedImage
      ?? anyImage[0]
      ?? null;
  }

  it('prefers the JPEG preview over the TIFF master', () => {
    const hero = pickHero([
      { ...TIFF, fileType: 'stacked', type: 'image' },
      { ...JPG, fileType: 'other', type: 'image' },
    ]);
    expect(hero?.name).toBe('stacked.jpg');
  });

  it('still uses the TIFF when it is the only image present', () => {
    const hero = pickHero([{ ...TIFF, fileType: 'stacked', type: 'image' }]);
    expect(hero?.name).toBe('img_stacked_all.tif');
    // And even then it is displayed through the rendered tier.
    expect(previewSrcFor(hero!)).toBe(TIFF.previewUrl);
  });

  it('does not pick a thumbnail over a real image', () => {
    const hero = pickHero([
      { ...JPG, name: 'stacked_thn.jpg', fileType: 'thumbnail', type: 'image', isThumbnail: true },
      { ...JPG, fileType: 'other', type: 'image' },
    ]);
    expect(hero?.name).toBe('stacked.jpg');
  });
});

describe('canPreviewImage', () => {
  it('rejects a file the server marked non-previewable', () => {
    // A 32-bit float linear TIFF renders pure white through sharp, so the server
    // withholds the render tiers and the UI shows a download card instead.
    expect(canPreviewImage({ previewable: false })).toBe(false);
  });

  it('accepts a previewable file', () => {
    expect(canPreviewImage({ previewable: true })).toBe(true);
  });

  it('treats an absent flag as previewable, for older responses', () => {
    expect(canPreviewImage({})).toBe(true);
  });

  it('keeps a non-previewable file out of the automatic hero pick', () => {
    // Even a JPEG, if the server ever marks one unrenderable.
    expect(isPoorHeroCandidate({ name: 'stacked.jpg', previewable: false })).toBe(true);
    expect(isPoorHeroCandidate({ name: 'stacked.jpg', previewable: true })).toBe(false);
  });
});
