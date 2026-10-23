import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR to an isolated temp dir before any server module loads.
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-cluster-test-'));
});

import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { collectClusterCounts, getClusterItems, clearClusterImageCache } from '../../server/lib/library/cluster';

function file(objectId: string, name: string, role: string, missing: string | null = null) {
  db.prepare(
    `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, importedAt, missingSince)
     VALUES (?, ?, ?, ?, ?, 1, '2026-01-01T00:00:00Z', ?)`,
  ).run(objectId, `${objectId}/${name}`, name, name, role, missing);
}

function processed(objectId: string, id: string, originalName: string, uploadedAt: string) {
  db.prepare(
    `INSERT INTO sessionProcessedImages (id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt, source)
     VALUES (?, ?, '2026-01-01', ?, ?, '', '', 1, 'image/jpeg', ?, 'user')`,
  ).run(id, objectId, `processed/${id}.jpg`, originalName, uploadedAt);
}

describe('library cluster counts', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM sessionProcessedImages').run();
    clearClusterImageCache();
  });

  it('counts stacks, subs and processed images per object in one pass', () => {
    file('M31', 'a.jpg', 'stacked'); file('M31', 'b.jpg', 'stacked');
    file('M31', 's1.fit', 'sub'); file('M31', 's2.fit', 'sub'); file('M31', 's3.fit', 'sub');
    processed('M31', 'p1', 'final.jpg', '2026-02-01T00:00:00Z');
    file('M42', 'c.jpg', 'stacked');

    const counts = collectClusterCounts();
    expect(counts.get('M31')).toMatchObject({ stacked: 2, subs: 3, processed: 1, newestProcessed: '2026-02-01T00:00:00Z' });
    expect(counts.get('M42')).toMatchObject({ stacked: 1, subs: 0, processed: 0 });
    expect(counts.has('M45')).toBe(false);
  });

  it('ignores files that have gone missing, and thumbnails and previews', () => {
    file('M31', 'a.jpg', 'stacked', '2026-03-01T00:00:00Z');
    file('M31', 't.jpg', 'thumbnail');
    file('M31', 'p.jpg', 'preview');
    expect(collectClusterCounts().get('M31')).toBeUndefined();
  });

  it('does not count Dwarf stacked-thumbnail previews as processed images', () => {
    processed('M31', 'p1', 'stacked_thumbnail.jpg', '2026-02-01T00:00:00Z');
    processed('M31', 'p2', 'real.jpg', '2026-02-02T00:00:00Z');
    expect(collectClusterCounts().get('M31')?.processed).toBe(1);
  });

  it('returns no picture for files that are not on disk, rather than a survey image', async () => {
    file('M31', 'a.jpg', 'stacked');
    processed('M31', 'p1', 'final.jpg', '2026-02-01T00:00:00Z');
    const items = await getClusterItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ objectId: 'M31', stackedCount: 1, processedCount: 1, subCount: 0 });
    expect(items[0].image).toBeNull();
  });

  it('is empty for an empty library', async () => {
    expect(await getClusterItems()).toEqual([]);
  });
});

describe('GET /library/cluster', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.username = 'tester'; req.userRole = 'admin'; next(); });
    app.use('/library', libraryRouter);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM sessionProcessedImages').run();
    clearClusterImageCache();
  });

  it('answers with the standard envelope, not as an object id', async () => {
    file('M31', 'a.jpg', 'stacked'); file('M31', 's1.fit', 'sub');
    const res = await fetch(`${baseUrl}/library/cluster`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: Array<{ objectId: string; stackedCount: number; subCount: number; processedCount: number }> };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([expect.objectContaining({ objectId: 'M31', stackedCount: 1, subCount: 1, processedCount: 0, image: null })]);
  });
});
