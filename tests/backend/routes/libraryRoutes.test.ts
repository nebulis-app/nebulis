import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';

// Own DATA_DIR (dot-free, so sendFile works), set before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-library-routes-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { libraryRouter } from '../../../server/routes/library';
import { LIBRARY_DIR } from '../../../server/lib/paths';
import { routeApp } from '../helpers/routeApp';
import { updateSettingsData } from '../../../server/lib/telescopes';
import { getActiveSite, updateSite } from '../../../server/lib/observingSites';

const app = routeApp(libraryRouter);
const viewer = { 'x-test-role': 'viewer' };

const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-library-routes-src-'));

function fitsBuffer(cards: Record<string, string | number>): Buffer {
  const lines = [`${'SIMPLE'.padEnd(8)}=${'T'.padStart(21)}`.padEnd(80)];
  for (const [k, v] of Object.entries(cards)) {
    lines.push(`${k.padEnd(8)}= ${(typeof v === 'number' ? String(v) : `'${v}'`).padStart(20)}`.padEnd(80));
  }
  lines.push('END'.padEnd(80));
  const buf = Buffer.alloc(2880, ' ');
  buf.write(lines.join(''), 0, 'ascii');
  return buf;
}

function buildSourceTree() {
  fs.mkdirSync(path.join(sourceRoot, 'M42'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg'), 'jpg-bytes');
  fs.writeFileSync(path.join(sourceRoot, 'M42', 'light_001.fits'), fitsBuffer({ 'DATE-OBS': '2024-01-16T01:00:00', EXPTIME: 30 }));
  fs.mkdirSync(path.join(sourceRoot, 'NGC7000', '2023-09-10'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'NGC7000', '2023-09-10', 'frame.fits'), fitsBuffer({ OBJECT: 'NGC7000', EXPTIME: 60 }));
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

const importStatus = async () => (await request(app).get('/import/status')).body.data as { running: boolean; error: string | null };
const objectIds = async () => ((await request(app).get('/objects')).body.data as Array<{ id: string }>).map(o => o.id).sort();

beforeAll(async () => {
  // Enrichment and weather would call out after an import; the real services are not what is under test.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  updateSettingsData({ groupObservingNights: true });
  updateSite(getActiveSite().id, { timezone: 'UTC' });
  buildSourceTree();

  // Seed through the real two-step import, so the routes below see a library that arrived the way a user's does.
  const scan = await request(app).post('/import/scan').send({ rootPath: sourceRoot, importFits: true });
  const plan = (scan.body.data.objects as Array<{ folderName: string; targetObjectId: string | null; sessions: Array<{ date: string }> }>).map(o => ({
    folderName: o.folderName,
    targetObjectId: o.targetObjectId ?? o.folderName,
    targetFolderName: o.targetObjectId ?? o.folderName,
    sessionMap: Object.fromEntries(o.sessions.map(s => [s.date, s.date])),
  }));
  const commit = await request(app).post('/import/commit').send({ rootPath: sourceRoot, importFits: true, objects: plan });
  expect(commit.status).toBe(200);
  await until(importStatus, s => !s.running, 'the seed import');
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

describe('import scan and commit', () => {
  it('scan refuses a body with no path, a path that is not there, and a path that is a file', async () => {
    const none = await request(app).post('/import/scan').send({});
    expect([none.status, none.body.error.code]).toEqual([400, 'MISSING_PATH']);
    const missing = await request(app).post('/import/scan').send({ rootPath: path.join(sourceRoot, 'nope') });
    expect([missing.status, missing.body.error.code]).toEqual([400, 'INVALID_PATH']);
    const file = await request(app).post('/import/scan').send({ rootPath: path.join(sourceRoot, 'M42', 'light_001.fits') });
    expect([file.status, file.body.error.code]).toEqual([400, 'INVALID_PATH']);
  });

  it('scan reports what it found without importing anything', async () => {
    const res = await request(app).post('/import/scan').send({ rootPath: sourceRoot, importFits: true });
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toMatchObject({ objects: 2 });
    expect(res.body.data.objects.map((o: { folderName: string }) => o.folderName).sort()).toEqual(['M42', 'NGC7000']);
  });

  it('commit refuses an empty plan and a missing folder', async () => {
    const empty = await request(app).post('/import/commit').send({ rootPath: sourceRoot, objects: [] });
    expect([empty.status, empty.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    const missing = await request(app).post('/import/commit').send({
      rootPath: path.join(sourceRoot, 'nope'),
      objects: [{ folderName: 'a', targetObjectId: 'a', targetFolderName: 'a', sessionMap: {} }],
    });
    expect([missing.status, missing.body.error.code]).toEqual([400, 'INVALID_PATH']);
  });

  it('the seed import landed both objects with no error', async () => {
    expect((await importStatus()).error).toBeNull();
    expect(await objectIds()).toEqual(['M42', 'NGC7000']);
  });

  it('refuses a second commit while one is already running', async () => {
    const plan = [{ folderName: 'M42', targetObjectId: 'M42', targetFolderName: 'M42', sessionMap: { '2024-01-15': '2024-01-15' } }];
    const [a, b] = await Promise.all([
      request(app).post('/import/commit').send({ rootPath: sourceRoot, importFits: true, objects: plan }),
      request(app).post('/import/commit').send({ rootPath: sourceRoot, importFits: true, objects: plan }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    await until(importStatus, s => !s.running, 'the repeat import');
  });

  it('import status, history and cancel answer in the expected shape', async () => {
    expect(await importStatus()).toMatchObject({ running: false });
    const history = await request(app).get('/import/history?limit=5');
    expect(history.status).toBe(200);
    const cancel = await request(app).post('/import/cancel').send({});
    expect(cancel.body.data).toEqual({ cancelled: true });
  });
});

describe('reading the library', () => {
  it('lists objects, and filters by search', async () => {
    const all = await request(app).get('/objects');
    expect(all.status).toBe(200);
    const found = await request(app).get('/objects?search=M42');
    expect(found.body.data.map((o: { id: string }) => o.id)).toContain('M42');
    expect(found.body.data.map((o: { id: string }) => o.id)).not.toContain('NGC7000');
  });

  it('returns one object by id and a 404 for one that is not there', async () => {
    const one = await request(app).get('/objects/M42');
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id: 'M42' });
    const none = await request(app).get('/objects/M999');
    expect([none.status, none.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('lists the sessions of an object, newest first when variants are merged', async () => {
    const res = await request(app).get('/objects/M42/sessions');
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { date: string }) => s.date)).toEqual(['2024-01-15']);
    const merged = await request(app).get('/objects/M42/sessions?includeVariants=true');
    expect(merged.body.data[0]).toMatchObject({ date: '2024-01-15', sourceObjectId: 'M42' });
  });

  it('returns an empty session list for an unknown object rather than an error', async () => {
    const res = await request(app).get('/objects/M999/sessions');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('serves the observation list and one observation, marked deprecated', async () => {
    const list = await request(app).get('/observations');
    expect(list.status).toBe(200);
    expect(list.headers.deprecation).toBe('true');
    expect(list.headers.sunset).toBeTruthy();
    const detail = await request(app).get('/observations/M42/2024-01-15');
    expect(detail.status).toBe(200);
  });

  it('serves the object type filters', async () => {
    const res = await request(app).get('/object-filters');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('serves the file list of an object, and a 404 or empty answer rather than a crash for an unknown one', async () => {
    const res = await request(app).get('/objects/M42/files');
    expect(res.status).toBe(200);
    const unknown = await request(app).get('/objects/M999/files');
    expect([200, 404]).toContain(unknown.status);
  });
});

describe('serving files safely', () => {
  it('/file needs a path', async () => {
    expect((await request(app).get('/file')).status).toBe(400);
  });

  it('/file will not serve anything outside the library', async () => {
    const outside = path.join(sourceRoot, 'M42', 'light_001.fits');
    for (const p of [outside, '../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '/etc/passwd', path.join(LIBRARY_DIR, '..', '..', 'etc', 'passwd')]) {
      const res = await request(app).get(`/file?path=${encodeURIComponent(p)}`);
      expect(res.status, p).toBe(404);
    }
  });

  it('/file serves a library file it was pointed at, as an image inline', async () => {
    const files = await request(app).get('/objects/M42/files');
    const jpg = (files.body.data as Array<{ name?: string; relPath?: string; path?: string }>).find(f => /\.jpg$/i.test(f.name ?? f.relPath ?? f.path ?? ''));
    expect(jpg).toBeDefined();
    const rel = jpg!.path ?? jpg!.relPath ?? jpg!.name!;
    const res = await request(app).get(`/file?path=${encodeURIComponent(rel)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['content-disposition'] ?? '').not.toContain('attachment');
  });

  it('/headers needs a path and refuses one outside the library', async () => {
    expect((await request(app).get('/headers')).status).toBe(400);
    const res = await request(app).get(`/headers?path=${encodeURIComponent(path.join(sourceRoot, 'M42', 'light_001.fits'))}`);
    expect([403, 404]).toContain(res.status);
  });

  it('/video needs a path', async () => {
    expect((await request(app).get('/video')).status).toBe(400);
  });
});

describe('settings that ride on the library', () => {
  it('redirects: set, list, remove', async () => {
    const put = await request(app).put('/redirects/Rosette').send({ targetObjectId: 'NGC2237' });
    expect(put.status).toBe(200);
    expect(put.body.data.redirects.length).toBe(1);
    expect((await request(app).get('/redirects')).body.data.redirects.length).toBe(1);
    const del = await request(app).delete('/redirects/Rosette');
    expect(del.body.data.redirects).toEqual([]);
  });

  it('a redirect needs a target', async () => {
    const res = await request(app).put('/redirects/Rosette').send({ targetObjectId: '  ' });
    expect([res.status, res.body.error.code]).toEqual([400, 'BAD_REQUEST']);
  });

  it('filter aliases round trip, and a malformed list is a 422', async () => {
    const put = await request(app).put('/filter-aliases').send({ aliases: [{ alias: 'H-alpha', canonical: 'Ha' }] });
    expect(put.status).toBe(200);
    expect(JSON.stringify((await request(app).get('/filter-aliases')).body.data)).toContain('H-alpha');
    const bad = await request(app).put('/filter-aliases').send({ aliases: [{ alias: 5 }] });
    expect([bad.status, bad.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
    await request(app).put('/filter-aliases').send({ aliases: [] });
  });

  it('integration goals reject a negative or non-integer goal', async () => {
    for (const goalSec of [-1, 1.5, 'lots']) {
      const res = await request(app).put('/objects/M42/integration/goals').send({ goals: [{ filter: 'Ha', goalSec }] });
      expect([res.status, res.body.error.code], String(goalSec)).toEqual([422, 'VALIDATION_ERROR']);
    }
    const ok = await request(app).put('/objects/M42/integration/goals').send({ goals: [{ filter: 'Ha', goalSec: 3600 }] });
    expect(ok.status).toBe(200);
  });
});

describe('changing a session', () => {
  it('rejects a body with no telescope, and 404s for a session that is not there', async () => {
    const bad = await request(app).put('/objects/M42/sessions/2024-01-15/telescope').send({});
    expect([bad.status, bad.body.error.code]).toEqual([400, 'BAD_REQUEST']);
    const none = await request(app).put('/objects/M42/sessions/1999-01-01/telescope').send({ telescopeId: 'x' });
    expect([none.status, none.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('optics 404s for a session that is not there', async () => {
    const none = await request(app).put('/objects/M42/sessions/1999-01-01/optics').send({ opticalConfigId: null });
    expect([none.status, none.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('a move needs a target object', async () => {
    const res = await request(app).post('/objects/M42/sessions/2024-01-15/move').send({});
    expect([res.status, res.body.error.code]).toEqual([400, 'MISSING_TARGET']);
  });

  it('reclassify needs a target', async () => {
    const res = await request(app).post('/objects/M42/reclassify').send({});
    expect([res.status, res.body.error.code]).toEqual([400, 'BAD_REQUEST']);
  });
});

describe('the trash: delete, list, restore', () => {
  it('deleting a session hides it, lists it in the trash, and restoring brings it back', async () => {
    const del = await request(app).delete('/objects/NGC7000/sessions/2023-09-10');
    expect(del.body.data).toEqual({ deleted: true, objectId: 'NGC7000', date: '2023-09-10' });

    const dates = async () => (await request(app).get('/objects/NGC7000/sessions')).body.data.map((s: { date: string }) => s.date);
    expect(await dates()).not.toContain('2023-09-10');
    const trash = await request(app).get('/objects/deleted-sessions');
    expect(JSON.stringify(trash.body.data)).toContain('2023-09-10');

    const back = await request(app).post('/objects/NGC7000/sessions/2023-09-10/restore');
    expect(back.body.data).toEqual({ restored: true, objectId: 'NGC7000', date: '2023-09-10' });
  });

  it('restoring something that is not in the trash is a 404', async () => {
    const obj = await request(app).post('/objects/M42/restore');
    expect([obj.status, obj.body.error.code]).toEqual([404, 'NOT_FOUND']);
    const ses = await request(app).post('/objects/M42/sessions/1999-01-01/restore');
    expect([ses.status, ses.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('deleting an object removes it from the list, puts it in the trash, and restoring returns it', async () => {
    const del = await request(app).delete('/objects/NGC7000');
    expect(del.body.data).toEqual({ deleted: true, objectId: 'NGC7000' });
    expect(await objectIds()).not.toContain('NGC7000');
    expect(JSON.stringify((await request(app).get('/objects/deleted')).body.data)).toContain('NGC7000');

    const back = await request(app).post('/objects/NGC7000/restore');
    expect(back.body.data).toEqual({ restored: true, objectId: 'NGC7000' });
    expect(await objectIds()).toContain('NGC7000');
  });
});

describe('admin-only routes refuse a viewer and change nothing', () => {
  const adminOnly: Array<[string, string]> = [
    ['post', '/import/scan'], ['post', '/import/commit'], ['post', '/import/cancel'],
    ['get', '/sources'], ['post', '/sources'], ['post', '/sources/scan'],
    ['put', '/redirects/Rosette'], ['delete', '/redirects/Rosette'],
    ['post', '/objects/M42/reclassify'],
    ['put', '/objects/M42/sessions/2024-01-15/telescope'], ['put', '/objects/M42/sessions/2024-01-15/optics'], ['put', '/objects/M42/sessions/2024-01-15/site'],
    ['post', '/objects/M42/sessions/2024-01-15/move'],
    ['delete', '/objects/M42'], ['delete', '/objects/M42/sessions/2024-01-15'], ['delete', '/objects/M42/sessions/2024-01-15/subframes'],
    ['post', '/objects/M42/restore'], ['post', '/objects/M42/sessions/2024-01-15/restore'],
    ['get', '/objects/deleted'], ['get', '/objects/deleted-sessions'], ['get', '/objects/M42/linked-files'],
    ['post', '/sample-object'], ['delete', '/sample-object'],
    ['put', '/filter-aliases'], ['put', '/objects/M42/integration/goals'],
    ['post', '/calibrations/attach'], ['delete', '/calibrations/bundle'],
  ];

  it.each(adminOnly)('%s %s', async (method, url) => {
    const req = (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
    const res = await req.set(viewer).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('the library is exactly as it was afterwards', async () => {
    expect(await objectIds()).toEqual(['M42', 'NGC7000']);
  });
});
