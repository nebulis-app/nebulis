import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// A linked folder's object has no managed folder under LIBRARY_DIR; its files
// exist only as libraryFiles rows pointing at the user's own disk. Every screen
// that walked LIBRARY_DIR instead of reading those rows silently showed nothing
// (the Gallery did, until it got its own linked pass). These tests link a real
// folder through the HTTP API and check each place a user looks for it.

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedvisibility-'));
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
import { getLibraryDir } from '../../server/lib/libraryPath';

const realFetch = globalThis.fetch;
let server: http.Server;
let baseUrl: string;
const roots: string[] = [];

const OBJECT_ID = 'NGC188';
const STACKED = 'Stacked_60_C 1_20.0s_IRCUT_20260524-231230.jpg';
const SUB = 'Light_C 1_20.0s_IRCUT_20260524-231500.jpg';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test'; req.userId = 'u'; req.username = 'tester'; req.userRole = 'admin';
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
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
});

/** A SeeStar-style folder: one stacked image plus a sub-frame in its _sub folder. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-visibility-source-'));
  roots.push(root);
  const dir = path.join(root, 'Seestar', 'C 1 - Polarissima Cluster');
  fs.mkdirSync(path.join(dir, 'C 1_sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, STACKED), 'stacked-bytes');
  fs.writeFileSync(path.join(dir, 'C 1_sub', SUB), 'sub-bytes');
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

async function linkRoot(root: string): Promise<string> {
  const link = await call('POST', '/sources', { rootPath: root, label: 'MyWorks' });
  expect(link.status).toBe(200);
  return link.body.data.sourceId as string;
}

describe('a linked folder\'s object is visible everywhere a copied one is', () => {
  it('has no managed folder, so these tests really exercise the linked path', async () => {
    await linkRoot(makeRoot());
    expect(fs.existsSync(path.join(getLibraryDir(), OBJECT_ID))).toBe(false);
  });

  it('appears in the library object list', async () => {
    await linkRoot(makeRoot());
    const res = await call('GET', '/objects');
    expect(res.status).toBe(200);
    expect(res.body.data.map((o: { id: string }) => o.id)).toContain(OBJECT_ID);
  });

  it('shows its session and its stacked image on the object page', async () => {
    await linkRoot(makeRoot());

    const sessions = await call('GET', `/objects/${OBJECT_ID}/sessions`);
    expect(sessions.status).toBe(200);
    expect(sessions.body.data.map((s: { date: string }) => s.date)).toEqual(['2026-05-24']);

    const files = await call('GET', `/objects/${OBJECT_ID}/files`);
    expect(files.status).toBe(200);
    const stacked = files.body.data.find((f: { name: string }) => f.name === STACKED);
    expect(stacked?.path).toMatch(/^@src\//);
  });

  it('offers its own stacked image in the cover-image picker', async () => {
    await linkRoot(makeRoot());
    const res = await call('GET', `/objects/${OBJECT_ID}/stacked-images`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: { name: string }) => i.name)).toEqual([STACKED]);
    expect(res.body.data[0].path).toMatch(/^@src\//);
  });

  it('shows its stacked image in the Gallery, and the image actually loads', async () => {
    await linkRoot(makeRoot());
    const res = await call('GET', '/all-images');
    expect(res.status).toBe(200);
    const mine = res.body.data.items.filter((i: { objectId: string }) => i.objectId === OBJECT_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: STACKED, date: '2026-05-24', isProcessed: false });
    expect(mine[0].path).toMatch(/^@src\//);

    const file = await realFetch(`${baseUrl}${mine[0].downloadUrl.replace(/^\/api\/v1/, '')}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('stacked-bytes');
  });

  it('keeps linked sub-frames out of the Gallery', async () => {
    await linkRoot(makeRoot());
    const res = await call('GET', '/all-images');
    expect(res.body.data.items.map((i: { name: string }) => i.name)).not.toContain(SUB);
  });

  it('drops out of the Gallery as soon as the folder is unlinked, not after the cache expires', async () => {
    const id = await linkRoot(makeRoot());
    expect((await call('GET', '/all-images')).body.data.total).toBe(1);
    await call('DELETE', `/sources/${id}`);
    expect((await call('GET', '/all-images')).body.data.total).toBe(0);
  });
});
