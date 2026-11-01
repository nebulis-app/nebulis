import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-settings-skymap-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { settingsRouter } from '../../server/routes/settings';
import { SKY_MAP_CELLS } from '../../server/lib/skyMapConfig';

// A wrong-length visibleSkyMap used to be accepted with a 200 and stored as []
// ("whole sky visible"), silently erasing the user's mask.
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = 'admin';
    next();
  });
  app.use('/', settingsRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const put = (body: unknown) =>
  fetch(`${baseUrl}/`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PUT /settings visibleSkyMap', () => {
  it('rejects a map that is not SKY_MAP_CELLS long', async () => {
    const res = await put({ visibleSkyMap: [true, false, true] });
    expect(res.status).toBe(422);
  });

  it('stores a full-length map and returns it unchanged', async () => {
    const map = Array.from({ length: SKY_MAP_CELLS }, (_, i) => i % 3 === 0);
    const res = await put({ visibleSkyMap: map });
    expect(res.status).toBe(200);
    const got = await (await fetch(`${baseUrl}/`)).json();
    expect(got.data.visibleSkyMap).toEqual(map);
  });
});
