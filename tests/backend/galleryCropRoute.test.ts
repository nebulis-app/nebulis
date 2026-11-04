import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Same isolation recipe as objectThumbnailSourceSafety.test.ts: a dot-free temp
// DATA_DIR (sendFile 404s under a dotted path) set before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-gallery-crop-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';

const OBJECT_ID = 'M33';
const REL = `${OBJECT_ID}/gallery_${OBJECT_ID}.png`;

let server: http.Server;
let baseUrl: string;

/** 400x300: left half red, right half blue, so a crop's colour says which side it came from. */
async function writeFixture() {
  const left = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#ff0000' } }).png().toBuffer();
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#0000ff' } })
    .composite([{ input: left, left: 0, top: 0 }])
    .png()
    .toFile(path.join(LIBRARY_DIR, REL));
}

async function thumb(w = 400, h = 400) {
  const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}/thumbnail?w=${w}&h=${h}`);
  expect(res.status).toBe(200);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  const { data } = await sharp(buf).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
  return { width: meta.width!, height: meta.height!, rgb: [data[0], data[1], data[2]] };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(LIBRARY_DIR, OBJECT_ID), { recursive: true });
  await writeFixture();
  db.prepare('INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 1, ?)')
    .run(OBJECT_ID, OBJECT_ID, new Date().toISOString());
  db.prepare('UPDATE libraryObjects SET galleryImage = ?, galleryImageUserSet = 1 WHERE objectId = ?').run(REL, OBJECT_ID);

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 't'; req.userId = null; req.userRole = 'admin'; next(); });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

// Every test starts from the same row: image chosen by the user, no crop. Tests change both, so without
// this they pass or fail depending on which ran before them.
beforeEach(() => {
  db.prepare('UPDATE libraryObjects SET galleryImage = ?, galleryImageUserSet = 1, galleryCrop = NULL WHERE objectId = ?').run(REL, OBJECT_ID);
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const putCrop = (crop: unknown) =>
  fetch(`${baseUrl}/objects/${OBJECT_ID}/gallery-crop`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crop }),
  });

describe('object gallery crop', () => {
  it('serves the whole image until a crop is set', async () => {
    const t = await thumb();
    expect(t.width).toBe(400);
    expect(t.height).toBe(300);
  });

  it('renders only the framed window, keeping the aspect ratio', async () => {
    const res = await putCrop({ x: 0.25, y: 0.5, zoom: 2 }); // left-half window: all red
    expect(res.status).toBe(200);
    const t = await thumb();
    expect([t.width, t.height]).toEqual([200, 150]);
    expect(t.rgb[0]).toBeGreaterThan(240);
    expect(t.rgb[2]).toBeLessThan(15);

    await putCrop({ x: 0.75, y: 0.5, zoom: 2 }); // right-half window: all blue
    const b = await thumb();
    expect(b.rgb[2]).toBeGreaterThan(240);
    expect(b.rgb[0]).toBeLessThan(15);
  });

  it('exposes the crop on GET gallery-image', async () => {
    expect((await putCrop({ x: 0.75, y: 0.5, zoom: 2 })).status).toBe(200);
    const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}/gallery-image`);
    const body = await res.json() as { data?: { galleryCrop?: unknown }; galleryCrop?: unknown };
    expect((body.data ?? body).galleryCrop).toEqual({ x: 0.75, y: 0.5, zoom: 2 });
  });

  it('clears the crop with null', async () => {
    expect((await putCrop(null)).status).toBe(200);
    expect((await thumb()).width).toBe(400);
  });

  it('drops the crop when a different image is chosen', async () => {
    await putCrop({ x: 0.25, y: 0.5, zoom: 2 });
    const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}/gallery-image`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePath: REL }),
    });
    expect(res.status).toBe(200);
    expect((await thumb()).width).toBe(400);
  });

  it('rejects a malformed crop and refuses one without a chosen image', async () => {
    expect((await putCrop({ x: 'a' })).status).toBe(400);
    db.prepare('UPDATE libraryObjects SET galleryImageUserSet = 0 WHERE objectId = ?').run(OBJECT_ID);
    expect((await putCrop({ x: 0.5, y: 0.5, zoom: 2 })).status).toBe(409);
  });
});
