import { describe, it, expect } from 'vitest';
import { renderReducedFits } from '../../server/lib/fitsReducedRender';

interface Spec {
  w: number;
  h: number;
  cards?: string[];
  /** Unsigned 16-bit value at each pixel (stored as value - 32768 with BZERO 32768). */
  value: (x: number, y: number, plane: number) => number;
  planes?: number;
}

function fits(spec: Spec): Buffer {
  const planes = spec.planes ?? 1;
  const cards = [
    'SIMPLE  =                    T',
    'BITPIX  =                   16',
    `NAXIS   = ${String(planes > 1 ? 3 : 2).padStart(20)}`,
    `NAXIS1  = ${String(spec.w).padStart(20)}`,
    `NAXIS2  = ${String(spec.h).padStart(20)}`,
    ...(planes > 1 ? [`NAXIS3  = ${String(planes).padStart(20)}`] : []),
    'BZERO   =                32768',
    'BSCALE  =                    1',
    ...(spec.cards ?? []),
    'END',
  ].map(c => c.padEnd(80));
  const header = Buffer.from(cards.join('').padEnd(Math.ceil((cards.length * 80) / 2880) * 2880), 'ascii');
  const n = spec.w * spec.h * planes;
  const data = Buffer.alloc(Math.ceil((n * 2) / 2880) * 2880);
  let i = 0;
  for (let p = 0; p < planes; p++) {
    for (let y = 0; y < spec.h; y++) {
      for (let x = 0; x < spec.w; x++) data.writeInt16BE(spec.value(x, y, p) - 32768, 2 * i++);
    }
  }
  return Buffer.concat([header, data]);
}

const SIZE = 64;
const px = (rgb: Buffer, x: number, y: number): [number, number, number] => {
  const i = (y * SIZE + x) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
};

