import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-settings-skymask-test-'));
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

const MASK = Array.from({ length: 288 }, (_, i) => i % 3 !== 0);

describe('visibleSkyMap on save', () => {
  it('testAnEmptyMaskClearsItBecauseThatIsHowEverySiteSaysNoMask', async () => {
    expect((await put({ visibleSkyMap: MASK })).status).toBe(200);
    expect((await read()).visibleSkyMap).toEqual(MASK);

    expect((await put({ visibleSkyMap: [] })).status).toBe(200);
    expect((await read()).visibleSkyMap).toEqual([]);
  });

  it('refuses a wrong-length mask and leaves the stored one alone', async () => {
    expect((await put({ visibleSkyMap: MASK })).status).toBe(200);
    expect((await put({ visibleSkyMap: MASK.slice(0, 287) })).status).toBe(422);
    expect((await read()).visibleSkyMap).toEqual(MASK);
  });

  it('accepts the mask it already holds, unchanged', async () => {
    expect((await put({ visibleSkyMap: MASK })).status).toBe(200);
    expect((await put({ visibleSkyMap: MASK })).status).toBe(200);
    expect((await read()).visibleSkyMap).toEqual(MASK);
  });
});
