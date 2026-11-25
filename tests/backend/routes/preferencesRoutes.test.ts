import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-preferences-routes-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import request from 'supertest';
import { preferencesRouter } from '../../../server/routes/preferences';
import { routeApp } from '../helpers/routeApp';
import db from '../../../server/lib/db';
import { MAX_UI_SETTINGS_KEYS } from '../../../server/lib/userPreferences';

const app = routeApp(preferencesRouter);
const viewer = { 'x-test-role': 'viewer', 'x-test-user': 'viewer-1' };

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare('DELETE FROM userPreferences').run();
});

describe('/preferences/ui', () => {
  it('is an empty object before anything is saved', async () => {
    const res = await request(app).get('/ui');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({});
  });

  it('merges a PATCH into what is saved and returns the result', async () => {
    await request(app).patch('/ui').send({ 'nebulis-theme': 'space', 'catalogs.hidden': '["messier"]' }).expect(200);
    const res = await request(app).patch('/ui').send({ 'catalogs.hidden': null, 'nebulis-library-columns': '4' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ 'nebulis-theme': 'space', 'nebulis-library-columns': '4' });
    expect((await request(app).get('/ui')).body.data).toEqual({ 'nebulis-theme': 'space', 'nebulis-library-columns': '4' });
  });

  it('lets a viewer save their own settings, kept apart from other users', async () => {
    await request(app).patch('/ui').set(viewer).send({ 'nebulis-theme': 'night' }).expect(200);
    expect((await request(app).get('/ui').set(viewer)).body.data).toEqual({ 'nebulis-theme': 'night' });
    expect((await request(app).get('/ui')).body.data).toEqual({});
  });

  it('stores under "default" when nobody is signed in (auth disabled)', async () => {
    await request(app).patch('/ui').set({ 'x-test-user': 'none' }).send({ 'nebulis-theme': 'light' }).expect(200);
    expect((await request(app).get('/ui').set({ 'x-test-user': 'default' })).body.data).toEqual({ 'nebulis-theme': 'light' });
  });

  it('rejects bad bodies with 422', async () => {
    for (const body of [{}, { 'bad key': 'x' }, { k: 1 }, ['a']]) {
      const res = await request(app).patch('/ui').send(body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a PATCH that would store more than the key limit', async () => {
    const many = Object.fromEntries(Array.from({ length: MAX_UI_SETTINGS_KEYS }, (_, i) => [`k${i}`, 'v']));
    await request(app).patch('/ui').send(many).expect(200);
    const res = await request(app).patch('/ui').send({ extra: 'v' });
    expect(res.status).toBe(422);
  });
});
