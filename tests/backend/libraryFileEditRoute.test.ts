import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import sharp from '../../server/lib/sharp-optional';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getById } from '../../server/lib/dsoCatalog';
import { getAnnotations } from '../../server/lib/annotate/annotateService';
import { approximateWcs } from '../../server/lib/annotate/wcs';

const DIR = 'M31/edit-route-test';
const REL = `${DIR}/Stacked_60_M 31_10.0s_IRCUT_20260530-211100.jpg`;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

async function postSave(editField: string | undefined, width: number, height: number): Promise<Response> {
  const jpeg = await sharp({ create: { width, height, channels: 3, background: '#222' } }).jpeg().toBuffer();
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'edit.jpg');
  form.append('overwritePath', REL);
  if (editField !== undefined) form.append('edit', editField);
  return fetch(`${baseUrl}/objects/M31/sessions/2026-05-30/library-files`, { method: 'POST', body: form });
}

describe('POST library-files overwrite carries the plate solution', () => {
  let abs: string;
  const m31 = getById('M31')!;
  const solution = approximateWcs({ raDeg: m31.ra * 15, decDeg: m31.dec, width: 1200, height: 800, longSideDeg: 3 });

  beforeEach(async () => {
    abs = path.join(getLibraryDir(), REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#000' } }).jpeg().toFile(abs);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, 'stacked', ?)`,
    ).run('M31', REL, path.basename(REL), path.basename(REL), '2026-10-01T00:00:00Z');
    db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, 'astap', ?, 'x')`)
      .run(REL, fs.statSync(abs).mtimeMs, JSON.stringify(solution));
  });

  afterEach(() => {
    for (const table of ['libraryFiles', 'fileWcs', 'fileGeometryEdits']) {
      db.prepare(`DELETE FROM ${table} WHERE relPath = ?`).run(REL);
    }
    fs.rmSync(path.join(getLibraryDir(), DIR), { recursive: true, force: true });
  });

  it('keeps the solution when the save says it rotated the frame', async () => {
    const res = await postSave(JSON.stringify({ rotation: 90 }), 800, 1200);
    expect(res.status).toBe(200);
    const result = await getAnnotations(REL);
    expect(result.quality).toBe('solved');
    expect(result.imageWidth).toBe(800);
  });

  it('still marks the frame edited and drops the solution when no edit is described', async () => {
    const res = await postSave(undefined, 800, 1200);
    expect(res.status).toBe(200);
    expect((await getAnnotations(REL)).quality).not.toBe('solved');
  });

  it.each([
    ['not JSON', 'rotation=90'],
    ['an impossible rotation', JSON.stringify({ rotation: 45 })],
  ])('refuses %s with 400 and leaves the picture alone', async (_name, field) => {
    const before = fs.statSync(abs).mtimeMs;
    const res = await postSave(field, 800, 1200);
    expect(res.status).toBe(400);
    expect(fs.statSync(abs).mtimeMs).toBe(before);
  });
});

describe('POST /image-edit and its preview', () => {
  const REL2 = 'M31/image-edit-route-test/Stacked_60_M 31_10.0s_IRCUT_20260530-211100.jpg';
  let abs2: string;

  beforeEach(async () => {
    abs2 = path.join(getLibraryDir(), REL2);
    fs.mkdirSync(path.dirname(abs2), { recursive: true });
    await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#234' } }).jpeg().toFile(abs2);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, 'stacked', ?)`,
    ).run('M31', REL2, path.basename(REL2), path.basename(REL2), '2026-10-01T00:00:00Z');
  });
  afterEach(() => {
    db.prepare('DELETE FROM libraryFiles WHERE relPath = ?').run(REL2);
    fs.rmSync(path.dirname(abs2), { recursive: true, force: true });
  });

  const post = (request: unknown, overlay?: Buffer) => {
    const form = new FormData();
    form.append('request', typeof request === 'string' ? request : JSON.stringify(request));
    if (overlay) form.append('overlay', new Blob([new Uint8Array(overlay)], { type: 'image/png' }), 'overlay.png');
    return fetch(`${baseUrl}/image-edit`, { method: 'POST', body: form });
  };

  it('edits the picture on disk from parameters alone', async () => {
    const res = await post({ source: { kind: 'telescope', path: REL2 }, edit: { rotation: 90 }, save: { mode: 'overwrite' } });
    expect(res.status).toBe(200);
    const meta = await sharp(abs2).metadata();
    expect([meta.width, meta.height]).toEqual([2000, 3000]);
  });

  it('accepts a text overlay', async () => {
    const overlay = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
    const res = await post({ source: { kind: 'telescope', path: REL2 }, save: { mode: 'overwrite' } }, overlay);
    expect(res.status).toBe(200);
    expect((await sharp(abs2).raw().toBuffer())[0]).toBeGreaterThan(240);
  });

  it.each([
    ['text that is not JSON', 'nope', 400],
    ['a request that fails validation', { source: { kind: 'telescope', path: REL2 }, save: { mode: 'sideways' } }, 400],
    ['a picture that is not there', { source: { kind: 'telescope', path: 'M31/missing/x.jpg' }, save: { mode: 'overwrite' } }, 404],
  ])('answers %s with %i', async (_name, body, status) => {
    expect((await post(body)).status).toBe(status);
  });

  it('serves a screen-sized preview, never the full file', async () => {
    const res = await fetch(`${baseUrl}/image-edit/preview?kind=telescope&key=${encodeURIComponent(REL2)}`);
    expect(res.status).toBe(200);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([2048, 1365]);
  });

  it('refuses a preview request without a kind and key', async () => {
    expect((await fetch(`${baseUrl}/image-edit/preview?kind=url&key=x`)).status).toBe(400);
  });
});
