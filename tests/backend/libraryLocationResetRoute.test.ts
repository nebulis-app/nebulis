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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-locreset-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { storageRouter } from '../../server/routes/storage';
import {
  getLibraryDir, getDefaultLibraryDir, isDefaultLocation, isNetworkLocation,
  setLibraryPath, setNetworkLibraryConfig, getLibraryId, writeMarker,
} from '../../server/lib/libraryPath';

// Mirrors libraryNetwork.test.ts's setPlatform/ORIGINAL_PLATFORM pattern.
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}
const ORIGINAL_PLATFORM = process.platform;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = 'admin';
    next();
  });
  app.use('/storage', storageRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  setPlatform(ORIGINAL_PLATFORM);
  await setLibraryPath('');
});

describe('POST /storage/library-location/reset', () => {
  it('clears an unreachable relocated path without moving files', async () => {
    const gonePath = path.join(TEST_DATA_DIR, 'D-drive', 'Nebulis');
    await setLibraryPath(gonePath);
    expect(isDefaultLocation()).toBe(false);

    const res = await fetch(`${baseUrl}/storage/library-location/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()).data as { ok: boolean; changed: boolean; previousPath: string; path: string };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.previousPath).toBe(gonePath);
    expect(body.path).toBe(getDefaultLibraryDir());
    expect(isDefaultLocation()).toBe(true);
    expect(getLibraryDir()).toBe(getDefaultLibraryDir());
  });

  it('is a no-op (changed:false) when already at the default location', async () => {
    const res = await fetch(`${baseUrl}/storage/library-location/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()).data as { changed: boolean };
    expect(body.changed).toBe(false);
  });

  it('clears a stored network-share configuration', async () => {
    setNetworkLibraryConfig({
      host: 'nas.local', share: 'Photos', domain: '', username: '', password: 'secret', subpath: 'Nebulis',
    });
    expect(isNetworkLocation()).toBe(true);

    const res = await fetch(`${baseUrl}/storage/library-location/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(isNetworkLocation()).toBe(false);
    expect(isDefaultLocation()).toBe(true);
  });

  // Regression test: the route used to call getLibraryDir() just to describe
  // the location being left behind.  resolveNetworkLibraryPath (libraryNetwork.ts)
  // used to throw on any platform other than win32/darwin, so a network config
  // configured on macOS and then run on Linux/Docker would 500 before the reset
  // ever ran — on precisely the platform most likely to need the escape hatch.
  // That was fixed by two changes: (1) describeLibraryLocation() in libraryPath.ts,
  // which the route now calls instead of getLibraryDir(), and (2) the upstream
  // change to resolveNetworkLibraryPath itself, which now returns a UNC-style
  // display string on every platform instead of throwing — making it safe for the
  // route to call either function on Linux.  The core guarantee this test locks in
  // is that POST /storage/library-location/reset succeeds (200) on Linux even when
  // the current config points at a network share.
  it('clears a network config even on a platform that cannot resolve a real path for it (Linux/Docker)', async () => {
    setNetworkLibraryConfig({
      host: 'nas.local', share: 'Photos', domain: '', username: '', password: 'secret', subpath: 'Nebulis',
    });
    expect(isNetworkLocation()).toBe(true);
    setPlatform('linux');
    // resolveNetworkLibraryPath no longer throws on Linux — it returns a
    // UNC-style display string instead.  The route uses describeLibraryLocation()
    // which delegates to it, so either way no exception reaches the handler.
    expect(() => getLibraryDir()).not.toThrow();

    const res = await fetch(`${baseUrl}/storage/library-location/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()).data as { changed: boolean; previousPath: string };
    expect(body.changed).toBe(true);
    // previousPath is whatever describeLibraryLocation() returns — a UNC path
    // on Linux now that resolveNetworkLibraryPath no longer throws there.
    expect(body.previousPath).toContain('nas.local');
    expect(isNetworkLocation()).toBe(false);
    expect(isDefaultLocation()).toBe(true);
  });

  it('also clears a still-reachable relocated library (no files touched)', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'reachable-'));
    writeMarker(dir, getLibraryId());
    fs.writeFileSync(path.join(dir, 'keepme.txt'), 'x');
    await setLibraryPath(dir);

    const res = await fetch(`${baseUrl}/storage/library-location/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(isDefaultLocation()).toBe(true);
    // The old directory and its contents are left exactly as they were.
    expect(fs.existsSync(path.join(dir, 'keepme.txt'))).toBe(true);
  });
});
