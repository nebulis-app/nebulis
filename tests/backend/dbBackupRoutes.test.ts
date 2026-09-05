import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dbbackuproutes-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 7).toString('base64');
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { storageRouter } from '../../server/routes/storage';
import { createManualDatabaseBackup } from '../../server/lib/db';

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

describe('database backup routes', () => {
  it('creates, lists, downloads and deletes a backup', async () => {
    const create = await fetch(`${baseUrl}/storage/db-backups`, { method: 'POST' });
    expect(create.status).toBe(200);
    const created = (await create.json()).data as { backup: { name: string; kind: string } };
    expect(created.backup.kind).toBe('manual');

    const list = await fetch(`${baseUrl}/storage/db-backups`);
    const listed = (await list.json()).data as { backups: Array<{ name: string }>; maxRetainedPerKind: number };
    expect(listed.backups.some(b => b.name === created.backup.name)).toBe(true);
    expect(listed.maxRetainedPerKind).toBeGreaterThan(0);

    const dl = await fetch(`${baseUrl}/storage/db-backups/${created.backup.name}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/gzip');
    expect((await dl.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const del = await fetch(`${baseUrl}/storage/db-backups/${created.backup.name}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'backups', created.backup.name))).toBe(false);
  });

  it('rejects a traversal name on download and delete', async () => {
    // Create a decoy file outside the backups dir that a traversal would hit.
    const secret = path.join(TEST_DATA_DIR, 'nebulis.db');
    createManualDatabaseBackup(); // ensures nebulis.db exists and has content

    const encoded = encodeURIComponent('../nebulis.db');
    const dl = await fetch(`${baseUrl}/storage/db-backups/${encoded}/download`);
    expect(dl.status).toBe(404);

    const del = await fetch(`${baseUrl}/storage/db-backups/${encoded}`, { method: 'DELETE' });
    expect(del.status).toBe(404);
    expect(fs.existsSync(secret)).toBe(true);
  });

  it('404s an unknown backup name', async () => {
    const res = await fetch(
      `${baseUrl}/storage/db-backups/nebulis-db-20260101T000000.000Z-v9.9.9-manual.db/download`,
    );
    expect(res.status).toBe(404);
  });
});
