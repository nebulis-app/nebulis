import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-storage-routes-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { storageRouter } from '../../../server/routes/storage';
import { routeApp } from '../helpers/routeApp';
import { getArchiveConfig, setArchiveConfig } from '../../../server/lib/archive/archiveConfig';

const app = routeApp(storageRouter);
const viewer = { 'x-test-role': 'viewer' };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-storage-routes-scratch-'));

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  setArchiveConfig({ enabled: false, path: '' });
});

describe('reading', () => {
  it('library stats answer immediately and report that they are being computed', async () => {
    const res = await request(app).get('/library');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('objects');
    expect(res.body.meta).toHaveProperty('cacheAge');
    expect(res.body.meta).toHaveProperty('computing');
  });

  it('says whether the caller is on the server machine, and what the server is called', async () => {
    const res = await request(app).get('/client-locality');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.sameMachine).toBe('boolean');
    expect(res.body.data.serverName).toBe(os.hostname().replace(/\.local$/i, ''));
    expect(res.body.data.serverName).not.toMatch(/\.local$/i);
  });

  it('lists volumes', async () => {
    const res = await request(app).get('/volumes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.volumes)).toBe(true);
  });

  it('reports where the library lives and the migration state', async () => {
    const res = await request(app).get('/library-location');
    expect(res.status).toBe(200);
    expect(res.body.data.location).toBeDefined();
    expect(res.body.data).toHaveProperty('migration');
  });

  it('reports migration and re-nest progress, and how many objects are still flat', async () => {
    expect((await request(app).get('/migrate/status')).body.data).toHaveProperty('migration');
    const renest = await request(app).get('/renest/status');
    expect(renest.body.data).toHaveProperty('renest');
    expect(typeof renest.body.data.flatObjects).toBe('number');
  });

  it('reads the library for sub-frame usage and for records that no longer match the disk', async () => {
    const cleanup = await request(app).get('/cleanup');
    expect([200, 503]).toContain(cleanup.status);
    if (cleanup.status === 200) expect(cleanup.body.data).toHaveProperty('subframes');
    const analyze = await request(app).get('/analyze');
    expect([200, 503]).toContain(analyze.status);
  });
});

