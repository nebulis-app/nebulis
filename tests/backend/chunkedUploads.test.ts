import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { createHash, randomBytes, randomUUID } from 'crypto';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time), and shrink the limits so the
// single-POST 413 and multi-chunk paths are cheap to reach.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-chunked-uploads-test-'));
  process.env.DATA_DIR = dir;
  process.env.NEBULIS_MAX_PROCESSED_IMAGE_BYTES = String(1024 * 1024);
  process.env.NEBULIS_UPLOAD_CHUNK_BYTES = String(1024 * 1024);
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { uploadsRouter } from '../../server/routes/uploads';
import { libraryRouter } from '../../server/routes/library';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';
import {
  UPLOAD_STAGING_DIR,
  sweepExpiredUploads,
  _resetUploadCacheForTests,
} from '../../server/lib/library/chunkedUploads';

const MiB = 1024 * 1024;
const KEY_A = 'neb-test-key-a';
const KEY_B = 'neb-test-key-b';

let server: http.Server;
let baseUrl: string;

function seedObject(objectId: string): void {
  stmts.upsertObject.run(
    objectId, objectId, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  fs.mkdirSync(path.join(LIBRARY_DIR, objectId), { recursive: true });
}

beforeAll(async () => {
  seedObject('M52');
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  // Stand-in for apiAuth: every caller is an admin unless it says otherwise;
  // the credential headers pass through untouched for upload ownership.
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = req.headers['x-test-role'] === 'viewer' ? 'viewer' : 'admin';
    next();
  });
  app.use('/uploads', uploadsRouter);
  app.use('/library', libraryRouter);
  server = http.createServer(app);
  server.requestTimeout = 0;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function api(method: string, url: string, opts: { key?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'X-API-Key': opts.key ?? KEY_A, ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`${baseUrl}${url}`, { method, headers, body });
  return { status: res.status, body: await res.json() };
}

async function init(fields: Record<string, unknown>, key = KEY_A) {
  return api('POST', '/uploads', { key, json: { target: 'project-archive', objectId: 'M52', ...fields } });
}

async function putChunk(uploadId: string, index: number, bytes: Buffer, start: number, total: number, key = KEY_A) {
  const res = await fetch(`${baseUrl}/uploads/${uploadId}/chunks/${index}`, {
    method: 'PUT',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${total}`,
    },
    body: bytes,
  });
  return { status: res.status, body: await res.json() };
}

/** Upload a whole buffer in the server's chunk size, in the given order. */
async function sendAll(uploadId: string, file: Buffer, chunkSize: number, order?: number[]) {
  const count = Math.ceil(file.length / chunkSize);
  const indices = order ?? [...Array(count).keys()];
  for (const i of indices) {
    const start = i * chunkSize;
    const r = await putChunk(uploadId, i, file.subarray(start, Math.min(file.length, start + chunkSize)), start, file.length);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
}

describe('chunked upload — happy path', () => {
  it('assembles chunks sent out of order (one twice) into the same record as the single POST', async () => {
    const file = randomBytes(3 * MiB + 12345);
    const digest = sha256(file);
    const started = await init({ filename: 'M52_project.zip', size: file.length, sha256: digest, title: 'HOO', notes: 'n', software: 'PixInsight' });
    expect(started.status).toBe(200);
    const { uploadId, chunkSize, maxSize, expiresAt } = started.body.data;
    expect(chunkSize).toBe(MiB);
    expect(maxSize).toBeGreaterThanOrEqual(16 * 1e9);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    await sendAll(uploadId, file, chunkSize, [3, 1, 0, 1, 2]);

    const status = await api('GET', `/uploads/${uploadId}`);
    expect(status.body.data.received).toEqual([{ start: 0, end: file.length - 1 }]);
    expect(status.body.data.missing).toEqual([]);
    expect(status.body.data.status).toBe('uploading');

    const done = await api('POST', `/uploads/${uploadId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.meta).toEqual({ sha256: digest, size: file.length });
    const record = done.body.data;
    expect(record).toMatchObject({ objectId: 'M52', filename: 'M52_project.zip', size: file.length, title: 'HOO', notes: 'n', software: 'PixInsight' });

    const stored = fs.readFileSync(path.join(LIBRARY_DIR, 'M52', 'project-archives', record.filename));
    expect(sha256(stored)).toBe(digest);

    const list = await api('GET', '/library/objects/M52/project-archives');
    expect(list.body.data.map((r: { id: string }) => r.id)).toContain(record.id);

    // A retried complete (lost response) gets the same record back.
    const again = await api('POST', `/uploads/${uploadId}/complete`);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(record.id);
    expect(fs.existsSync(path.join(UPLOAD_STAGING_DIR, `${uploadId}.part`))).toBe(false);
  });

  it('files a processed image at object level', async () => {
    const file = randomBytes(1000);
    const { body } = await init({ target: 'processed-image', filename: 'M52_final.xisf', size: file.length });
    await sendAll(body.data.uploadId, file, body.data.chunkSize);
    const done = await api('POST', `/uploads/${body.data.uploadId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ objectId: 'M52', date: null, size: 1000 });
    const list = await api('GET', '/library/objects/M52/processed-images');
    expect(list.body.data.map((r: { id: string }) => r.id)).toContain(done.body.data.id);
  });

  it('drops any directory part of the filename', async () => {
    const file = randomBytes(10);
    const { body } = await init({ filename: '../../../etc/evil.zip', size: file.length });
    await sendAll(body.data.uploadId, file, body.data.chunkSize);
    const done = await api('POST', `/uploads/${body.data.uploadId}/complete`);
    expect(done.body.data.filename).toBe('evil.zip');
    expect(done.body.data.path).toBe('M52/project-archives/evil.zip');
  });
});

describe('chunked upload — validation at start', () => {
  it('refuses an extension the target does not take, before any bytes', async () => {
    expect((await init({ filename: 'project.rar', size: 10 })).status).toBe(415);
    expect((await init({ target: 'processed-image', filename: 'x.zip', size: 10 })).status).toBe(415);
  });

  it('refuses a file over the target limit with maxSize', async () => {
    const r = await init({ target: 'processed-image', filename: 'big.tif', size: 2 * MiB });
    expect(r.status).toBe(413);
    expect(r.body.error.maxSize).toBe(MiB);
  });

  it('refuses early when the disk cannot hold the declared size', async () => {
    process.env.NEBULIS_MAX_PROJECT_ARCHIVE_BYTES = String(Number.MAX_SAFE_INTEGER);
    try {
      const r = await init({ filename: 'huge.zip', size: 2 ** 52 });
      expect(r.status).toBe(507);
      expect(r.body.error.code).toBe('INSUFFICIENT_STORAGE');
      expect(r.body.error.message).toMatch(/Not enough free space/);
    } finally {
      delete process.env.NEBULIS_MAX_PROJECT_ARCHIVE_BYTES;
    }
  });

  it('rejects a bad sha256 and a non-positive size', async () => {
    expect((await init({ filename: 'a.zip', size: 10, sha256: 'xyz' })).status).toBe(422);
    expect((await init({ filename: 'a.zip', size: 0 })).status).toBe(422);
  });
});

describe('chunked upload — chunk checks', () => {
  it('refuses a range that is not the chunk, or runs past the declared size', async () => {
    const { body } = await init({ filename: 'r.zip', size: 2 * MiB });
    const id = body.data.uploadId;
    expect((await putChunk(id, 0, randomBytes(10), 5, 2 * MiB)).status).toBe(416);
    expect((await putChunk(id, 1, randomBytes(MiB), MiB, 3 * MiB)).status).toBe(416);
    expect((await putChunk(id, 2, randomBytes(10), 2 * MiB, 2 * MiB)).status).toBe(400);
    // Content-Range matches but the body is short: Content-Length gives it away.
    const res = await fetch(`${baseUrl}/uploads/${id}/chunks/0`, {
      method: 'PUT',
      headers: { 'X-API-Key': KEY_A, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${MiB - 1}/${2 * MiB}` },
      body: randomBytes(100),
    });
    expect(res.status).toBe(400);
    const status = await api('GET', `/uploads/${id}`);
    expect(status.body.data.received).toEqual([]);
  });

  it('will not complete with chunks missing, or with a wrong checksum', async () => {
    const file = randomBytes(2 * MiB);
    const { body } = await init({ filename: 'c.zip', size: file.length, sha256: sha256(randomBytes(4)) });
    const id = body.data.uploadId;
    await sendAll(id, file, MiB, [0]);
    const early = await api('POST', `/uploads/${id}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.missing).toEqual([1]);
    await sendAll(id, file, MiB, [1]);
    const bad = await api('POST', `/uploads/${id}/complete`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CHECKSUM_MISMATCH');
    expect(bad.body.error.actual).toBe(sha256(file));
  });
});

describe('chunked upload — resume', () => {
  it('a chunk cut off mid-send stays missing and can be resent', async () => {
    const file = randomBytes(3 * MiB);
    const { body } = await init({ filename: 'resume.zip', size: file.length, sha256: sha256(file) });
    const id = body.data.uploadId;
    await sendAll(id, file, MiB, [0, 1, 2]);

    // Resend chunk 1 and drop the connection half way: the old bytes are
    // partly overwritten, so it must no longer count as received.
    await new Promise<void>(resolve => {
      const req = http.request(`${baseUrl}/uploads/${id}/chunks/1`, {
        method: 'PUT',
        headers: {
          'X-API-Key': KEY_A,
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${MiB}-${2 * MiB - 1}/${file.length}`,
          'Content-Length': String(MiB),
        },
      });
      req.on('error', () => resolve());
      req.write(randomBytes(MiB / 2), () => setTimeout(() => { req.destroy(); resolve(); }, 100));
    });

    let status = await api('GET', `/uploads/${id}`);
    for (let i = 0; i < 50 && status.body.data.missing.length === 0; i++) {
      await new Promise(r => setTimeout(r, 20));
      status = await api('GET', `/uploads/${id}`);
    }
    expect(status.body.data.missing).toEqual([1]);
    expect(status.body.data.received).toEqual([{ start: 0, end: MiB - 1 }, { start: 2 * MiB, end: 3 * MiB - 1 }]);

    // Resend what GET says is missing (retrying while the dead write unwinds).
    let resent = await putChunk(id, 1, file.subarray(MiB, 2 * MiB), MiB, file.length);
    for (let i = 0; i < 50 && resent.status === 409; i++) {
      await new Promise(r => setTimeout(r, 20));
      resent = await putChunk(id, 1, file.subarray(MiB, 2 * MiB), MiB, file.length);
    }
    expect(resent.status).toBe(200);
    expect(resent.body.data.chunk.sha256).toBe(sha256(file.subarray(MiB, 2 * MiB)));

    const done = await api('POST', `/uploads/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.meta.sha256).toBe(sha256(file));
  });

  it('survives a restart: state is reloaded from disk', async () => {
    const file = randomBytes(2 * MiB);
    const { body } = await init({ filename: 'restart.zip', size: file.length });
    const id = body.data.uploadId;
    await sendAll(id, file, MiB, [1]);
    _resetUploadCacheForTests();
    const status = await api('GET', `/uploads/${id}`);
    expect(status.body.data.missing).toEqual([0]);
    await sendAll(id, file, MiB, [0]);
    expect((await api('POST', `/uploads/${id}/complete`)).status).toBe(200);
  });
});

describe('chunked upload — expiry and abort', () => {
  it('sweeps uploads idle past the expiry and their staging files', async () => {
    const { body } = await init({ filename: 'old.zip', size: 2 * MiB });
    const id = body.data.uploadId;
    await sendAll(id, randomBytes(2 * MiB), MiB, [0]);
    const fresh = await init({ filename: 'fresh.zip', size: 10 });
    expect(fs.existsSync(path.join(UPLOAD_STAGING_DIR, `${id}.part`))).toBe(true);

    expect(sweepExpiredUploads(Date.now() + 60_000)).toBe(0);
    const later = Date.now() + 25 * 60 * 60 * 1000;
    expect(sweepExpiredUploads(later)).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(UPLOAD_STAGING_DIR, `${id}.part`))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_STAGING_DIR, `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_STAGING_DIR, `${fresh.body.data.uploadId}.json`))).toBe(false);
    expect((await api('GET', `/uploads/${id}`)).status).toBe(404);
  });

  it('DELETE removes the staging file', async () => {
    const { body } = await init({ filename: 'gone.zip', size: 10 });
    const id = body.data.uploadId;
    const r = await api('DELETE', `/uploads/${id}`);
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(UPLOAD_STAGING_DIR, `${id}.part`))).toBe(false);
    expect((await api('GET', `/uploads/${id}`)).status).toBe(404);
  });
});