describe('renderReducedFits', () => {
  it('leaves an image that is barely larger than the thumbnail to the full-resolution path', () => {
    const buf = fits({ w: 80, h: 60, value: () => 1000 });
    expect(renderReducedFits(buf, SIZE, false)).toBeNull();
  });

  it('letterboxes the picture on black inside a size by size square', () => {
    // 640 x 320 -> 64 x 32 inside 64 x 64: 16 black rows above and below.
    const buf = fits({ w: 640, h: 320, value: (x, y) => 1000 + ((x * 7 + y * 13) % 400) });
    const out = renderReducedFits(buf, SIZE, false);
    expect(out?.rgb.length).toBe(SIZE * SIZE * 3);
    const rgb = out?.rgb as Buffer;
    expect(px(rgb, 10, 3)).toEqual([0, 0, 0]);
    expect(px(rgb, 10, 60)).toEqual([0, 0, 0]);
    const middle = px(rgb, 30, 32);
    expect(middle[0] + middle[1] + middle[2]).toBeGreaterThan(0);
  });

  it('averages a block, so a lone bright pixel is dimmer than a bright area', () => {
    const star = fits({ w: 640, h: 320, value: (x, y) => (x === 320 && y === 160 ? 60000 : 1000) });
    const blob = fits({ w: 640, h: 320, value: (x, y) => (x >= 320 && x < 330 && y >= 160 && y < 170 ? 60000 : 1000) });
    const a = renderReducedFits(star, SIZE, false)?.rgb as Buffer;
    const b = renderReducedFits(blob, SIZE, false)?.rgb as Buffer;
    expect(Math.max(...a)).toBeLessThanOrEqual(Math.max(...b));
  });

  it('keeps colour apart for a Bayer mosaic: red sites only light the red channel', () => {
    // RGGB: red at (even x, even y). Red sites are bright, everything else is background.
    const buf = fits({
      w: 640, h: 640,
      cards: ["BAYERPAT= 'RGGB'"],
      // Red sites carry a ramp (a perfectly flat channel would stretch to black); the rest is flat sky.
      value: (x, y) => (x % 2 === 0 && y % 2 === 0 ? 3000 + x * 50 : 1000),
    });
    const rgb = renderReducedFits(buf, SIZE, false)?.rgb as Buffer;
    const [r, g, b] = px(rgb, 48, 32);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('reads the three planes of a colour cube as red, green and blue', () => {
    const buf = fits({ w: 640, h: 640, planes: 3, value: (x, _y, p) => (p === 2 ? 3000 + x * 50 : 1000) });
    const rgb = renderReducedFits(buf, SIZE, false)?.rgb as Buffer;
    const [r, g, b] = px(rgb, 48, 32);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('flips the picture only for an explicit BOTTOM-UP row order', () => {
    const ramp = (y: number) => 1000 + y * 8; // dark at the top rows, bright at the bottom rows
    const down = fits({ w: 640, h: 640, value: (_x, y) => ramp(y) });
    const up = fits({ w: 640, h: 640, cards: ["ROWORDER= 'BOTTOM-UP'"], value: (_x, y) => ramp(y) });
    const a = renderReducedFits(down, SIZE, false)?.rgb as Buffer;
    const b = renderReducedFits(up, SIZE, false)?.rgb as Buffer;
    expect(px(a, 32, 4)[0]).toBeLessThan(px(a, 32, 60)[0]);
    expect(px(b, 32, 4)[0]).toBeGreaterThan(px(b, 32, 60)[0]);
  });

  it('reads a sparse sub-frame close to the full average of a smooth picture', () => {
    const buf = fits({ w: 960, h: 640, value: (x, y) => 2000 + Math.round(8000 * Math.sin(x / 90) * Math.cos(y / 70) ** 2) + 8000 });
    const full = renderReducedFits(buf, SIZE, false)?.rgb as Buffer;
    const sparse = renderReducedFits(buf, SIZE, true)?.rgb as Buffer;
    let diff = 0;
    for (let i = 0; i < full.length; i++) diff += Math.abs(full[i] - sparse[i]);
    expect(diff / full.length).toBeLessThan(6);
  });

  it('refuses a file whose pixel data is cut short rather than drawing half a picture', () => {
    const buf = fits({ w: 640, h: 320, value: () => 1000 });
    expect(() => renderReducedFits(buf.subarray(0, buf.length - 40_000), SIZE, false)).toThrow(/truncated/i);
  });

  it('refuses a header with no image dimensions', () => {
    const buf = fits({ w: 640, h: 320, value: () => 1000 });
    const broken = Buffer.from(buf);
    broken.write('NAXIS1  =                    0', 80 * 3, 'ascii');
    expect(() => renderReducedFits(broken, SIZE, false)).toThrow(/dimensions/i);
  });
});

describe('purgeStaleFitsThumbnails', () => {
  it("removes a file's older-version renders and nothing else", async () => {
    const fsMod = await import('node:fs');
    const osMod = await import('node:os');
    const pathMod = await import('node:path');
    const { purgeStaleFitsThumbnails, FITS_THUMBNAIL_PIPELINE_VERSION } = await import('../../server/lib/fitsThumbnail');
    const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'nebulis-thumbs-'));
    try {
      const thumbs = pathMod.join(root, '.thumbs');
      fsMod.mkdirSync(thumbs);
      const current = FITS_THUMBNAIL_PIPELINE_VERSION;
      const keep = [
        `a.fits.${current}.jpg`, `a.fits.preview.${current}.jpg`, // this file, current version
        'b.fits.v1.jpg', 'b.fits.preview.v1.jpg',               // another file's renders
        'a.fits.v1.jpg.bak', 'notes.txt',                        // not thumbnails of this file
      ];
      const stale = ['a.fits.v1.jpg', 'a.fits.v2.jpg', 'a.fits.preview.v1.jpg', 'a.fits.preview.v2.jpg'];
      for (const n of [...keep, ...stale]) fsMod.writeFileSync(pathMod.join(thumbs, n), 'x');

      expect(purgeStaleFitsThumbnails(pathMod.join(root, 'a.fits'))).toBe(stale.length);
      expect(fsMod.readdirSync(thumbs).sort()).toEqual([...keep].sort());
      expect(purgeStaleFitsThumbnails(pathMod.join(root, 'missing', 'a.fits'))).toBe(0);
    } finally {
      fsMod.rmSync(root, { recursive: true, force: true });
    }
  });
});
