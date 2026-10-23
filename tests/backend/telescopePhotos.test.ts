import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import sharp from 'sharp';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { telescopesRouter } from '../../server/routes/telescopes';
import { createProfile } from '../../server/lib/telescopes';
import {
  TELESCOPE_PHOTOS_DIR,
  TelescopePhotoError,
  deleteTelescopePhoto,
  getTelescopePhotoPath,
  setTelescopePhoto,
  telescopePhotoVersion,
} from '../../server/lib/telescopePhotos';

async function png(width = 2400, height = 1200, alpha = true): Promise<Buffer> {
  return sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 20, g: 80, b: 160, alpha: 0 } : '#335577' } }).png().toBuffer();
}

function tempFile(contents: Buffer | string): string {
  const p = path.join(os.tmpdir(), `scopephoto-test-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, contents);
  return p;
}

beforeEach(() => {
  fs.rmSync(TELESCOPE_PHOTOS_DIR, { recursive: true, force: true });
});

describe('telescope pictures', () => {
  it('stores a shrunk WebP and keeps transparency', async () => {
    const temp = tempFile(await png());
    const version = await setTelescopePhoto('scope-a', temp);
    expect(version).toBeGreaterThan(0);
    const file = getTelescopePhotoPath('scope-a')!;
    expect(path.dirname(file)).toBe(TELESCOPE_PHOTOS_DIR);
    const meta = await sharp(fs.readFileSync(file)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1200);
    expect(meta.hasAlpha).toBe(true);
    expect(telescopePhotoVersion('scope-a')).toBe(version);
    expect(fs.existsSync(temp)).toBe(false);
  });

  it('does not enlarge a small picture', async () => {
    await setTelescopePhoto('scope-a', tempFile(await png(300, 200)));
    expect((await sharp(fs.readFileSync(getTelescopePhotoPath('scope-a')!)).metadata()).width).toBe(300);
  });

  it('refuses something that is not a picture, and cleans up', async () => {
    const temp = tempFile('<?php echo 1;');
    await expect(setTelescopePhoto('scope-a', temp)).rejects.toBeInstanceOf(TelescopePhotoError);
    expect(fs.existsSync(temp)).toBe(false);
    expect(getTelescopePhotoPath('scope-a')).toBeNull();
  });

  it('refuses SVG, which can carry script', async () => {
    const temp = tempFile('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    await expect(setTelescopePhoto('scope-a', temp)).rejects.toBeInstanceOf(TelescopePhotoError);
    expect(getTelescopePhotoPath('scope-a')).toBeNull();
  });

  it('never lets an id pick a path', async () => {
    const temp = tempFile(await png(100, 100));
    await expect(setTelescopePhoto('../../evil', temp)).rejects.toBeInstanceOf(TelescopePhotoError);
    expect(getTelescopePhotoPath('../../evil')).toBeNull();
    expect(telescopePhotoVersion('a/b')).toBeNull();
    expect(fs.existsSync(temp)).toBe(false);
  });

  it('replaces and deletes', async () => {
    await setTelescopePhoto('scope-a', tempFile(await png(400, 400)));
    await setTelescopePhoto('scope-a', tempFile(await png(200, 100)));
    expect((await sharp(fs.readFileSync(getTelescopePhotoPath('scope-a')!)).metadata()).width).toBe(200);
    expect(deleteTelescopePhoto('scope-a')).toBe(true);
    expect(deleteTelescopePhoto('scope-a')).toBe(false);
    expect(telescopePhotoVersion('scope-a')).toBeNull();
    expect(fs.readdirSync(TELESCOPE_PHOTOS_DIR)).toEqual([]);
  });
});

describe('telescope pictures over HTTP', () => {
  let server: http.Server;
  let base: string;
  let id: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
    app.use('/api/v1/telescopes', telescopesRouter);
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  // The suite's setup clears the tables between tests, so each one makes its own telescope.
  beforeEach(() => { id = createProfile({ name: 'Photo scope', hostname: '10.9.9.9' }).id; });

  it('uploads, lists a version, serves and removes', async () => {
    expect((await fetch(`${base}/telescopes/${id}/photo`)).status).toBe(404);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await png(800, 600))], { type: 'image/png' }), 'my-scope.png');
    const put = await (await fetch(`${base}/telescopes/${id}/photo`, { method: 'PUT', body: form })).json();
    expect(put.ok).toBe(true);
    const version = put.data.photoVersion as number;

    const list = await (await fetch(`${base}/telescopes`)).json();
    expect(list.data.find((p: { id: string }) => p.id === id).photoVersion).toBe(version);

    const file = await fetch(`${base}/telescopes/${id}/photo`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/webp');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');

    const gone = await (await fetch(`${base}/telescopes/${id}/photo`, { method: 'DELETE' })).json();
    expect(gone.data.deleted).toBe(true);
    expect((await fetch(`${base}/telescopes/${id}/photo`)).status).toBe(404);
    const after = await (await fetch(`${base}/telescopes`)).json();
    expect(after.data.find((p: { id: string }) => p.id === id).photoVersion).toBeNull();
  });

  it('answers 422 for a file that is not a picture and 404 for an unknown telescope', async () => {
    const bad = new FormData();
    bad.append('file', new Blob(['not an image'], { type: 'image/png' }), 'x.png');
    const res = await fetch(`${base}/telescopes/${id}/photo`, { method: 'PUT', body: bad });
    expect(res.status).toBe(422);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await png(100, 100))], { type: 'image/png' }), 'x.png');
    expect((await fetch(`${base}/telescopes/nope/photo`, { method: 'PUT', body: form })).status).toBe(404);
    expect((await fetch(`${base}/telescopes/${id}/photo`, { method: 'PUT' })).status).toBe(400);
  });
});
