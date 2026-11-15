import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-settings-gallery-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { settingsRouter } from '../../server/routes/settings';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 't'; req.userId = 'u'; req.userRole = 'admin'; next(); });
  app.use('/', settingsRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const read = async () => (await (await fetch(`${baseUrl}/`)).json() as { data: Record<string, unknown> }).data;
const put = (body: unknown) => fetch(`${baseUrl}/`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Gallery opening defaults', () => {
  it('start with both off, so a new install shows every image', async () => {
    const s = await read();
    expect(s.galleryProcessedOnlyDefault).toBe(false);
    expect(s.galleryFavoritesDefault).toBe(false);
  });

  it('save the two independently, so either or both can be on', async () => {
    expect((await put({ galleryFavoritesDefault: true })).status).toBe(200);
    expect(await read()).toMatchObject({ galleryProcessedOnlyDefault: false, galleryFavoritesDefault: true });

    expect((await put({ galleryProcessedOnlyDefault: true })).status).toBe(200);
    expect(await read()).toMatchObject({ galleryProcessedOnlyDefault: true, galleryFavoritesDefault: true });

    expect((await put({ galleryFavoritesDefault: false })).status).toBe(200);
    expect(await read()).toMatchObject({ galleryProcessedOnlyDefault: true, galleryFavoritesDefault: false });
  });
});
