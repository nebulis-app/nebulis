/**
 * The unauthenticated media routes (/library/file, /library/processed-images/:id,
 * /telescope/files) stream from disk instead of buffering the whole file, keep
 * every path inside the library, and answer 404/403/413 for what they refuse.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// A dot-free temp DATA_DIR, set before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-file-stream-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { telescopeRouter } from '../../server/routes/telescope';
import { addProcessedImage } from '../../server/lib/library/processed';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';

let server: http.Server;
let base: string;

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]);
let processedId = '';

beforeAll(async () => {
  fs.mkdirSync(path.join(LIBRARY_DIR, 'M31'), { recursive: true });
  fs.writeFileSync(path.join(LIBRARY_DIR, 'M31', 'a.jpg'), JPEG_BYTES);
  fs.writeFileSync(path.join(LIBRARY_DIR, 'M31', 'stack.fits'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(LIBRARY_DIR, 'M31', '.hidden.jpg'), JPEG_BYTES);
  fs.mkdirSync(path.join(LIBRARY_DIR, 'M31', 'folder.jpg'));
  // 33 MB, over the inline-base64 cap, without holding it in the test's memory.
  const big = fs.openSync(path.join(LIBRARY_DIR, 'M31', 'big.jpg'), 'w');
  fs.ftruncateSync(big, 33 * 1024 * 1024);
  fs.closeSync(big);
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'secret.jpg'), JPEG_BYTES);

  db.prepare('INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 1, ?)')
    .run('M31', 'M31', new Date().toISOString());
  const src = path.join(TEST_DATA_DIR, 'processed-src.jpg');
  fs.writeFileSync(src, JPEG_BYTES);
  processedId = addProcessedImage('M31', null, src, 'final.jpg', 'image/jpeg', 'Final', '').id;

  const app = express();
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.userRole = 'viewer'; next(); });
  app.use('/library', libraryRouter);
  app.use('/telescope', telescopeRouter);
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { headers });
const q = (v: string) => encodeURIComponent(v);

describe('GET /library/file', () => {
  it('serves an image inline with the right type, caching and range support', async () => {
    const res = await get(`/library/file?path=${q('M31/a.jpg')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/jpeg');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG_BYTES)).toBe(true);
  });

  it('answers a Range request with 206 and only those bytes (it streams, it does not buffer)', async () => {
    const res = await get(`/library/file?path=${q('M31/a.jpg')}`, { Range: 'bytes=0-9' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-9/${JPEG_BYTES.length}`);
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(10);
  });

  it('serves a non-image as an attachment', async () => {
    const res = await get(`/library/file?path=${q('M31/stack.fits')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it.each([
    ['parent traversal', '../secret.jpg'],
    ['nested traversal', 'M31/../../secret.jpg'],
    ['absolute path', path.join(TEST_DATA_DIR, 'secret.jpg')],
    ['encoded traversal', '%2e%2e/secret.jpg'],
    ['sibling prefix', `../${path.basename(LIBRARY_DIR)}-evil/a.jpg`],
  ])('refuses %s', async (_label, p) => {
    const res = await get(`/library/file?path=${q(p)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('ffd8');
  });

  it('404s for a missing file, a hidden file and a directory', async () => {
    for (const p of ['M31/nope.jpg', 'M31/.hidden.jpg', 'M31/folder.jpg']) {
      const res = await get(`/library/file?path=${q(p)}`);
      expect(res.status, p).toBe(404);
    }
  });

  it('400s without a path', async () => {
    expect((await get('/library/file')).status).toBe(400);
  });
});

describe('GET /library/processed-images/:id', () => {
  it('streams the stored image with its recorded type', async () => {
    const res = await get(`/library/processed-images/${processedId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG_BYTES)).toBe(true);
  });

  it('supports ranges and 404s for an unknown id', async () => {
    expect((await get(`/library/processed-images/${processedId}`, { Range: 'bytes=0-3' })).status).toBe(206);
    expect((await get('/library/processed-images/proc_nope')).status).toBe(404);
  });

  it('404s when the record exists but the file is gone', async () => {
    const row = db.prepare<[string], { objectId: string; filename: string }>('SELECT objectId, filename FROM sessionProcessedImages WHERE id = ?').get(processedId)!;
    const file = path.join(LIBRARY_DIR, row.objectId, 'processed', row.filename);
    const keep = fs.readFileSync(file);
    fs.rmSync(file);
    try {
      expect((await get(`/library/processed-images/${processedId}`)).status).toBe(404);
    } finally {
      fs.writeFileSync(file, keep);
    }
  });
});

describe('GET /telescope/files', () => {
  it('streams a library file by its MyWorks path', async () => {
    const res = await get(`/telescope/files?path=${q('MyWorks/M31/a.jpg')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG_BYTES)).toBe(true);
  });

  it('returns small files as base64 JSON on request', async () => {
    const res = await get(`/telescope/files?path=${q('MyWorks/M31/a.jpg')}&format=base64`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { base64: string; mimeType: string; filename: string; size: number } };
    expect(Buffer.from(body.data.base64, 'base64').equals(JPEG_BYTES)).toBe(true);
    expect(body.data).toMatchObject({ mimeType: 'image/jpeg', filename: 'a.jpg', size: JPEG_BYTES.length });
  });

  it('refuses to inline a file over the base64 cap, with 413', async () => {
    const res = await get(`/telescope/files?path=${q('MyWorks/M31/big.jpg')}&format=base64`);
    expect(res.status).toBe(413);
    // The same file is still available as a stream.
    const streamed = await get(`/telescope/files?path=${q('MyWorks/M31/big.jpg')}`, { Range: 'bytes=0-15' });
    expect(streamed.status).toBe(206);
  });

  it.each([
    ['a path outside MyWorks', 'M31/a.jpg'],
    ['dot-dot segments', 'MyWorks/../secret.jpg'],
    ['dot-dot inside', 'MyWorks/M31/../../secret.jpg'],
  ])('403s for %s', async (_label, p) => {
    expect((await get(`/telescope/files?path=${q(p)}`)).status).toBe(403);
  });

  it('404s for a missing file, 400s for a non-image and for no path', async () => {
    expect((await get(`/telescope/files?path=${q('MyWorks/M31/nope.jpg')}`)).status).toBe(404);
    expect((await get(`/telescope/files?path=${q('MyWorks/M31/notes.txt')}`)).status).toBe(400);
    expect((await get('/telescope/files')).status).toBe(400);
  });

  it('does not leak an absolute path in an error', async () => {
    const res = await get(`/telescope/files?path=${q('MyWorks/M31/nope.jpg')}&format=base64`);
    expect(await res.text()).not.toContain(TEST_DATA_DIR);
  });
});