describe('browse', () => {
  it('needs an absolute path', async () => {
    for (const q of ['', '?path=', '?path=relative/dir', '?path=.']) {
      const res = await request(app).get(`/browse${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PATH');
    }
  });

  it('lists the sub-folders of a real folder, and not its files', async () => {
    fs.mkdirSync(path.join(scratch, 'alpha'));
    fs.mkdirSync(path.join(scratch, 'beta'));
    fs.writeFileSync(path.join(scratch, 'note.txt'), 'x');
    const res = await request(app).get(`/browse?path=${encodeURIComponent(scratch)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.path).toBe(scratch);
    const names = (res.body.data.directories as Array<string | { name: string }>).map(d => (typeof d === 'string' ? d : d.name));
    expect(names).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(names).not.toContain('note.txt');
  });

  it('explains a folder that is not there, and a path that is a file', async () => {
    const missing = await request(app).get(`/browse?path=${encodeURIComponent(path.join(scratch, 'nope'))}`);
    expect([missing.status, missing.body.error.code]).toEqual([400, 'BROWSE_FAILED']);
    expect(missing.body.error.message).toContain('not found');
    const file = await request(app).get(`/browse?path=${encodeURIComponent(path.join(scratch, 'note.txt'))}`);
    expect(file.status).toBe(400);
    expect(file.body.error.message).toMatch(/file, not a folder|not a directory/i);
  });
});

describe('locate-folder', () => {
  it('needs a folder name and a non-empty file sample', async () => {
    for (const body of [{}, { anchorName: 'M42' }, { anchorName: '', samples: [{ relativePath: 'a.fit', size: 1 }] }, { anchorName: 'M42', samples: [] }, [1, 2]]) {
      const res = await request(app).post('/locate-folder').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_LOCATE_INPUT');
    }
  });

  it('drops malformed samples instead of trusting them', async () => {
    const res = await request(app).post('/locate-folder').send({ anchorName: 'M42', samples: [{ relativePath: 5, size: 'x' }, null, 'junk', { relativePath: 'a.fit' }] });
    expect([res.status, res.body.error.code]).toEqual([400, 'INVALID_LOCATE_INPUT']);
  });

  it('a miss is a null path, not an error', async () => {
    const res = await request(app).post('/locate-folder').send({ anchorName: 'a-folder-that-surely-does-not-exist-zz', samples: [{ relativePath: 'x/y.fit', size: 123 }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ path: null });
  });
});

describe('moving the library', () => {
  it('migrate needs a folder to move to', async () => {
    for (const body of [{}, { targetPath: '' }, { targetPath: '   ' }, { targetPath: 7 }]) {
      const res = await request(app).post('/migrate').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(['INVALID_PATH', 'LIBRARY_PINNED']).toContain(res.body.error.code);
    }
  });

  it('a network target needs a server and a share', async () => {
    const res = await request(app).post('/migrate').send({ network: { host: '', share: '' } });
    expect(res.status).toBe(400);
    expect(['INVALID_NETWORK_CONFIG', 'UNSUPPORTED_PLATFORM', 'LIBRARY_PINNED']).toContain(res.body.error.code);
  });

  it('resetting the location is a no-op that says so when the library is already at the default', async () => {
    const res = await request(app).post('/library-location/reset');
    if (res.status === 200) expect(res.body.data).toMatchObject({ ok: true, changed: false });
    else expect(['LIBRARY_PINNED', 'LIBRARY_BUSY']).toContain(res.body.error.code);
  });
});

describe('analyze/fix', () => {
  it('only repairs the categories the analysis reports', async () => {
    for (const category of [undefined, '', 'everything', 'staleRecords ', 7]) {
      const res = await request(app).post('/analyze/fix').send({ category });
      expect(res.status, String(category)).toBe(400);
      expect(res.body.error.code).toBe('BAD_CATEGORY');
    }
  });
});

describe('archive settings', () => {
  it('reads the configuration and the destination state', async () => {
    const res = await request(app).get('/archive');
    expect(res.status).toBe(200);
    expect(res.body.data.config).toMatchObject({ enabled: false });
    expect(res.body.data).toHaveProperty('destination');
  });

  it('refuses a body that is not an object, and a path that is not a string', async () => {
    const arr = await request(app).put('/archive').send([1]);
    expect([arr.status, arr.body.error.code]).toEqual([400, 'ARCHIVE_INVALID_CONFIG']);
    const num = await request(app).put('/archive').send({ path: 5 });
    expect([num.status, num.body.error.code]).toEqual([400, 'ARCHIVE_INVALID_CONFIG']);
  });

  it('refuses an unknown setting and stores none of the others in the same request', async () => {
    const res = await request(app).put('/archive').send({ enabled: true, notASetting: 1 });
    expect([res.status, res.body.error.code]).toEqual([400, 'ARCHIVE_INVALID_CONFIG']);
    expect(getArchiveConfig().enabled).toBe(false);
  });

  it('refuses a destination that is relative or unusable, with a reason the user can act on', async () => {
    const res = await request(app).put('/archive').send({ path: 'relative/folder' });
    expect([res.status, res.body.error.code]).toEqual([400, 'ARCHIVE_INVALID_DESTINATION']);
    expect(res.body.error.message.length).toBeGreaterThan(10);
    const inside = await request(app).put('/archive').send({ path: path.join(TEST_DATA_DIR, 'library') });
    expect([inside.status, inside.body.error.code]).toEqual([400, 'ARCHIVE_INVALID_DESTINATION']);
  });

  it('clearing the destination is allowed', async () => {
    const res = await request(app).put('/archive').send({ path: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.config.path).toBe('');
  });

  it('turns the feature on and off', async () => {
    expect((await request(app).put('/archive').send({ enabled: true })).body.data.config.enabled).toBe(true);
    expect((await request(app).put('/archive').send({ enabled: false })).body.data.config.enabled).toBe(false);
  });
});

describe('archive actions are refused while the feature is off', () => {
  const actions: Array<[string, string, object]> = [
    ['post', '/archive/adopt', {}],
    ['post', '/archive/run', {}],
    ['post', '/archive/retention/apply', {}],
    ['post', '/archive/restore', { items: [{ folderName: 'M42', relPath: 'a.fit' }] }],
  ];

  it.each(actions)('%s %s', async (method, url, body) => {
    const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url).send(body);
    expect([res.status, res.body.error.code]).toEqual([409, 'ARCHIVE_DISABLED']);
  });

  it('reads stay answerable: run status, retention preview and contents', async () => {
    const status = await request(app).get('/archive/run/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ running: false });
    expect((await request(app).get('/archive/retention')).status).toBe(200);
    expect((await request(app).get('/archive/contents')).status).toBe(200);
  });

  it('with the feature on but nothing to prune, retention says it is off, and cancel is harmless', async () => {
    setArchiveConfig({ enabled: true });
    const retention = await request(app).post('/archive/retention/apply');
    expect([retention.status, retention.body.error.code]).toEqual([409, 'ARCHIVE_RETENTION_DISABLED']);
    const cancel = await request(app).post('/archive/run/cancel');
    expect([cancel.status, cancel.body.error.code]).toEqual([409, 'ARCHIVE_NOT_RUNNING']);
  });

  it('with the feature on, a run with no destination says to configure one', async () => {
    setArchiveConfig({ enabled: true, path: '' });
    const res = await request(app).post('/archive/run').send({});
    expect([res.status, res.body.error.code]).toEqual([409, 'ARCHIVE_NO_DESTINATION']);
  });

  it('with the feature on, a restore needs a well-formed list of items', async () => {
    setArchiveConfig({ enabled: true });
    for (const body of [{}, { items: 'a' }, { items: [{ folderName: '', relPath: 'a' }] }, { items: [{ folderName: 'M42' }] }, { items: [null] }]) {
      const res = await request(app).post('/archive/restore').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('ARCHIVE_INVALID_REQUEST');
    }
    const tooMany = await request(app).post('/archive/restore').send({ items: Array.from({ length: 501 }, () => ({ folderName: 'a', relPath: 'b' })) });
    expect([tooMany.status, tooMany.body.error.code]).toEqual([400, 'ARCHIVE_INVALID_REQUEST']);
  });
});

describe('admin-only routes refuse a viewer', () => {
  const adminOnly: Array<[string, string]> = [
    ['get', '/client-locality'], ['get', '/volumes'], ['get', '/browse?path=/'], ['post', '/locate-folder'],
    ['post', '/library-location/network/test'], ['post', '/library-location/reset'], ['post', '/migrate'], ['post', '/renest'],
    ['get', '/cleanup'], ['delete', '/cleanup/subframes'], ['get', '/analyze'], ['post', '/analyze/fix'],
    ['get', '/db-backups'], ['post', '/db-backups'], ['get', '/db-backups/x/download'], ['delete', '/db-backups/x'],
    ['put', '/archive'], ['post', '/archive/adopt'], ['post', '/archive/destination/test'], ['post', '/archive/destination/browse'],
    ['post', '/archive/run'], ['post', '/archive/run/cancel'], ['post', '/archive/retention/apply'], ['post', '/archive/restore'],
  ];

  it.each(adminOnly)('%s %s', async (method, url) => {
    const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url).set(viewer).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
