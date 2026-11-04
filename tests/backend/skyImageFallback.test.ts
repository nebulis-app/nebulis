import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-skyfallback-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { prefetchSkyImage } from '../../server/lib/skyImage';
import {
  CDS_COOLDOWN_MS, CDS_FAILURE_THRESHOLD, cdsIsSkipped, fetchFallbackSkyImage, recordCdsFailure, recordCdsSuccess,
  resetCdsBreaker,
} from '../../server/lib/skyImageFallback';

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetCdsBreaker();
});

/** A picture with enough variation to count as sky, and a flat one, which a footprint miss returns. */
async function sky(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}
async function flat(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 32, g: 32, b: 32 } } }).jpeg().toBuffer();
}

const REQUEST = { ra: 184.8, dec: 10.8, fovDeg: 1, width: 192, height: 128 };
const COORDS = { ra: 184.8, dec: 10.8 };

type Answer = Buffer | number | 'unreachable';

/** Stubs fetch by service: each of cds, sdss and legacy answers with a picture, an HTTP status, or a network error. */
function stubServices(answers: { cds: Answer; sdss: Answer; legacy: Answer }) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    const service = url.includes('skyserver.sdss.org') ? 'sdss' : url.includes('legacysurvey.org') ? 'legacy' : 'cds';
    calls.push(service);
    const answer = answers[service];
    if (answer === 'unreachable') throw new TypeError('fetch failed');
    if (typeof answer === 'number') return new Response('no', { status: answer });
    return new Response(answer, { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, count: (service: string) => calls.filter(c => c === service).length };
}

describe('the CDS circuit breaker', () => {
  it('opens after the threshold of failures in a row, and stays open for the cooldown', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < CDS_FAILURE_THRESHOLD - 1; i++) recordCdsFailure(t0);
    expect(cdsIsSkipped(t0)).toBe(false);
    recordCdsFailure(t0);
    expect(cdsIsSkipped(t0)).toBe(true);
    expect(cdsIsSkipped(t0 + CDS_COOLDOWN_MS - 1)).toBe(true);
    expect(cdsIsSkipped(t0 + CDS_COOLDOWN_MS)).toBe(false);
  });

  it('reopens at once when the one retry after the cooldown fails', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < CDS_FAILURE_THRESHOLD; i++) recordCdsFailure(t0);
    const later = t0 + CDS_COOLDOWN_MS + 1;
    expect(cdsIsSkipped(later)).toBe(false);
    recordCdsFailure(later);
    expect(cdsIsSkipped(later)).toBe(true);
  });

  it('is reset by one success, so failures must be in a row', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < CDS_FAILURE_THRESHOLD - 1; i++) recordCdsFailure(t0);
    recordCdsSuccess();
    recordCdsFailure(t0);
    expect(cdsIsSkipped(t0)).toBe(false);
  });
});

