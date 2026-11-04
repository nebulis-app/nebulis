import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Own DATA_DIR: the router reads sky-cache/ from DATA_DIR at import time.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(root, 'nebulis-catalog-routes-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// The job runner and the network are the only things replaced; the router, the catalog and the DB are real.
const jobs = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn() }));
vi.mock('../../../server/lib/catalogPrefetch', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../server/lib/catalogPrefetch')>();
  return {
    ...actual,
    startPrefetch: (...a: unknown[]) => jobs.start(...a),
    cancelPrefetch: (...a: unknown[]) => jobs.cancel(...a),
  };
});
vi.mock('../../../server/lib/skyImage', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../server/lib/skyImage')>();
  return { ...actual, prefetchSkyImage: vi.fn(async () => null), fetchSkyCutout: vi.fn(async () => null) };
});

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import request from 'supertest';
import { catalogRouter } from '../../../server/routes/catalog';
import { imageCachePath, getPrefetchStatus } from '../../../server/lib/catalogPrefetch';
import { routeApp } from '../helpers/routeApp';
import db from '../../../server/lib/db';

const app = routeApp(catalogRouter);
const viewer = { 'x-test-role': 'viewer' };

beforeEach(() => {
  jobs.start.mockReset().mockReturnValue({ started: true });
  jobs.cancel.mockReset().mockReturnValue(true);
  db.prepare('DELETE FROM catalogOverrides').run();
});

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

describe('GET /  and /search', () => {
  it('pages the catalog and reports the pagination', async () => {
    const res = await request(app).get('/?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta.pagination).toMatchObject({ limit: 5 });
  });

  it('filters by type, case-insensitively, and every row matches', async () => {
    const res = await request(app).get('/?type=GALAXY&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const e of res.body.data) expect(e.type.toLowerCase()).toContain('galaxy');
  });

  it('filters by constellation exactly', async () => {
    const res = await request(app).get('/?constellation=orion&limit=50');
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const e of res.body.data) expect(e.constellation.toLowerCase()).toBe('orion');
  });

  it('search refuses a missing query with MISSING_QUERY', async () => {
    const res = await request(app).get('/search');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_QUERY');
  });

  it('search finds Andromeda and echoes the query', async () => {
    const res = await request(app).get('/search?q=Andromeda');
    expect(res.status).toBe(200);
    expect(res.body.meta.query).toBe('Andromeda');
    expect(res.body.data.map((e: { id: string }) => e.id)).toContain('M31');
  });
});

describe('GET /:id and /:id/info', () => {
  it('returns a known object with its common names', async () => {
    const res = await request(app).get('/M31');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'M31' });
    expect(res.body.data.alsoKnownAs.length).toBeGreaterThan(0);
  });

  it('answers 404 NOT_FOUND for an object nobody has heard of', async () => {
    for (const url of ['/ZZZ-not-an-object', '/ZZZ-not-an-object/info']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('info carries name, type, constellation and an override slot', async () => {
    const res = await request(app).get('/M31/info');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: expect.any(String), type: expect.any(String), constellation: expect.any(String) });
  });
});

describe('overrides', () => {
  it('only an admin can set or clear one', async () => {
    expect((await request(app).put('/M31/override').set(viewer).send({ description: 'x' })).status).toBe(403);
    expect((await request(app).delete('/M31/override').set(viewer)).status).toBe(403);
  });

  it('a saved override wins on both read routes, and deleting it restores the original', async () => {
    const original = (await request(app).get('/M31')).body.data.description;
    const put = await request(app).put('/M31/override').send({ description: 'My own words about M31.' });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ description: 'My own words about M31.' });

    expect((await request(app).get('/M31')).body.data.description).toBe('My own words about M31.');
    expect((await request(app).get('/M31/info')).body.data.description).toBe('My own words about M31.');

    const del = await request(app).delete('/M31/override');
    expect(del.body.data).toEqual({ removed: true });
    expect((await request(app).get('/M31')).body.data.description).toBe(original);
    expect((await request(app).delete('/M31/override')).body.data).toEqual({ removed: false });
  });

  it('ignores fields of the wrong type instead of storing them, and turns a blank number into "not set"', async () => {
    const put = await request(app).put('/M31/override').send({ name: 42, magnitude: '', distanceLy: '2500000', type: 'Galaxy' });
    expect(put.status).toBe(200);
    expect(put.body.data.name ?? null).toBeNull();
    expect(put.body.data.magnitude ?? null).toBeNull();
    expect(put.body.data.distanceLy).toBe(2500000);
    expect(put.body.data.type).toBe('Galaxy');
  });

  it('treats an array body as an empty patch rather than reading fields off it', async () => {
    const put = await request(app).put('/M31/override').send([{ description: 'sneaky' }]);
    expect(put.status).toBe(200);
    expect(put.body.data.description ?? null).toBeNull();
  });
});

describe('GET /credits/:id', () => {
  it('404s when no pack has credited the object', async () => {
    const res = await request(app).get('/credits/M31');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reads the credit from an installed pack, skips a corrupt file, and normalizes the id', async () => {
    const dir = path.join(TEST_DATA_DIR, 'sky-cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'credits-messier.json'), '{ truncated');
    fs.writeFileSync(path.join(dir, 'credits-caldwell.json'), JSON.stringify({ M31: { source: 'hubble', credit: 'NASA/ESA', licenseUrl: 'https://example.test/l' } }));
    const res = await request(app).get('/credits/M%2031');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ credit: 'NASA/ESA' });
    fs.rmSync(path.join(dir, 'credits-messier.json'));
    fs.rmSync(path.join(dir, 'credits-caldwell.json'));
  });
});

