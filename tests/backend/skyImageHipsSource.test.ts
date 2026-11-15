import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(root, 'nebulis-hips-source-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { fetchSkyCutout } from '../../server/lib/skyImage';
import { cdsIsSkipped, resetCdsBreaker } from '../../server/lib/skyImageFallback';
import { loadTiles, tileCachePath, MAX_TILE_BYTES } from '../../server/lib/hips/tiles';

const CUTOUT_DIR = path.join(TEST_DATA_DIR, 'sky-cache', 'cutouts');
const KEY = 'IC1805_3_800';

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetCdsBreaker();
  // Tile caches are data, so they must not leak between tests: "tiles are down" means down, not "cached earlier".
  fs.rmSync(CUTOUT_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(TEST_DATA_DIR, 'sky-cache', 'hips-tiles'), { recursive: true, force: true });
});

const REQUEST = { id: 'IC1805', ra: 38.17296, dec: 61.456889, fovDeg: 3, sizePx: 800 };

/** A picture with real variation, so it passes the "is this sky" checks the fallback sources run. */
let cachedPicture: Buffer | null = null;
async function picture(width = 512, height = 512): Promise<Buffer> {
  if (cachedPicture && width === 512 && height === 512) return cachedPicture;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      raw[o] = (x * 7 + y * 3) % 256;
      raw[o + 1] = (x * 3 + y * 11) % 256;
      raw[o + 2] = (x + y * 5) % 256;
    }
  }
  const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  if (width === 512 && height === 512) cachedPicture = jpeg;
  return jpeg;
}

type Answers = { cds: 'ok' | 'html404' | 'offline'; tiles: 'ok' | 'down'; sdss: 'ok' | 'down' };

function isTileRequest(url: string): boolean {
  return /skies\.esac\.esa\.int|stpubdata\.s3|casda\.csiro\.au/.test(url);
}

/**
 * Routes each request to the service it belongs to. The point of these tests is which service a call lands on,
 * in what order, and what ends up on disk, so the stub is deliberately dumb about everything else.
 */
function stubServices(answers: Answers) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const service = isTileRequest(url) ? 'tiles'
      : url.includes('sdss') ? 'sdss'
        : url.includes('legacy') || url.includes('skyview') || url.includes('ps1') ? 'other'
          : 'cds';
    calls.push(service);
    if (service === 'tiles') {
      return answers.tiles === 'ok' ? new Response(await picture(), { status: 200 }) : new Response('gone', { status: 404 });
    }
    if (service === 'sdss') {
      return answers.sdss === 'ok' ? new Response(await picture(800, 800), { status: 200 }) : new Response('gone', { status: 404 });
    }
    if (service === 'other') return new Response('gone', { status: 404 });
    if (answers.cds === 'ok') return new Response(await picture(800, 800), { status: 200 });
    if (answers.cds === 'offline') throw new Error('offline');
    return new Response('<html><title>Page unavailable — CDS</title></html>', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  return calls;
}

