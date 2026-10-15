import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-integrationroutes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { LIBRARY_DIR } from '../../server/lib/paths';

let server: http.Server;
let baseUrl: string;
let role: 'admin' | 'viewer' = 'admin';

beforeAll(async () => {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = role;
    next();
  });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function put(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('integration per filter routes', () => {
  it('stores goals and returns them in the breakdown', async () => {
    role = 'admin';
    const res = await put('/objects/M42/integration/goals', {
      goals: [{ filter: 'H-alpha', goalSec: 7200 }, { filter: null, goalSec: 3600 }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([
      { filter: null, goalSec: 3600 },
      { filter: 'Ha', goalSec: 7200 },
    ]);

    const get = await fetch(`${baseUrl}/objects/M42/integration/filters`);
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.data.filters.map((f: { filter: string | null; goalSec: number }) => [f.filter, f.goalSec]))
      .toEqual([['Ha', 7200], [null, 3600]]);
  });

  it('rejects invalid goals with 422', async () => {
    role = 'admin';
    const res = await put('/objects/M42/integration/goals', { goals: [{ filter: 'Ha', goalSec: -5 }] });
    expect(res.status).toBe(422);
  });

  it('refuses goal and alias changes from non-admins', async () => {
    role = 'viewer';
    expect((await put('/objects/M42/integration/goals', { goals: [] })).status).toBe(403);
    expect((await put('/filter-aliases', { aliases: [] })).status).toBe(403);
    role = 'admin';
  });

  it('serves progress for objects with goals', async () => {
    role = 'viewer';
    const res = await fetch(`${baseUrl}/integration/progress`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.find((p: { objectId: string }) => p.objectId === 'M42')?.filters.map((f: { filter: string | null }) => f.filter))
      .toEqual(['Ha', null]);
    role = 'admin';
  });

  it('round-trips filter aliases', async () => {
    role = 'admin';
    const res = await put('/filter-aliases', { aliases: [{ alias: 'Ha 7nm', canonical: 'Ha' }] });
    expect(res.status).toBe(200);
    const list = await (await fetch(`${baseUrl}/filter-aliases`)).json();
    expect(list.data).toEqual([{ alias: 'Ha 7nm', canonical: 'Ha' }]);
  });
});
