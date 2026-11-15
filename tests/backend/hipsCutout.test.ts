import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { renderHipsCutout, orderForPixelScale } from '../../server/lib/hips/cutout';
import { TILE_SOURCES } from '../../server/lib/hips/tiles';

const FIXTURE_ROOT = path.join(__dirname, 'fixtures/hips-tiles');

/**
 * Two real DSS2 tiles from the CDS survey, cached at order 5 around the Heart Nebula. They are here so one test can
 * check the renderer against actual tile bytes: the synthetic tiles below prove the plumbing, these prove the
 * raster convention (a transposed or flipped sampling shows up as dark bands along the tile edges).
 */
const FIXTURE_FIELD = { raDeg: 39.26, decDeg: 61.19, fovDeg: 1, sizePx: 256 };

/** Every cached probe pixel: [x, y, r, g, b], read from the render verified against SkyView's north-up DSS2. */
const PROBES: [number, number, number, number, number][] = [
  [32, 32, 22, 18, 15],
  [64, 96, 38, 33, 27],
  [128, 40, 54, 46, 35],
  [128, 128, 87, 59, 35],
  [200, 70, 43, 36, 30],
  [96, 180, 28, 20, 17],
  [160, 200, 29, 22, 16],
  [220, 220, 9, 7, 8],
  [40, 210, 16, 15, 13],
  [128, 240, 45, 31, 18],
];

