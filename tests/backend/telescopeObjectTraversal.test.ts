import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors routeDecoding.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-telescopetraversal-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { telescopeRouter } from '../../server/routes/telescope';
import { LIBRARY_DIR } from '../../server/lib/paths';

// CODE_AUDIT.md Finding 6: GET /telescope/objects/:objectId and .../subs
// joined the raw objectId onto LIBRARY_DIR with no containment check.
// getObjectFolderName falls back to the raw (attacker-controlled) objectId
// on a DB miss, so a crafted id like `..%2F..%2Fetc` escaped LIBRARY_DIR and
// let fs.existsSync/readdirSync/statSync run against arbitrary directories —
// a filesystem enumeration oracle. Mounts the real router (no supertest;
// plain express + http + fetch, same pattern as routeDecoding.test.ts) so
// this exercises Express's actual param decoding, not just the handler's
// own string handling.
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = 'admin';
    next();
  });
  app.use('/', telescopeRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('GET /objects/:objectId — path containment', () => {
  it('rejects a traversal objectId with 400 INVALID_OBJECT_ID instead of statting outside LIBRARY_DIR', async () => {
    const res = await fetch(`${baseUrl}/objects/..%2F..%2Fetc`);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('INVALID_OBJECT_ID');
  });

  it('rejects a deeper traversal objectId the same way', async () => {
    const res = await fetch(`${baseUrl}/objects/..%2F..%2F..%2F..%2Fetc%2Fpasswd`);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('INVALID_OBJECT_ID');
  });

  it('returns 404 (not 400) for a well-formed but nonexistent objectId', async () => {
    const res = await fetch(`${baseUrl}/objects/M999-does-not-exist`);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});

describe('GET /objects/:objectId/subs — path containment', () => {
  it('rejects a traversal objectId with 400 INVALID_OBJECT_ID', async () => {
    const res = await fetch(`${baseUrl}/objects/..%2F..%2Fetc/subs`);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('INVALID_OBJECT_ID');
  });

  it('returns an empty list (not an error) for a well-formed objectId with no sub folder', async () => {
    const res = await fetch(`${baseUrl}/objects/M999-does-not-exist/subs`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });
});
