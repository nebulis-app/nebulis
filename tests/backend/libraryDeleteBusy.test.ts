import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-delete-busy-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import db from '../../server/lib/db';
import { acquireLibraryLock } from '../../server/lib/libraryBusy';

void TEST_DATA_DIR;

// A delete or move runs synchronously, but it can still land between the awaits of an archive run, a restore or a
// linked scan and rewrite the rows that operation is working on. Only the import flag was checked before.
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  db.prepare('INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 0, ?)')
    .run('M33', 'M33', new Date().toISOString());
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 't'; req.userRole = 'admin'; next(); });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('destructive library routes while the library is busy', () => {
  const cases: Array<[string, string]> = [
    ['DELETE', '/objects/M33'],
    ['DELETE', '/objects/M33/sessions/2026-01-01'],
    ['DELETE', '/file?path=M33%2Fa.jpg'],
  ];

  it.each(cases)('%s %s answers 409 LIBRARY_BUSY while an archive run holds the library', async (method, route) => {
    const release = acquireLibraryLock('archive');
    expect(release).not.toBeNull();
    try {
      const res = await fetch(`${baseUrl}${route}`, { method });
      const body = await res.json() as { error?: { code: string } };
      expect(res.status).toBe(409);
      expect(body.error?.code).toBe('LIBRARY_BUSY');
    } finally {
      release!();
    }
  });

  it('deletes normally once the library is free', async () => {
    const res = await fetch(`${baseUrl}/objects/M33`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});
