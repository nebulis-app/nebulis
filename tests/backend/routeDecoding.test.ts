import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-routedecoding-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { getImportStatus } from '../../server/lib/library/import';
import { stmts } from '../../server/lib/library/objects';
import { createProfile } from '../../server/lib/telescopes';

// Express 5 already decodes route params once. These routes previously called
// decodeURIComponent(req.params.x) again, which is a no-op for plain spaces
// but throws a URIError for an id containing a literal "%" and would let a
// double-encoded ".." traversal payload slip through undetected by any
// upstream check. Mounts the real libraryRouter (no supertest — plain
// express + http + fetch) so this exercises Express's actual param decoding,
// not just the handler's own string handling.
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
  app.use('/', libraryRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function waitForImportIdle(): Promise<void> {
  const deadline = Date.now() + 2000;
  while (getImportStatus().running) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for import lock to release');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('library routes — no double URL-decoding of route params', () => {
  it('resolves an objectId containing a space unchanged', async () => {
    await waitForImportIdle();
    const res = await fetch(`${baseUrl}/objects/${encodeURIComponent('M 16')}/sessions/2026-06-21/sync`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.objectId).toBe('M 16');
    expect(body.data.date).toBe('2026-06-21');
  });

  it('resolves an objectId containing a literal "%" without throwing', async () => {
    await waitForImportIdle();
    // Client-side intent: an object literally named 'M%Test'. To send that as
    // a single path segment, the '%' itself must be percent-encoded (%25).
    const res = await fetch(`${baseUrl}/objects/${encodeURIComponent('M%Test')}/sessions/2026-06-21/sync`, {
      method: 'POST',
    });
    // A double-decode would throw "URI malformed" trying to parse "%Te" as an
    // escape sequence, which previously surfaced as an uncaught exception
    // instead of a clean response.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.objectId).toBe('M%Test');
  });
});

describe('POST /import — objectId without telescopeId falls back to primaryTelescopeId', () => {
  it('returns 422 when the object has no attributed telescope', async () => {
    await waitForImportIdle();
    stmts.upsertObject.run(
      'M99', 'M99', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    const res = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectId: 'M99' }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('NO_TELESCOPE');
  });

  it('falls back to the object primaryTelescopeId when none is given', async () => {
    await waitForImportIdle();
    const profile = createProfile({ name: 'Fallback Scope', kind: 'other', hostname: '10.0.0.10' });
    stmts.upsertObject.run(
      'M100', 'M100', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    stmts.setObjectPrimaryTelescopeIfNull.run(profile.id, 'M100');

    const res = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectId: 'M100' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.telescopeId).toBe(profile.id);
    expect(body.data.all).toBe(false);
  });
});