describe('chunked upload — access', () => {
  it('refuses a non-admin on every endpoint', async () => {
    const viewer = { headers: { 'X-Test-Role': 'viewer' } };
    const id = randomUUID();
    expect((await api('POST', '/uploads', { ...viewer, json: { target: 'project-archive', objectId: 'M52', filename: 'a.zip', size: 1 } })).status).toBe(403);
    expect((await api('GET', `/uploads/${id}`, viewer)).status).toBe(403);
    expect((await api('PUT', `/uploads/${id}/chunks/0`, viewer)).status).toBe(403);
    expect((await api('POST', `/uploads/${id}/complete`, viewer)).status).toBe(403);
    expect((await api('DELETE', `/uploads/${id}`, viewer)).status).toBe(403);
  });

  it('binds an upload to the key that created it', async () => {
    const file = randomBytes(10);
    const { body } = await init({ filename: 'mine.zip', size: file.length }, KEY_A);
    const id = body.data.uploadId;
    expect((await api('GET', `/uploads/${id}`, { key: KEY_B })).status).toBe(404);
    expect((await putChunk(id, 0, file, 0, file.length, KEY_B)).status).toBe(404);
    expect((await api('POST', `/uploads/${id}/complete`, { key: KEY_B })).status).toBe(404);
    expect((await api('DELETE', `/uploads/${id}`, { key: KEY_B })).status).toBe(404);
    // Still intact for its owner.
    expect((await putChunk(id, 0, file, 0, file.length, KEY_A)).status).toBe(200);
    expect((await api('POST', `/uploads/${id}/complete`, { key: KEY_A })).status).toBe(200);
  });

  it('refuses an unknown or malformed uploadId', async () => {
    for (const id of [randomUUID(), 'not-an-id', '..%2F..%2Fetc']) {
      expect((await api('GET', `/uploads/${id}`)).status).toBe(404);
      expect((await api('POST', `/uploads/${id}/complete`)).status).toBe(404);
    }
  });
});

