import { describe, expect, it } from 'vitest';
import { applyPixelAdjustments as inBrowser } from '../../src/lib/imageAdjust';
import { applyPixelAdjustments as onServer } from '../../server/lib/library/imageAdjust';

/** A repeatable spread of values, including 0, 255 and the middle, so clamping and rounding both show up. */
function pixels(count: number, channels: 3 | 4): Uint8Array {
  const out = new Uint8Array(count * channels);
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = i < 12 ? [0, 255, 128, 0, 255, 128, 1, 254, 127, 3, 3, 3][i] : seed % 256;
  }
  return out;
}

const SETTINGS: Array<[number, number, number]> = [
  [0, 0, 0], [30, 0, 0], [-40, 0, 0], [0, 50, 0], [0, -60, 0], [0, 0, 80], [0, 0, -100], [25, 35, -45], [100, 100, 100], [-100, -100, -100],
];

describe('image editor color math', () => {
  describe.each(SETTINGS)('brightness %i, contrast %i, saturation %i', (brightness, contrast, saturation) => {
    it('gives the server and the browser the same value for every channel (RGBA)', () => {
      const source = pixels(4096, 4);
      const browser = new Uint8ClampedArray(source);
      inBrowser(browser, brightness, contrast, saturation);
      const server = new Uint8Array(source);
      onServer(server, 4, { brightness, contrast, saturation });
      expect(Array.from(server)).toEqual(Array.from(browser));
    });

    it('treats RGB the same as RGBA with the alpha left out', () => {
      const rgb = pixels(2048, 3);
      const rgba = new Uint8Array(2048 * 4);
      for (let p = 0; p < 2048; p++) { rgba.set(rgb.subarray(p * 3, p * 3 + 3), p * 4); rgba[p * 4 + 3] = 77; }
      onServer(rgb, 3, { brightness, contrast, saturation });
      onServer(rgba, 4, { brightness, contrast, saturation });
      for (let p = 0; p < 2048; p++) {
        expect(Array.from(rgb.subarray(p * 3, p * 3 + 3))).toEqual(Array.from(rgba.subarray(p * 4, p * 4 + 3)));
        expect(rgba[p * 4 + 3]).toBe(77);
      }
    });
  });
});