function offlineFetch(): typeof fetch {
  return (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
}

/** A 512x512 JPEG with visible variation, so it cannot be mistaken for a blank tile. */
async function tileJpeg(tint = 0): Promise<Buffer> {
  const raw = Buffer.alloc(512 * 512 * 3);
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const o = (y * 512 + x) * 3;
      raw[o] = (x + tint) % 256;
      raw[o + 1] = (y * 2 + tint) % 256;
      raw[o + 2] = (x + y + tint) % 256;
    }
  }
  return sharp(raw, { raw: { width: 512, height: 512, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

function tempCache(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-hips-'));
}

describe('orderForPixelScale', () => {
  it('picks the order whose tile pixel is closest to an output pixel', () => {
    expect(orderForPixelScale(3, 800)).toBe(5); // 13.5"/px, tile pixel 12.9"
    expect(orderForPixelScale(1, 1920)).toBe(8); // 1.9"/px, tile pixel 1.6"
    expect(orderForPixelScale(20, 800)).toBe(2); // 90"/px, tile pixel 103"
    expect(orderForPixelScale(0.5, 1200)).toBe(8); // clamped at the finest order we use
  });

  it('is never thrown by a nonsense field', () => {
    expect(orderForPixelScale(0, 800)).toBeLessThanOrEqual(8);
    expect(orderForPixelScale(Number.POSITIVE_INFINITY, 800)).toBeLessThanOrEqual(8);
  });
});

describe('renderHipsCutout against real tiles', () => {
  const render = () => renderHipsCutout({ ...FIXTURE_FIELD, cacheRoot: FIXTURE_ROOT, fetchImpl: offlineFetch() });

  it('renders from cached tiles alone, with no network', async () => {
    const out = await render();
    expect(out).not.toBeNull();
    expect(out!.tiles).toBe(2);
    expect(out!.order).toBe(5);
    expect(out!.source).toBe('esa');
    const meta = await sharp(out!.buffer).metadata();
    expect(meta.width).toBe(FIXTURE_FIELD.sizePx);
    expect(meta.height).toBe(FIXTURE_FIELD.sizePx);
    expect(meta.format).toBe('jpeg');
  });

  it('samples the tiles in the right orientation, which a transposed raster would not', async () => {
    const out = await render();
    const { data, info } = await sharp(out!.buffer).raw().toBuffer({ resolveWithObject: true });
    const mismatches: string[] = [];
    for (const [x, y, r, g, b] of PROBES) {
      const o = (y * info.width + x) * info.channels;
      const actual = [data[o], data[o + 1], data[o + 2]];
      const off = Math.max(Math.abs(actual[0] - r), Math.abs(actual[1] - g), Math.abs(actual[2] - b));
      if (off > 10) mismatches.push(`(${x},${y}) got ${actual.join(',')} want ${[r, g, b].join(',')}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('lines up with an independent north-up DSS2 render of the same field', async () => {
    // The reference is SkyView's own DSS2 Red picture of this field, north up and east left, made by a different
    // pipeline from the tiles we read. If the renderer were mirrored, rotated, shifted or scaled, the best
    // correlation would not be at zero shift. This is the check that the framing overlay's geometry depends on:
    // the same field, the same size, the same way round.
    const out = await render();
    const size = FIXTURE_FIELD.sizePx;
    const grey = async (buffer: Buffer): Promise<Float64Array> => {
      const { data } = await sharp(buffer).resize(size, size, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
      const values = new Float64Array(size * size);
      for (let i = 0; i < values.length; i++) values[i] = data[i];
      return values;
    };
    const ours = await grey(out!.buffer);
    const reference = await grey(await sharp(path.join(__dirname, 'fixtures/skyview-1deg-heart.jpg')).toBuffer());
    const correlation = (dx: number, dy: number): number => {
      let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0, n = 0;
      for (let y = 8; y < size - 8; y++) {
        for (let x = 8; x < size - 8; x++) {
          const a = ours[y * size + x];
          const b = reference[(y + dy) * size + (x + dx)];
          sumA += a; sumB += b; sumAA += a * a; sumBB += b * b; sumAB += a * b; n++;
        }
      }
      const covariance = sumAB / n - (sumA / n) * (sumB / n);
      const spread = Math.sqrt((sumAA / n - (sumA / n) ** 2) * (sumBB / n - (sumB / n) ** 2));
      return covariance / spread;
    };
    let best = { dx: 0, dy: 0, r: -2 };
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const r = correlation(dx, dy);
        if (r > best.r) best = { dx, dy, r };
      }
    }
    expect({ dx: best.dx, dy: best.dy }).toEqual({ dx: 0, dy: 0 });
    expect(best.r).toBeGreaterThan(0.6);
    // A sharp peak: two pixels off is clearly worse, so the alignment is not a coincidence of similar star fields.
    expect(correlation(2, 0)).toBeLessThan(best.r - 0.05);
  });

  it('leaves no dark band along a tile edge', async () => {
    // The bug this guards against sampled each tile back to front, which put a black wedge along every tile edge.
    const out = await render();
    const { data, info } = await sharp(out!.buffer).raw().toBuffer({ resolveWithObject: true });
    const bands = (from: number, to: number): number => {
      let dark = 0;
      for (let y = from; y < to; y++) for (let x = 0; x < info.width; x++) {
        const o = (y * info.width + x) * info.channels;
        if (data[o] + data[o + 1] + data[o + 2] < 12) dark++;
      }
      return dark / ((to - from) * info.width);
    };
    for (let y = 0; y < info.height; y += 16) expect(bands(y, y + 16)).toBeLessThan(0.25);
  });

  it('refuses a request it cannot render, rather than throwing', async () => {
    expect(await renderHipsCutout({ raDeg: Number.NaN, decDeg: 61, fovDeg: 1, sizePx: 256, cacheRoot: FIXTURE_ROOT })).toBeNull();
    expect(await renderHipsCutout({ raDeg: 39, decDeg: Number.NaN, fovDeg: 1, sizePx: 256, cacheRoot: FIXTURE_ROOT })).toBeNull();
    expect(await renderHipsCutout({ raDeg: 39, decDeg: 61, fovDeg: 0, sizePx: 256, cacheRoot: FIXTURE_ROOT })).toBeNull();
    expect(await renderHipsCutout({ raDeg: 39, decDeg: 61, fovDeg: 1, sizePx: Number.NaN, cacheRoot: FIXTURE_ROOT })).toBeNull();
  });

  it('stays square at the maximum size the route can ask for', async () => {
    // The fixture only holds order 5, and 1200 px across 1 degree asks for the finest order, so this one serves
    // synthetic tiles instead of measuring a real field.
    const jpeg = await tileJpeg();
    const fetchImpl = (async () => new Response(jpeg, { status: 200 })) as unknown as typeof fetch;
    const out = await renderHipsCutout({ raDeg: 39.26, decDeg: 61.19, fovDeg: 1, sizePx: 5000, cacheRoot: tempCache(), fetchImpl });
    expect(out).not.toBeNull();
    const meta = await sharp(out!.buffer).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(1200);
  });
});

describe('renderHipsCutout host handling', () => {
  const request = { raDeg: 39.26, decDeg: 61.19, fovDeg: 1, sizePx: 256 };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('falls to the next host when the first one misses a tile, and never mixes two hosts', async () => {
    const jpeg = await tileJpeg();
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes(TILE_SOURCES[1].root)) return new Response(jpeg, { status: 200 });
      return new Response('gone', { status: 404 });
    }) as unknown as typeof fetch;
    const out = await renderHipsCutout({ ...request, cacheRoot: tempCache(), fetchImpl });
    expect(out).not.toBeNull();
    expect(out!.source).toBe('mast');
    expect(calls.some(u => u.includes(TILE_SOURCES[0].root))).toBe(true);
  });

  it('returns null when no host can supply the tiles', async () => {
    const fetchImpl = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
    expect(await renderHipsCutout({ ...request, cacheRoot: tempCache(), fetchImpl })).toBeNull();
  });

  it('returns null within its budget when a host hangs', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const started = Date.now();
    expect(await renderHipsCutout({ ...request, cacheRoot: tempCache(), fetchImpl, budgetMs: 600 })).toBeNull();
    // The budget is a bound, not a hint: three hosts must not each add their own stall to it.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('still tries the other hosts when the first one hangs instead of answering', async () => {
    // A black-holed host used to eat the whole budget, which is the most likely shape of a real outage.
    const jpeg = await tileJpeg();
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (!url.includes(TILE_SOURCES[1].root)) {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        throw new Error('aborted');
      }
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await renderHipsCutout({ ...request, cacheRoot: tempCache(), fetchImpl, budgetMs: 1500 });
    expect(out).not.toBeNull();
    expect(out!.source).toBe('mast');
  });

  it('refuses a field that would need more tiles than the cap, before asking any archive', async () => {
    const jpeg = await tileJpeg();
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;
    // A cap of one against a field that needs two tiles: the refusal has to happen before the first request, or the
    // guard is just a slower way of hammering the host.
    const out = await renderHipsCutout({ ...request, cacheRoot: tempCache(), fetchImpl, maxTiles: 1 });
    expect(out).toBeNull();
    expect(calls).toEqual([]);
  });

  it('treats a response that is not an image as a failed tile', async () => {
    const fetchImpl = (async () => new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect(await renderHipsCutout({ ...request, cacheRoot: tempCache(), fetchImpl })).toBeNull();
  });

  it('renders even when the tile cache cannot be written', async () => {
    const jpeg = await tileJpeg();
    const fetchImpl = (async () => new Response(jpeg, { status: 200 })) as unknown as typeof fetch;
    const readOnly = tempCache();
    fs.chmodSync(readOnly, 0o555);
    try {
      const out = await renderHipsCutout({ ...request, cacheRoot: readOnly, fetchImpl });
      expect(out).not.toBeNull();
      expect(out!.source).toBe('esa');
    } finally {
      fs.chmodSync(readOnly, 0o755);
    }
  });

  it('keeps no more than the requested number of tile requests in flight', async () => {
    const jpeg = await tileJpeg();
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await renderHipsCutout({ ...request, fovDeg: 3, sizePx: 800, cacheRoot: tempCache(), fetchImpl, concurrency: 2 });
    expect(out).not.toBeNull();
    expect(out!.tiles).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('writes tiles to the cache, so a second render needs no network', async () => {
    const jpeg = await tileJpeg();
    const cacheRoot = tempCache();
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;
    const first = await renderHipsCutout({ ...request, cacheRoot, fetchImpl });
    expect(first).not.toBeNull();
    expect(requests).toBeGreaterThan(0);
    const before = requests;
    const second = await renderHipsCutout({ ...request, cacheRoot, fetchImpl: offlineFetch() });
    expect(second).not.toBeNull();
    expect(requests).toBe(before);
    expect(fs.readdirSync(path.join(cacheRoot, 'esa', 'Norder5'))).not.toEqual([]);
  });
});
