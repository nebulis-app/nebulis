import { describe, it, expect } from 'vitest';
import { mosaicExportSize } from '../../src/lib/mosaic/mosaicExport';

describe('mosaicExportSize', () => {
  it('gives the fixed formats their own sizes whatever the wall looks like', () => {
    expect(mosaicExportSize('wide', 1)).toEqual({ width: 3840, height: 2160 });
    expect(mosaicExportSize('square', 3)).toEqual({ width: 2048, height: 2048 });
    expect(mosaicExportSize('story', 0.2)).toEqual({ width: 1080, height: 1920 });
  });

  it('keeps the shape of the wall for "as shown", with a 4K long side', () => {
    expect(mosaicExportSize('shown', 2)).toEqual({ width: 3840, height: 1920 });
    expect(mosaicExportSize('shown', 0.8)).toEqual({ width: 3072, height: 3840 });
  });

  it('keeps "as shown" inside the shapes the packer can lay out', () => {
    expect(mosaicExportSize('shown', 10)).toEqual({ width: 3840, height: 1280 });
    expect(mosaicExportSize('shown', 0.1)).toEqual({ width: 2304, height: 3840 });
    expect(mosaicExportSize('shown', Number.NaN)).toEqual({ width: 3840, height: 2560 });
  });
});