describe('fetchSkyCutout source precedence', () => {
  it('uses CDS when it answers, and does not render anything of its own', async () => {
    const calls = stubServices({ cds: 'ok', tiles: 'ok', sdss: 'ok' });
    const file = await fetchSkyCutout(REQUEST);
    expect(file).toBe(path.join(CUTOUT_DIR, `${KEY}.jpg`));
    expect(calls).toContain('cds');
    expect(calls).not.toContain('tiles');
    expect(fs.existsSync(path.join(CUTOUT_DIR, `${KEY}.hips.jpg`))).toBe(false);
  });

  it('renders from HiPS tiles when CDS is unavailable, instead of substituting another survey', async () => {
    const calls = stubServices({ cds: 'html404', tiles: 'ok', sdss: 'ok' });
    const file = await fetchSkyCutout(REQUEST);
    expect(file).toBe(path.join(CUTOUT_DIR, `${KEY}.hips.jpg`));
    expect(fs.existsSync(file!)).toBe(true);
    expect(fs.readFileSync(`${file}.source`, 'utf8')).toBe('esa');
    // The survey substitutes are behind the renderer, so SDSS was never asked.
    expect(calls).not.toContain('sdss');
    expect(fs.existsSync(path.join(CUTOUT_DIR, `${KEY}.backup.jpg`))).toBe(false);
  });

  it('still falls back to the existing chain when the tiles cannot be fetched', async () => {
    const calls = stubServices({ cds: 'html404', tiles: 'down', sdss: 'ok' });
    const file = await fetchSkyCutout(REQUEST);
    expect(file).toBe(path.join(CUTOUT_DIR, `${KEY}.backup.jpg`));
    expect(fs.existsSync(file!)).toBe(true);
    expect(calls).toContain('sdss');
    expect(fs.existsSync(path.join(CUTOUT_DIR, `${KEY}.hips.jpg`))).toBe(false);
  });

  it('does the same when CDS is unreachable rather than answering', async () => {
    stubServices({ cds: 'offline', tiles: 'ok', sdss: 'ok' });
    const file = await fetchSkyCutout(REQUEST);
    expect(file).toBe(path.join(CUTOUT_DIR, `${KEY}.hips.jpg`));
  });

  it('serves a rendered cutout from disk without asking any network once CDS is being skipped', async () => {
    stubServices({ cds: 'html404', tiles: 'ok', sdss: 'ok' });
    const first = await fetchSkyCutout(REQUEST);
    expect(first).not.toBeNull();
    // Three CDS misses in a row is what opens the breaker (CDS_FAILURE_THRESHOLD), after which the CDS call is not
    // even attempted. Until then each cutout pays one round trip to Strasbourg before the tiles are consulted.
    for (let attempt = 0; attempt < 3; attempt++) await fetchSkyCutout(REQUEST);
    expect(cdsIsSkipped()).toBe(true);
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (url: string) => { calls.push(url); throw new Error('no network expected'); }) as unknown as typeof fetch);
    const last = await fetchSkyCutout({ ...REQUEST });
    expect(last).toBe(path.join(CUTOUT_DIR, `${KEY}.hips.jpg`));
    expect(calls).toEqual([]);
  });

  it('leaves an existing fallback cutout untouched when the renderer succeeds', async () => {
    // The fallback file is the last line of defence. Switching sources must not delete or overwrite it, or a later
    // failure would have nothing to answer with.
    fs.mkdirSync(CUTOUT_DIR, { recursive: true });
    const backup = path.join(CUTOUT_DIR, `${KEY}.backup.jpg`);
    fs.writeFileSync(backup, await picture(800, 800));
    const before = fs.statSync(backup).size;
    stubServices({ cds: 'html404', tiles: 'ok', sdss: 'ok' });
    const file = await fetchSkyCutout(REQUEST);
    expect(file).toBe(path.join(CUTOUT_DIR, `${KEY}.hips.jpg`));
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.statSync(backup).size).toBe(before);
  });

  it('keeps a cached CDS cutout as the winner over a rendered one', async () => {
    stubServices({ cds: 'html404', tiles: 'ok', sdss: 'ok' });
    await fetchSkyCutout(REQUEST);
    expect(fs.existsSync(path.join(CUTOUT_DIR, `${KEY}.hips.jpg`))).toBe(true);
    // CDS comes back: its file must be preferred even though a rendered cutout is already on disk.
    fs.writeFileSync(path.join(CUTOUT_DIR, `${KEY}.jpg`), await picture(800, 800));
    const file = await fetchSkyCutout(REQUEST);
    expect(file).toBe(path.join(CUTOUT_DIR, `${KEY}.jpg`));
  });
});

describe('tile body cap', () => {
  const sources = [{ name: 'big', root: 'https://big.test' }, { name: 'ok', root: 'https://ok.test' }];

  it('abandons a host that streams an oversized body and falls through to the next', async () => {
    const good = await picture();
    const cacheRoot = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'cap-'));
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      if (url.startsWith('https://big.test')) {
        // No Content-Length: a chunked body that never ends.
        const chunk = new Uint8Array(512 * 1024);
        let sent = 0;
        return new Response(new ReadableStream({
          pull(controller) { controller.enqueue(chunk); sent += chunk.byteLength; if (sent > 64 * MAX_TILE_BYTES) controller.close(); },
        }), { status: 200 });
      }
      return new Response(good, { status: 200 });
    }) as unknown as typeof fetch;
    const result = await loadTiles({ order: 3, tiles: [1], fetchImpl, sources, cacheRoot });
    expect(result?.source).toBe('ok');
    expect(asked.some(u => u.startsWith('https://ok.test'))).toBe(true);
  });

  it('refuses a declared oversized body without reading it', async () => {
    const cacheRoot = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'cap-'));
    const fetchImpl = (async () => new Response('x', { status: 200, headers: { 'content-length': String(MAX_TILE_BYTES + 1) } })) as unknown as typeof fetch;
    expect(await loadTiles({ order: 3, tiles: [1], fetchImpl, sources: [sources[0]], cacheRoot })).toBeNull();
  });
});

describe('tile cache path', () => {
  it('refuses a source name that could leave the cache folder', () => {
    expect(() => tileCachePath({ name: '../x', root: 'r' }, 3, 1, '/cache')).toThrow(/Unsafe/);
    expect(() => tileCachePath({ name: 'a/b', root: 'r' }, 3, 1, '/cache')).toThrow(/Unsafe/);
    expect(tileCachePath({ name: 'esa', root: 'r' }, 3, 1, '/cache')).toContain(`${path.sep}esa${path.sep}`);
  });
});

describe('fetchSkyCutout concurrency', () => {
  it('shares one fetch between simultaneous requests for the same cutout', async () => {
    const calls = stubServices({ cds: 'ok', tiles: 'ok', sdss: 'ok' });
    const [a, b, c] = await Promise.all([fetchSkyCutout(REQUEST), fetchSkyCutout(REQUEST), fetchSkyCutout({ ...REQUEST })]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls.filter(s => s === 'cds')).toHaveLength(1);
  });

  it('does not share across different cutouts', async () => {
    const calls = stubServices({ cds: 'ok', tiles: 'ok', sdss: 'ok' });
    await Promise.all([fetchSkyCutout(REQUEST), fetchSkyCutout({ ...REQUEST, id: 'IC1848', fovDeg: 2 })]);
    expect(calls.filter(s => s === 'cds')).toHaveLength(2);
  });
});