describe('single-POST endpoints', () => {
  it('still store a small processed image as before', async () => {
    const form = new FormData();
    form.append('image', new Blob([randomBytes(1000)]), 'small.jpg');
    form.append('title', 'small');
    const res = await fetch(`${baseUrl}/library/objects/M52/processed-images`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ title: 'small', size: 1000 });
  });

  it('answer 413 with maxSize for a file over the limit', async () => {
    const form = new FormData();
    form.append('image', new Blob([randomBytes(MiB + 1)]), 'big.jpg');
    const res = await fetch(`${baseUrl}/library/objects/M52/processed-images`, { method: 'POST', body: form });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('LIMIT_FILE_SIZE');
    expect(body.error.maxSize).toBe(MiB);
    expect(body.error.message).toMatch(/POST \/uploads/);
  });

  it('answer 413 from Content-Length alone, before reading the body', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${baseUrl}/library/objects/M52/processed-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(500 * MiB) },
      }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });
});

// A real >2 GB file: slow (≈ a minute and a few GB of disk), so opt-in:
//   NEBULIS_LARGE_UPLOAD_TEST=1 npx vitest run tests/backend/chunkedUploads.test.ts
describe.skipIf(process.env.NEBULIS_LARGE_UPLOAD_TEST !== '1')('chunked upload — larger than 2 GB', () => {
  it('stores a 2.1 GiB archive sent in 64 MiB chunks out of order, with memory flat', async () => {
    process.env.NEBULIS_UPLOAD_CHUNK_BYTES = String(64 * MiB);
    try {
      const size = 2 * 1024 * MiB + 100 * MiB + 4321;
      const base = randomBytes(64 * MiB);
      const count = Math.ceil(size / (64 * MiB));
      /** Chunk i: the base block with its index stamped in, so chunks differ. */
      const chunkBytes = (i: number) => {
        const start = i * 64 * MiB;
        const len = Math.min(size, start + 64 * MiB) - start;
        const b = Buffer.from(base.subarray(0, len));
        b.writeUInt32BE(i, 0);
        return b;
      };
      const hash = createHash('sha256');
      for (let i = 0; i < count; i++) hash.update(chunkBytes(i));
      const digest = hash.digest('hex');

      const { body } = await init({ filename: 'M52_big.zip', size, sha256: digest });
      const id = body.data.uploadId;
      expect(body.data.chunkSize).toBe(64 * MiB);

      const order = [...Array(count).keys()].reverse();
      order.splice(5, 0, order[2]); // one chunk sent twice
      const rssBefore = process.memoryUsage().rss;
      let rssPeak = rssBefore;
      for (const i of order) {
        const r = await putChunk(id, i, chunkBytes(i), i * 64 * MiB, size);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      }
      // Client and server share this process: a few chunk buffers, never the file.
      expect(rssPeak - rssBefore).toBeLessThan(512 * MiB);

      const done = await api('POST', `/uploads/${id}/complete`);
      expect(done.status).toBe(200);
      expect(done.body.meta).toEqual({ sha256: digest, size });
      expect(done.body.data.size).toBe(size);
      const storedPath = path.join(LIBRARY_DIR, 'M52', 'project-archives', done.body.data.filename);
      expect(fs.statSync(storedPath).size).toBe(size);

      const list = await api('GET', '/library/objects/M52/project-archives');
      const listed = list.body.data.find((r: { id: string }) => r.id === done.body.data.id);
      expect(listed.size).toBe(size);
      fs.unlinkSync(storedPath);
    } finally {
      process.env.NEBULIS_UPLOAD_CHUNK_BYTES = String(MiB);
    }
  }, 600_000);
});
