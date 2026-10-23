import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import sharp from 'sharp';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { sitesRouter } from '../../server/routes/sites';
import { createSite, deleteSite } from '../../server/lib/observingSites';
import {
  SITE_PHOTOS_DIR,
  SITE_PHOTO_LIMITS,
  SitePhotoError,
  addSitePhoto,
  deleteSitePhoto,
  getSitePhotoFile,
  getSitePhotoPreview,
  listSitePhotos,
  setSitePhotoCaption,
} from '../../server/lib/sitePhotos';

async function jpeg(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#335577' } }).jpeg().toBuffer();
}

function tempFile(contents: Buffer | string): string {
  const p = path.join(os.tmpdir(), `sitephoto-test-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, contents);
  return p;
}

async function upload(siteId: string, name = 'garden.jpg', caption?: string) {
  const buf = await jpeg();
  return addSitePhoto(siteId, { tempPath: tempFile(buf), fileName: name, mimeType: 'image/jpeg', size: buf.length, caption });
}

let siteId: string;

beforeEach(() => {
  db.prepare('DELETE FROM siteImages').run();
  fs.rmSync(SITE_PHOTOS_DIR, { recursive: true, force: true });
  siteId = createSite({ name: `Photo test ${Math.random().toString(36).slice(2)}` }).id;
});

describe('site pictures', () => {
  it('stores a picture under the site and lists it', async () => {
    const p = await upload(siteId, 'north skyline.jpg', 'Looking north');
    expect(p.caption).toBe('Looking north');
    expect(listSitePhotos(siteId).map((x) => x.id)).toEqual([p.id]);
    const found = getSitePhotoFile(p.id)!;
    expect(found.filePath.startsWith(path.join(SITE_PHOTOS_DIR, siteId))).toBe(true);
    expect(path.basename(found.filePath).startsWith(p.id)).toBe(true);
  });

  it('never trusts the uploaded name to pick a path', async () => {
    const p = await upload(siteId, '../../../etc/passwd.jpg');
    expect(p.fileName).toBe('passwd.jpg');
    expect(getSitePhotoFile(p.id)!.filePath.startsWith(SITE_PHOTOS_DIR)).toBe(true);
  });

  it('refuses something that is not a picture and leaves no temp file', async () => {
    const temp = tempFile('<html><script>alert(1)</script></html>');
    expect(() => addSitePhoto(siteId, { tempPath: temp, fileName: 'x.jpg', mimeType: 'image/jpeg', size: 10 })).toThrow(SitePhotoError);
    expect(fs.existsSync(temp)).toBe(false);
    expect(listSitePhotos(siteId)).toEqual([]);
  });

  it('refuses a site that does not exist', async () => {
    await expect(upload('nope')).rejects.toBeInstanceOf(SitePhotoError);
  });

  it('caps the pictures per site', async () => {
    const buf = await jpeg(8, 8);
    for (let i = 0; i < SITE_PHOTO_LIMITS.photos; i++) {
      addSitePhoto(siteId, { tempPath: tempFile(buf), fileName: `p${i}.jpg`, mimeType: 'image/jpeg', size: buf.length });
    }
    expect(() => addSitePhoto(siteId, { tempPath: tempFile(buf), fileName: 'x.jpg', mimeType: 'image/jpeg', size: buf.length })).toThrow(/at most/);
  });

  it('changes a caption and removes a picture with its file and previews', async () => {
    const p = await upload(siteId);
    expect(setSitePhotoCaption(p.id, 'South fence').caption).toBe('South fence');
    const preview = await getSitePhotoPreview(p.id, 200);
    expect(preview && fs.existsSync(preview.filePath)).toBe(true);
    const original = getSitePhotoFile(p.id)!.filePath;
    expect(deleteSitePhoto(p.id)).toBe(true);
    expect(fs.existsSync(original)).toBe(false);
    expect(preview && fs.existsSync(preview.filePath)).toBe(false);
    expect(deleteSitePhoto(p.id)).toBe(false);
  });

  it('makes a preview no wider than asked, and never enlarges', async () => {
    const p = await upload(siteId);
    const small = await getSitePhotoPreview(p.id, 200);
    expect((await sharp(small!.filePath).metadata()).width).toBe(200);
    const big = await getSitePhotoPreview(p.id, 2000);
    expect((await sharp(big!.filePath).metadata()).width).toBe(640);
  });

  it('removes the pictures when the site is deleted', async () => {
    const other = createSite({ name: 'Keeper' });
    const p = await upload(siteId);
    const dir = path.join(SITE_PHOTOS_DIR, siteId);
    expect(fs.existsSync(dir)).toBe(true);
    expect(deleteSite(siteId).deleted).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(getSitePhotoFile(p.id)).toBeNull();
    deleteSite(other.id);
  });
});

describe('site pictures over HTTP', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
    app.use('/api/v1/sites', sitesRouter);
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('uploads, lists, serves and deletes', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await jpeg())], { type: 'image/jpeg' }), 'back-garden.jpg');
    form.append('caption', 'Back garden');
    const created = await (await fetch(`${base}/sites/${siteId}/photos`, { method: 'POST', body: form })).json();
    expect(created.ok).toBe(true);
    const id = created.data.id as string;

    const list = await (await fetch(`${base}/sites/${siteId}/photos`)).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].caption).toBe('Back garden');

    const file = await fetch(`${base}/sites/photos/${id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');

    const thumb = await fetch(`${base}/sites/photos/${id}?w=100`);
    expect(thumb.status).toBe(200);
    expect((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width).toBe(100);

    const renamed = await (await fetch(`${base}/sites/photos/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caption: 'Patio' }),
    })).json();
    expect(renamed.data.caption).toBe('Patio');

    const gone = await (await fetch(`${base}/sites/photos/${id}`, { method: 'DELETE' })).json();
    expect(gone.data.deleted).toBe(true);
    expect((await fetch(`${base}/sites/photos/${id}`)).status).toBe(404);
  });

  it('rejects a non-picture upload with a 422', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not a picture'], { type: 'image/jpeg' }), 'x.jpg');
    const res = await fetch(`${base}/sites/${siteId}/photos`, { method: 'POST', body: form });
    expect(res.status).toBe(422);
  });

  it('404s for the photos of an unknown site', async () => {
    expect((await fetch(`${base}/sites/nope/photos`)).status).toBe(404);
  });
});