describe('fetchFallbackSkyImage', () => {
  it('uses SDSS first', async () => {
    const f = stubServices({ cds: 500, sdss: await sky(192, 128), legacy: await sky(192, 192) });
    const r = await fetchFallbackSkyImage(REQUEST);
    expect(r?.source).toBe('sdss');
    expect(f.count('legacy')).toBe(0);
  });

  it('moves on to Legacy Survey outside the SDSS footprint, cutting its square picture to the size asked for', async () => {
    stubServices({ cds: 500, sdss: 404, legacy: await sky(192, 192) });
    const r = await fetchFallbackSkyImage(REQUEST);
    expect(r?.source).toBe('legacy');
    const meta = await sharp(r!.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([192, 128]);
  });

  it('treats a flat Legacy Survey tile as no data', async () => {
    stubServices({ cds: 500, sdss: 404, legacy: await flat(192, 192) });
    expect(await fetchFallbackSkyImage(REQUEST)).toBeNull();
  });

  it('asks for the same field as the CDS image', async () => {
    const f = stubServices({ cds: 500, sdss: 404, legacy: await sky(192, 192) });
    await fetchFallbackSkyImage(REQUEST);
    const urls = f.calls.length;
    expect(urls).toBe(2);
    const fn = vi.mocked(fetch);
    const sdssUrl = new URL(String(fn.mock.calls[0][0]));
    expect(Number(sdssUrl.searchParams.get('scale'))).toBeCloseTo((1 * 3600) / 192, 6);
    const legacyUrl = new URL(String(fn.mock.calls[1][0]));
    expect(Number(legacyUrl.searchParams.get('pixscale'))).toBeCloseTo((1 * 3600) / 192, 6);
    expect(legacyUrl.searchParams.get('size')).toBe('192');
  });

  it('gives null, not an error, when both services are unreachable', async () => {
    stubServices({ cds: 500, sdss: 'unreachable', legacy: 'unreachable' });
    expect(await fetchFallbackSkyImage(REQUEST)).toBeNull();
  });
});

describe('prefetchSkyImage while CDS is down', () => {
  it('fails the first requests as before, then switches to the backup sources once the threshold is reached', async () => {
    const f = stubServices({ cds: 'unreachable', sdss: await sky(1920, 1280), legacy: 404 });

    for (let i = 1; i < CDS_FAILURE_THRESHOLD; i++) {
      expect(await prefetchSkyImage(`BreakerA${i}`, COORDS)).toBeNull();
    }
    expect(f.count('sdss')).toBe(0);

    const tripping = await prefetchSkyImage('BreakerTrip', COORDS);
    expect(tripping).toBeTruthy();
    expect(f.count('sdss')).toBe(1);
    expect(fs.existsSync(`${tripping}.fallback`)).toBe(true);

    // With the breaker open CDS is not asked at all.
    const cdsCallsBefore = f.count('cds');
    expect(await prefetchSkyImage('BreakerNext', COORDS)).toBeTruthy();
    expect(f.count('cds')).toBe(cdsCallsBefore);
  });

  it('leaves a negative entry short-lived when no backup source covers the position', async () => {
    stubServices({ cds: 'unreachable', sdss: 404, legacy: 404 });
    for (let i = 0; i < CDS_FAILURE_THRESHOLD; i++) await prefetchSkyImage(`NoCoverage${i}`, COORDS);
    expect(await prefetchSkyImage('NoCoverageLast', COORDS)).toBeNull();
  });

  it('replaces a backup picture with the CDS one once CDS answers, and drops the thumbnails cut from the old one', async () => {
    stubServices({ cds: 'unreachable', sdss: await sky(1920, 1280), legacy: 404 });
    for (let i = 0; i < CDS_FAILURE_THRESHOLD; i++) await prefetchSkyImage(`UpgradeWarm${i}`, COORDS);
    const backup = await prefetchSkyImage('UpgradeMe', COORDS);
    expect(backup && fs.existsSync(`${backup}.fallback`)).toBe(true);

    const resizedDir = path.join(TEST_DATA_DIR, 'sky-cache', 'resized');
    fs.mkdirSync(resizedDir, { recursive: true });
    const stale = path.join(resizedDir, 'UPGRADEME_dss2_600x400.jpg');
    const unrelated = path.join(resizedDir, 'UPGRADEMEMORE_dss2_600x400.jpg');
    fs.writeFileSync(stale, 'old');
    fs.writeFileSync(unrelated, 'other object');

    // CDS comes back (the cooldown has passed).
    resetCdsBreaker();
    const cdsPicture = await sky(32, 32);
    stubServices({ cds: cdsPicture, sdss: 404, legacy: 404 });
    const result = await prefetchSkyImage('UpgradeMe', COORDS);

    expect(result).toBe(backup);
    expect(fs.readFileSync(result!).equals(cdsPicture)).toBe(true);
    expect(fs.existsSync(`${result}.fallback`)).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('keeps the backup picture when the CDS retry fails', async () => {
    stubServices({ cds: 'unreachable', sdss: await sky(1920, 1280), legacy: 404 });
    for (let i = 0; i < CDS_FAILURE_THRESHOLD; i++) await prefetchSkyImage(`KeepWarm${i}`, COORDS);
    const backup = await prefetchSkyImage('KeepMe', COORDS);
    const before = fs.readFileSync(backup!);

    resetCdsBreaker();
    expect(await prefetchSkyImage('KeepMe', COORDS)).toBe(backup);
    expect(fs.readFileSync(backup!).equals(before)).toBe(true);
    expect(fs.existsSync(`${backup}.fallback`)).toBe(true);
  });

  it('does not try a backup for a CDS 4xx: the request itself is bad', async () => {
    const f = stubServices({ cds: 400, sdss: await sky(1920, 1280), legacy: 404 });
    expect(await prefetchSkyImage('BadRequest', COORDS)).toBeNull();
    expect(f.count('sdss')).toBe(0);
  });
});