describe('prefetch job routes', () => {
  it('status reports the job, the cache stats and the pack states', async () => {
    const res = await request(app).get('/prefetch/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ phase: getPrefetchStatus().phase, running: false });
    expect(res.body.data.stats).toBeDefined();
    expect(Array.isArray(res.body.data.packStates)).toBe(true);
  });

  it('start is admin only, and a viewer starts nothing', async () => {
    const res = await request(app).post('/prefetch/start').set(viewer);
    expect(res.status).toBe(403);
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it('start passes the query on as typed options', async () => {
    await request(app).post('/prefetch/start?force=1&phase=wikipedia&scope=full&packsOnly=true');
    expect(jobs.start).toHaveBeenCalledWith({ force: true, phase: 'wikipedia', scope: 'full', packsOnly: true });
  });

  it('start falls back to the safe defaults for anything it does not recognise', async () => {
    await request(app).post('/prefetch/start?force=yes&phase=everything&scope=galaxy-wide');
    expect(jobs.start).toHaveBeenCalledWith({ force: false, phase: undefined, scope: 'curated', packsOnly: false });
  });

  it('start tells the caller when a job was already running', async () => {
    jobs.start.mockReturnValue({ started: false, reason: 'already_running' });
    const res = await request(app).post('/prefetch/start');
    expect(res.body.data).toMatchObject({ started: false, reason: 'already_running' });
  });

  it('cancel is admin only and reports whether anything was running', async () => {
    expect((await request(app).post('/prefetch/cancel').set(viewer)).status).toBe(403);
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect((await request(app).post('/prefetch/cancel')).body.data.cancelled).toBe(true);
    jobs.cancel.mockReturnValue(false);
    expect((await request(app).post('/prefetch/cancel')).body.data.cancelled).toBe(false);
  });

  it('wiping the cache needs admin and the exact word "reinitialize"', async () => {
    expect((await request(app).delete('/prefetch/cache').set(viewer).send({ confirmation: 'reinitialize' })).status).toBe(403);
    for (const body of [{}, { confirmation: 'yes' }, { confirmation: 'Reinitialize' }, []]) {
      const res = await request(app).delete('/prefetch/cache').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    }
    const ok = await request(app).delete('/prefetch/cache').send({ confirmation: 'reinitialize' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.wiped).toBe(true);
  });
});

describe('GET /:id/image', () => {
  it('404s NOT_CACHED when there is no master and the sky service has nothing', async () => {
    const res = await request(app).get('/M45/image');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_CACHED');
  });

  it('streams a cached master as-is, with cache headers and 304 on a conditional request', async () => {
    const master = imageCachePath('M81');
    fs.mkdirSync(path.dirname(master), { recursive: true });
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#336699' } }).jpeg().toFile(master);

    const res = await request(app).get('/M81/image');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['cache-control']).toBeTruthy();
    expect(res.headers['last-modified']).toBeTruthy();

    const again = await request(app).get('/M81/image').set('If-Modified-Since', res.headers['last-modified']);
    expect(again.status).toBe(304);
  });

  it('resizes to fit inside the requested box, never enlarging, and caches the result', async () => {
    const small = await request(app).get('/M81/image?w=300&h=300').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(small.status).toBe(200);
    const meta = await sharp(small.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([300, 200]);

    const huge = await request(app).get('/M81/image?w=1900&h=1900').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const hugeMeta = await sharp(huge.body as Buffer).metadata();
    expect([hugeMeta.width, hugeMeta.height]).toEqual([600, 400]);
  });

  it('crops to exactly the box with fill=cover', async () => {
    const res = await request(app).get('/M81/image?w=200&h=200&fill=cover').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const meta = await sharp(res.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([200, 200]);
  });
});

describe('geocode', () => {
  it('reverse refuses missing or non-numeric coordinates', async () => {
    for (const q of ['', '?lat=abc&lon=1', '?lat=1']) {
      const res = await request(app).get(`/geocode/reverse${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PARAMS');
    }
  });

  it('forward search answers an empty list for a query under two characters, without calling out', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await request(app).get('/geocode/search?q=a');
    expect(res.body.data).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('forward search parses the provider response and drops incomplete rows', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      results: [
        { name: 'Boulder', latitude: 40.01, longitude: -105.27, admin1: 'Colorado', country: 'United States', timezone: 'America/Denver' },
        { name: 'No coordinates' },
        'junk',
      ],
    }), { status: 200 }));
    const res = await request(app).get('/geocode/search?q=boulder-test-query');
    expect(res.body.data).toEqual([{
      name: 'Boulder', label: 'Boulder, Colorado, United States', latitude: 40.01, longitude: -105.27,
      timezone: 'America/Denver', country: 'United States', admin1: 'Colorado',
    }]);
    spy.mockRestore();
  });

  it('forward search returns an empty list rather than an error when the provider is down', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const res = await request(app).get('/geocode/search?q=nowhere-offline');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    spy.mockRestore();
  });
});
