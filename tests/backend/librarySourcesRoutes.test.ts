import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-sourceroutes-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';

const realFetch = globalThis.fetch;
let server: http.Server;
let baseUrl: string;
let role: 'admin' | 'user' = 'admin';
const roots: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test'; req.userId = 'u'; req.username = 'tester'; req.userRole = role;
    next();
  });
  app.use('/library', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

beforeEach(() => {
  role = 'admin';
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-routes-source-'));
  roots.push(root);
  const dir = path.join(root, '2. Seestar S50 Pro', '1. Caldwell Objects', 'C 1 - Polarissima Cluster');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Stacked_60_C 1_20.0s_IRCUT_20260524-231230.jpg'), 'x'.repeat(64));
  return root;
}

async function call(method: string, url: string, body?: unknown) {
  const res = await realFetch(`${baseUrl}/library${url}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  // Response shapes differ per route and each test narrows what it reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: await res.json() as { data?: any; error?: { code: string } } };
}

describe('/library/sources', () => {
  it('stores the refresh schedule chosen at link time and lets it be changed or cleared', async () => {
    const root = makeRoot();
    const bad = await call('POST', '/sources', { rootPath: root, label: 'x', refreshIntervalMin: 7 });
    expect(bad.status).toBe(400);
    const link = await call('POST', '/sources', { rootPath: root, label: 'x', refreshIntervalMin: 1440 });
    const id = link.body.data.sourceId;
    expect((await call('GET', '/sources')).body.data.sources[0].refreshIntervalMin).toBe(1440);

    expect((await call('PATCH', `/sources/${id}`, { refreshIntervalMin: 60 })).body.data.refreshIntervalMin).toBe(60);
    expect((await call('PATCH', `/sources/${id}`, { refreshIntervalMin: null })).body.data.refreshIntervalMin).toBeNull();
    expect((await call('PATCH', `/sources/${id}`, { refreshIntervalMin: 5 })).body.error?.code).toBe('INVALID_REFRESH');
    expect((await call('PATCH', `/sources/${id}`, {})).status).toBe(400);
  });

  it('saves a name and a schedule together, or neither', async () => {
    const link = await call('POST', '/sources', { rootPath: makeRoot(), label: 'Original' });
    const id = link.body.data.sourceId;

    const both = await call('PATCH', `/sources/${id}`, { label: 'Renamed', refreshIntervalMin: 360 });
    expect(both.body.data).toMatchObject({ label: 'Renamed', refreshIntervalMin: 360 });

    // A valid schedule must not survive an invalid name, and vice versa.
    const badName = await call('PATCH', `/sources/${id}`, { label: '   ', refreshIntervalMin: null });
    expect(badName.body.error?.code).toBe('INVALID_LABEL');
    const badSchedule = await call('PATCH', `/sources/${id}`, { label: 'Nope', refreshIntervalMin: 7 });
    expect(badSchedule.body.error?.code).toBe('INVALID_REFRESH');

    const after = (await call('GET', '/sources')).body.data.sources[0];
    expect(after).toMatchObject({ label: 'Renamed', refreshIntervalMin: 360 });
  });

  it('rejects non-admins on every route', async () => {
    role = 'user';
    for (const [m, u] of [['GET', '/sources'], ['POST', '/sources/scan'], ['POST', '/sources'], ['PATCH', '/sources/x'], ['POST', '/sources/x/rescan'], ['DELETE', '/sources/x']]) {
      expect((await call(m, u, m === 'GET' ? undefined : {})).status).toBe(403);
    }
  });

  it('scan -> link -> list -> rename -> rescan -> unlink, end to end', async () => {
    const root = makeRoot();

    const scan = await call('POST', '/sources/scan', { rootPath: root });
    expect(scan.status).toBe(200);
    expect(scan.body.data.objects.map((o: { objectId: string }) => o.objectId)).toEqual(['NGC188']);

    const link = await call('POST', '/sources', { rootPath: root, label: 'MyWorks' });
    expect(link.status).toBe(200);
    const id = link.body.data.sourceId as string;

    const list = await call('GET', '/sources');
    expect(list.body.data.sources).toMatchObject([{ id, label: 'MyWorks', fileCount: 1, objectCount: 1, offline: false }]);

    expect((await call('PATCH', `/sources/${id}`, { label: 'Renamed' })).body.data.label).toBe('Renamed');
    expect((await call('POST', `/sources/${id}/rescan`)).body.data).toMatchObject({ unchanged: 1, offline: false });

    const del = await call('DELETE', `/sources/${id}`);
    expect(del.body.data.filesUnlinked).toBe(1);
    expect((await call('GET', '/sources')).body.data.sources).toEqual([]);
    expect(fs.readdirSync(path.join(root, '2. Seestar S50 Pro', '1. Caldwell Objects', 'C 1 - Polarissima Cluster'))).toHaveLength(1);
  });

  it('maps failures to stable codes', async () => {
    const root = makeRoot();
    expect((await call('POST', '/sources/scan', { rootPath: path.join(root, 'nope') })).body.error?.code).toBe('NOT_A_DIRECTORY');
    expect((await call('POST', '/sources/scan', { rootPath: TEST_DATA_DIR })).body.error?.code).toBe('OVERLAPS_LIBRARY');
    await call('POST', '/sources', { rootPath: root, label: 'a' });
    const dup = await call('POST', '/sources', { rootPath: root, label: 'b' });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('ALREADY_LINKED');
    expect((await call('DELETE', '/sources/src_missing')).status).toBe(404);
  });
});
