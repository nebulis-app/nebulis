import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fetchNarrowbandPlate, flatBrightShare, neutraliseBackground } from '../../server/lib/catalogPack/surveyPlates';

// A box is grainy like real sky unless `flat` is set, which is how a survey tile that was never filled in looks.
async function sky(w: number, h: number, seed: string, base: [number, number, number], boxes: Array<{ x: number; y: number; w: number; h: number; rgb: [number, number, number]; flat?: boolean }> = []): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 3);
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  for (let i = 0; i < buf.length; i += 3) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const grain = (state % 9) - 4;
    for (let c = 0; c < 3; c++) buf[i + c] = Math.max(0, Math.min(255, base[c] + grain));
  }
  for (const b of boxes) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const grain = b.flat ? 0 : (state % 13) - 6;
        const i = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) buf[i + c] = Math.max(0, Math.min(255, b.rgb[c] + grain));
      }
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

const respond = (body: Buffer, ok = true) => (async () => ({ ok, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }) as unknown as Response) as unknown as typeof fetch;

async function medians(img: Buffer): Promise<number[]> {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  return [0, 1, 2].map(c => { const v: number[] = []; for (let p = 0; p < n; p += 7) v.push(data[p * 3 + c]); v.sort((a, b) => a - b); return v[v.length >> 1]; });
}

describe('neutraliseBackground', () => {
  it('moves a violet sky to a neutral one', async () => {
    const violet = await sky(480, 320, 'violet', [34, 12, 52]);
    const before = await medians(violet);
    const after = await medians(await neutraliseBackground(violet));
    expect(Math.max(...before) - Math.min(...before)).toBeGreaterThan(25);
    expect(Math.max(...after) - Math.min(...after)).toBeLessThanOrEqual(3);
  });

  it("'dark' removes a photographic plate's tint without lifting a sky that is already dark", async () => {
    const brown = await sky(480, 320, 'brown', [30, 20, 12]);
    const darkAlready = await sky(480, 320, 'black', [5, 3, 2]);
    const a = await medians(await neutraliseBackground(brown, 'dark'));
    const b = await medians(await neutraliseBackground(darkAlready, 'dark'));
    expect(Math.max(...a) - Math.min(...a)).toBeLessThanOrEqual(3);
    expect(Math.max(...a)).toBeLessThanOrEqual(11);
    expect(Math.max(...b)).toBeLessThanOrEqual(5);
  });

  it('keeps a bright red nebula red', async () => {
    const img = await sky(480, 320, 'nebula', [34, 12, 52], [{ x: 120, y: 80, w: 200, h: 120, rgb: [230, 40, 50] }]);
    const out = await neutraliseBackground(img);
    const { data, info } = await sharp(out).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (140 * info.width + 200) * 3;
    expect(data[i]).toBeGreaterThan(data[i + 1] + 100);
  });
});

describe('flatBrightShare', () => {
  it('is near zero for grainy sky and large for an unfilled tile', async () => {
    expect(await flatBrightShare(await sky(960, 640, 'grain', [40, 40, 44]))).toBeLessThan(0.01);
    expect(await flatBrightShare(await sky(960, 640, 'tile', [40, 40, 44], [{ x: 0, y: 0, w: 960, h: 300, rgb: [90, 140, 90], flat: true }]))).toBeGreaterThan(0.3);
  });
});

describe('fetchNarrowbandPlate', () => {
  const req = { ra: 270, dec: -30, fovDeg: 0.5 };

  it('returns a neutralised plate when the survey has data', async () => {
    // Stars and a nebula, so the plate is not "blank" the way an empty field is.
    const stars = Array.from({ length: 60 }, (_, i) => ({ x: (i * 37) % 470, y: (i * 53) % 310, w: 4, h: 4, rgb: [250, 250, 250] as [number, number, number] }));
    const plate = await fetchNarrowbandPlate('vphas', req, respond(await sky(480, 320, 'ok', [34, 12, 52], [{ x: 150, y: 90, w: 180, h: 120, rgb: [220, 50, 60] }, ...stars])));
    expect(plate).not.toBeNull();
    const m = await medians(plate!);
    expect(Math.max(...m) - Math.min(...m)).toBeLessThanOrEqual(3);
  });

  it('returns null where the survey has no coverage (a white frame)', async () => {
    const white = await sharp({ create: { width: 480, height: 320, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    expect(await fetchNarrowbandPlate('vphas', req, respond(white))).toBeNull();
  });

  it('returns null when part of the plate is a missing tile', async () => {
    const holey = await sky(480, 320, 'hole', [34, 12, 52], [{ x: 0, y: 0, w: 200, h: 120, rgb: [255, 255, 255], flat: true }]);
    expect(await fetchNarrowbandPlate('vphas', req, respond(holey))).toBeNull();
  });

  it('returns null when every host fails', async () => {
    expect(await fetchNarrowbandPlate('vphas', req, respond(Buffer.alloc(0), false))).toBeNull();
  });
});
