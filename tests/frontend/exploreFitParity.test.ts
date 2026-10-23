import { describe, it, expect } from 'vitest';
import { classifyFit as clientClassify, objectExtentArcmin } from '../../src/lib/telescopeFov';
import { classifyFit as serverClassify } from '../../server/lib/explore/fit';

/**
 * server/lib/explore/fit.ts is a port of classifyFit so "Fits my scope" can
 * filter a whole category server-side. Nothing else ties the two together, so
 * this walks a grid of fields of view and object sizes, including every
 * threshold (0.15 tiny, 0.75 tight, one-frame overflow), and demands the same
 * verdict, fill ratio and mosaic grid from both.
 */
const FOVS = [
  { widthDeg: 1.27, heightDeg: 0.71 },   // small smart scope
  { widthDeg: 3.0, heightDeg: 2.0 },
  { widthDeg: 0.5, heightDeg: 0.5 },
  { widthDeg: 6.5, heightDeg: 4.3 },
];
const SIZES = [0.5, 1, 3, 5.4, 10, 25, 42.6, 55, 60, 75, 120, 190, 400, 900];

describe('Explore fit classification matches the client', () => {
  for (const fov of FOVS) {
    it(`agrees across object sizes for a ${fov.widthDeg} x ${fov.heightDeg} degree field`, () => {
      for (const size of SIZES) {
        const client = clientClassify(fov, objectExtentArcmin(null, size));
        const server = serverClassify(fov, size);
        expect(server?.tag, `size ${size}`).toBe(client?.tag);
        expect(server?.fillRatio, `size ${size}`).toBeCloseTo(client?.fillRatio ?? NaN, 10);
        expect(server?.mosaicCols, `size ${size}`).toBe(client?.mosaicCols);
        expect(server?.mosaicRows, `size ${size}`).toBe(client?.mosaicRows);
      }
    });
  }

  it('returns null for an unknown or non-positive size, like the client', () => {
    const fov = FOVS[0];
    for (const size of [null, 0, -3, Number.NaN]) {
      expect(serverClassify(fov, size)).toBeNull();
      expect(clientClassify(fov, objectExtentArcmin(null, size))).toBeNull();
    }
  });
});
