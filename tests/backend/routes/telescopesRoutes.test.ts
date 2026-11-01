import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Own DATA_DIR so profile photos land in a scratch folder.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-telescope-routes-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import sharp from 'sharp';
import request from 'supertest';
import { telescopesRouter } from '../../../server/routes/telescopes';
import { routeApp } from '../helpers/routeApp';
import db from '../../../server/lib/db';
import { getProfileById } from '../../../server/lib/telescopes';

const app = routeApp(telescopesRouter);
const viewer = { 'x-test-role': 'viewer' };
const MASK = '••••••••';

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare('DELETE FROM telescopeTransports').run();
  db.prepare('DELETE FROM telescopeProfiles').run();
});

const smb = (name: string, extra: Record<string, unknown> = {}) => ({
  name, kind: 'seestar-s50', connectionType: 'smb', hostname: '192.168.1.50', shareName: 'EMMC Images', username: 'guest', password: 'secret-pw', ...extra,
});

async function create(name = 'Seestar A', extra: Record<string, unknown> = {}) {
  const res = await request(app).post('/').send(smb(name, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; name: string };
}

describe('profiles: create, list, update, delete', () => {
  it('creates a profile and never returns its password', async () => {
    const res = await request(app).post('/').send(smb('Seestar A'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Seestar A', hostname: '192.168.1.50', password: MASK });
    expect(JSON.stringify(res.body)).not.toContain('secret-pw');
  });

  it('lists profiles with masked passwords, transports and the derived fields the UI needs', async () => {
    const a = await create('Seestar A');
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    const row = res.body.data.find((p: { id: string }) => p.id === a.id);
    expect(row).toMatchObject({ password: MASK, sessionCount: 0, rig: expect.anything(), photoVersion: null });
    expect(Array.isArray(row.transports)).toBe(true);
    expect(Array.isArray(row.opticalConfigs)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('secret-pw');
    for (const t of row.transports) expect(t.password === '' || t.password === MASK).toBe(true);
  });

  it('refuses a malformed profile with a 422 naming the problem', async () => {
    for (const body of [{ name: '' }, { kind: 'telescope-9000' }, { hostname: 'bad host name!!' }, { autoImportInterval: -1 }, { importJpg: 'yes' }]) {
      const res = await request(app).post('/').send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('updates a profile, and a masked password sent back means "keep what is stored"', async () => {
    const a = await create('Seestar A');
    expect(getProfileById(a.id)?.password).toBe('secret-pw');
    const res = await request(app).put(`/${a.id}`).send({ name: 'Renamed', password: MASK });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', password: MASK });
    expect(getProfileById(a.id)?.password).toBe('secret-pw');
  });

  it('a new password does replace the stored one', async () => {
    const a = await create('Seestar A');
    await request(app).put(`/${a.id}`).send({ password: 'a-different-pw' });
    expect(getProfileById(a.id)?.password).toBe('a-different-pw');
  });

  it('404s an update to a profile that is not there', async () => {
    const res = await request(app).put('/nope').send({ name: 'x' });
    expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('will not point a profile at a transport or optical config that belongs to another', async () => {
    const a = await create('A');
    const b = await create('B');
    const bTransport = (await request(app).get(`/${b.id}/transports`)).body.data[0];
    const pin = await request(app).put(`/${a.id}`).send({ pinnedTransportId: bTransport.id });
    expect([pin.status, pin.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
    const cfg = (await request(app).post(`/${b.id}/optical-configs`).send({ name: 'Native', focalLengthMm: 250, sensorWidthMm: 5.6, sensorHeightMm: 3.2 })).body.data;
    const active = await request(app).put(`/${a.id}`).send({ activeOpticalConfigId: cfg.id });
    expect([active.status, active.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
  });

  it('deletes a profile, and refuses to delete the only one', async () => {
    const a = await create('A');
    const only = await request(app).delete(`/${a.id}`);
    expect([only.status, only.body.error.code]).toEqual([400, 'DELETE_FAILED']);
    const b = await create('B');
    const del = await request(app).delete(`/${b.id}`);
    expect(del.body.data).toEqual({ deleted: true });
    expect((await request(app).get('/')).body.data.map((p: { id: string }) => p.id)).toEqual([a.id]);
  });
});

describe('archiving', () => {
  it('archive and unarchive are idempotent and 404 for an unknown profile', async () => {
    await create('A');
    const b = await create('B');
    expect((await request(app).post(`/${b.id}/archive`)).body.data).toEqual({ archived: true });
    expect((await request(app).post(`/${b.id}/archive`)).body.data).toEqual({ archived: true });
    expect((await request(app).post(`/${b.id}/unarchive`)).body.data).toEqual({ unarchived: true });
    expect((await request(app).post(`/${b.id}/unarchive`)).body.data).toEqual({ unarchived: true });
    expect((await request(app).post('/nope/archive')).status).toBe(404);
    expect((await request(app).post('/nope/unarchive')).status).toBe(404);
  });
});

describe('reassign-all', () => {
  it('needs a target, refuses the same telescope, and names which side is missing', async () => {
    const a = await create('A');
    const b = await create('B');
    const none = await request(app).post(`/${a.id}/reassign-all`).send({});
    expect([none.status, none.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
    const same = await request(app).post(`/${a.id}/reassign-all`).send({ toTelescopeId: a.id });
    expect([same.status, same.body.error.code]).toEqual([400, 'SAME_TARGET']);
    const noSource = await request(app).post('/ghost/reassign-all').send({ toTelescopeId: b.id });
    expect([noSource.status, noSource.body.error.code]).toEqual([404, 'SOURCE_NOT_FOUND']);
    const noTarget = await request(app).post(`/${a.id}/reassign-all`).send({ toTelescopeId: 'ghost' });
    expect([noTarget.status, noTarget.body.error.code]).toEqual([404, 'TARGET_NOT_FOUND']);
  });

  it('moves nothing and says so when the source has no sessions', async () => {
    const a = await create('A');
    const b = await create('B');
    const res = await request(app).post(`/${a.id}/reassign-all`).send({ toTelescopeId: b.id });
    expect(res.status).toBe(200);
  });
});

describe('transports', () => {
  it('lists, adds, edits and removes a transport, masking the password throughout', async () => {
    const a = await create('A');
    const list = (await request(app).get(`/${a.id}/transports`)).body.data;
    expect(list).toHaveLength(1);

    const add = await request(app).post(`/${a.id}/transports`).send({ kind: 'smb', hostname: '192.168.1.51', shareName: 'Backup', username: 'u', password: 'pw2' });
    expect(add.status).toBe(200);
    expect(add.body.data).toMatchObject({ hostname: '192.168.1.51', password: MASK });
    const tid = add.body.data.id;
    expect(JSON.stringify(add.body)).not.toContain('pw2');

    const edit = await request(app).put(`/${a.id}/transports/${tid}`).send({ hostname: '192.168.1.52', password: MASK });
    expect(edit.body.data).toMatchObject({ hostname: '192.168.1.52', password: MASK });

    const del = await request(app).delete(`/${a.id}/transports/${tid}`);
    expect(del.body.data).toEqual({ deleted: true });
    expect((await request(app).get(`/${a.id}/transports`)).body.data).toHaveLength(1);
  });

  it('never removes the last transport', async () => {
    const a = await create('A');
    const only = (await request(app).get(`/${a.id}/transports`)).body.data[0];
    const res = await request(app).delete(`/${a.id}/transports/${only.id}`);
    expect([res.status, res.body.error.code]).toEqual([400, 'LAST_TRANSPORT']);
  });

  it('404s a transport that is not on this telescope', async () => {
    const a = await create('A');
    const b = await create('B');
    const bTransport = (await request(app).get(`/${b.id}/transports`)).body.data[0];
    expect((await request(app).put(`/${a.id}/transports/${bTransport.id}`).send({ hostname: '10.0.0.1' })).status).toBe(404);
    expect((await request(app).delete(`/${a.id}/transports/${bTransport.id}`)).status).toBe(404);
    expect((await request(app).get('/ghost/transports')).status).toBe(404);
    expect((await request(app).post('/ghost/transports').send({ kind: 'smb' })).status).toBe(404);
  });

  it('refuses a transport kind the device does not speak', async () => {
    const dwarf = await create('Dwarf', { kind: 'dwarf-3', connectionType: 'ftp' });
    const smbOnDwarf = await request(app).post(`/${dwarf.id}/transports`).send({ kind: 'smb', hostname: '192.168.1.60', shareName: 'x' });
    expect([smbOnDwarf.status, smbOnDwarf.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
    const asiair = await create('ASIAIR', { kind: 'asiair' });
    const ftpOnAsiair = await request(app).post(`/${asiair.id}/transports`).send({ kind: 'ftp', hostname: '192.168.1.61' });
    expect([ftpOnAsiair.status, ftpOnAsiair.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
  });

  it('deleting a pinned transport clears the pin', async () => {
    const a = await create('A');
    const add = await request(app).post(`/${a.id}/transports`).send({ kind: 'smb', hostname: '192.168.1.51', shareName: 'Backup' });
    const tid = add.body.data.id;
    await request(app).put(`/${a.id}`).send({ pinnedTransportId: tid });
    expect((await request(app).get('/')).body.data.find((p: { id: string }) => p.id === a.id).pinnedTransportId).toBe(tid);
    await request(app).delete(`/${a.id}/transports/${tid}`);
    expect((await request(app).get('/')).body.data.find((p: { id: string }) => p.id === a.id).pinnedTransportId).toBeNull();
  });
});

describe('optical configurations and rig', () => {
  const config = { name: 'Native', focalLengthMm: 250, sensorWidthMm: 5.6, sensorHeightMm: 3.2 };

  it('adds, lists, edits and deletes a configuration', async () => {
    const a = await create('A');
    const add = await request(app).post(`/${a.id}/optical-configs`).send(config);
    expect(add.body.data).toMatchObject(config);
    const cid = add.body.data.id;
    expect((await request(app).get(`/${a.id}/optical-configs`)).body.data).toHaveLength(1);
    const edit = await request(app).put(`/${a.id}/optical-configs/${cid}`).send({ focalLengthMm: 160 });
    expect(edit.body.data).toMatchObject({ name: 'Native', focalLengthMm: 160 });
    expect((await request(app).delete(`/${a.id}/optical-configs/${cid}`)).body.data).toEqual({ deleted: true });
    expect((await request(app).get(`/${a.id}/optical-configs`)).body.data).toEqual([]);
  });

  it('rejects a configuration with a zero or negative size', async () => {
    const a = await create('A');
    for (const bad of [{ focalLengthMm: 0 }, { sensorWidthMm: -1 }, { name: '' }]) {
      const res = await request(app).post(`/${a.id}/optical-configs`).send({ ...config, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it('404s configurations of an unknown profile, and one that belongs to another profile', async () => {
    const a = await create('A');
    const b = await create('B');
    const cid = (await request(app).post(`/${b.id}/optical-configs`).send(config)).body.data.id;
    expect((await request(app).get('/ghost/optical-configs')).status).toBe(404);
    expect((await request(app).post('/ghost/optical-configs').send(config)).status).toBe(404);
    expect((await request(app).put(`/${a.id}/optical-configs/${cid}`).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/${a.id}/optical-configs/${cid}`)).status).toBe(404);
  });

  it('stores a rig, and rejects a bad sensor type or too many filters', async () => {
    const a = await create('A');
    const ok = await request(app).put(`/${a.id}/rig`).send({ sensorType: 'mono', filters: ['L', 'R', 'G', 'B'] });
    expect(ok.status).toBe(200);
    expect(JSON.stringify((await request(app).get('/')).body.data[0].rig)).toContain('mono');
    const bad = await request(app).put(`/${a.id}/rig`).send({ sensorType: 'infrared', filters: [] });
    expect([bad.status, bad.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
    expect((await request(app).put('/ghost/rig').send({ sensorType: null, filters: [] })).status).toBe(404);
  });
});

describe('profile photo', () => {
  it('has none until one is uploaded', async () => {
    const a = await create('A');
    expect((await request(app).get(`/${a.id}/photo`)).status).toBe(404);
  });

  it('accepts a picture, serves it back as WebP, bumps the version, and deletes it', async () => {
    const a = await create('A');
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#cc3300' } }).png().toBuffer();
    const put = await request(app).put(`/${a.id}/photo`).attach('file', png, 'scope.png');
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.photoVersion).toBeTruthy();

    const get = await request(app).get(`/${a.id}/photo`);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toContain('image/webp');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect((await request(app).get('/')).body.data[0].photoVersion).toBe(put.body.data.photoVersion);

    expect((await request(app).delete(`/${a.id}/photo`)).body.data).toEqual({ deleted: true });
    expect((await request(app).get(`/${a.id}/photo`)).status).toBe(404);
  });

  it('refuses an upload with no file, something that is not a picture, and an unknown profile', async () => {
    const a = await create('A');
    const none = await request(app).put(`/${a.id}/photo`);
    expect([none.status, none.body.error.code]).toEqual([400, 'NO_IMAGE']);
    const text = await request(app).put(`/${a.id}/photo`).attach('file', Buffer.from('not an image'), 'x.png');
    expect(text.status).toBeGreaterThanOrEqual(400);
    expect(text.status).toBeLessThan(500);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
    expect((await request(app).put('/ghost/photo').attach('file', png, 'a.png')).status).toBe(404);
    expect((await request(app).delete('/ghost/photo')).status).toBe(404);
  });
});

describe('admin-only routes refuse a viewer and change nothing', () => {
  const adminOnly: Array<[string, string]> = [
    ['get', '/drives'], ['post', '/probe-identity'], ['post', '/scan'], ['post', '/test-connection'],
    ['get', '/x/transports'], ['post', '/x/transports'], ['put', '/x/transports/y'], ['delete', '/x/transports/y'],
    ['put', '/x/photo'], ['delete', '/x/photo'], ['put', '/x/rig'],
    ['get', '/x/optical-configs'], ['post', '/x/optical-configs'], ['put', '/x/optical-configs/y'], ['delete', '/x/optical-configs/y'],
    ['post', '/'], ['put', '/x'], ['delete', '/x'], ['post', '/x/archive'], ['post', '/x/unarchive'], ['post', '/x/reassign-all'],
  ];

  it.each(adminOnly)('%s %s', async (method, url) => {
    const req = (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
    const res = await req.set(viewer).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('no profile was created or removed along the way', async () => {
    const a = await create('A');
    for (const [method, url] of adminOnly.filter(([, u]) => u === '/' || u === '/x')) {
      await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url).set(viewer).send({ name: 'sneaky' });
    }
    expect((await request(app).get('/')).body.data.map((p: { id: string }) => p.id)).toEqual([a.id]);
  });
});
