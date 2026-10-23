import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// End to end: link a folder holding one object, then read the catalog board.
// An object in the same frame must be credited, with a pointer back to the host.

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-companionprogress-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { catalogsRouter } from '../../server/routes/catalogs';
import { settingsRouter } from '../../server/routes/settings';

const realFetch = globalThis.fetch;
let server: http.Server;
let baseUrl: string;
const roots: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test'; req.userId = 'u'; req.username = 'tester'; req.userRole = 'admin';
    next();
  });
  app.use('/library', libraryRouter);
  app.use('/catalogs', catalogsRouter);
  app.use('/settings', settingsRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

beforeEach(() => {
  // Every test starts from the shipped default (on); the toggle tests turn it off themselves.
  db.prepare('UPDATE appSettings SET groupCatalogCompanions = 1 WHERE id = 1').run();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
});

/** A SeeStar-style folder holding one stacked image of `folder`'s object. */
function linkable(folder: string, target: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-companion-source-'));
  roots.push(root);
  const dir = path.join(root, 'Seestar', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `Stacked_60_${target}_20.0s_IRCUT_20260524-231230.jpg`), 'x'.repeat(64));
  return root;
}

async function call(method: string, url: string, body?: unknown) {
  const res = await realFetch(`${baseUrl}${url}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: await res.json() as { data?: any } };
}

async function linkAndReadMessier(folder: string, target: string) {
  const link = await call('POST', '/library/sources', { rootPath: linkable(folder, target), label: 'x' });
  expect(link.status).toBe(200);
  const progress = await call('GET', '/catalogs/messier/progress');
  expect(progress.status).toBe(200);
  const byId = new Map<string, { isImaged: boolean; imagedVia: Array<{ objectId: string; name: string; sepDeg: number }> | null; libraryObjectId: string | null; sessionCount: number }>(
    progress.body.data.objects.map((o: { id: string }) => [o.id, o]),
  );
  return { data: progress.body.data, byId };
}

describe('catalog board credit for objects in the same frame', () => {
  it('credits M66 when M65 was imaged, and points back at M65', async () => {
    const { data, byId } = await linkAndReadMessier('M 65 - Leo Triplet', 'M 65');

    expect(byId.get('M65')).toMatchObject({ isImaged: true, imagedVia: null, sessionCount: 1 });
    const m66 = byId.get('M66')!;
    expect(m66.isImaged).toBe(true);
    expect(m66.imagedVia).toHaveLength(1);
    expect(m66.imagedVia![0]).toMatchObject({ objectId: 'M65', sepDeg: 0.34 });
    expect(m66.libraryObjectId).toBe('M65'); // "View observations" opens the host
    expect(m66.sessionCount).toBe(0);

    expect(data.imagedCount).toBe(2);
    expect(data.imagedInFrameCount).toBe(1);
  });

  it('does not credit objects that are only in frame on a wider telescope than the one on record', async () => {
    // No telescope is recorded for a linked folder, so the narrowest field applies:
    // M32 is 0.40 deg from M31, outside a 0.35 deg radius.
    const { data, byId } = await linkAndReadMessier('M 31 - Andromeda', 'M 31');
    expect(byId.get('M31')?.isImaged).toBe(true);
    expect(byId.get('M32')).toMatchObject({ isImaged: false, imagedVia: null });
    expect(byId.get('M110')).toMatchObject({ isImaged: false, imagedVia: null });
    expect(data.imagedInFrameCount).toBe(0);
  });

  it('credits nothing for an object with no companions', async () => {
    const { data, byId } = await linkAndReadMessier('M 45 - Pleiades', 'M 45');
    expect(byId.get('M45')?.isImaged).toBe(true);
    expect(data.imagedCount).toBe(1);
    expect(data.imagedInFrameCount).toBe(0);
  });

  it('drops the credit again once the folder is unlinked', async () => {
    const link = await call('POST', '/library/sources', { rootPath: linkable('M 65 - Leo Triplet', 'M 65'), label: 'x' });
    const id = link.body.data.sourceId as string;
    expect((await call('GET', '/catalogs/messier/progress')).body.data.imagedCount).toBe(2);
    await call('DELETE', `/library/sources/${id}`);
    expect((await call('GET', '/catalogs/messier/progress')).body.data.imagedCount).toBe(0);
  });

  describe('Settings → Library → "Credit objects in the same frame"', () => {
    it('is on by default', async () => {
      const settings = await call('GET', '/settings');
      expect(settings.status).toBe(200);
      expect(settings.body.data.groupCatalogCompanions).toBe(true);
    });

    it('turns the credit off and back on, without touching what was imaged directly', async () => {
      await call('POST', '/library/sources', { rootPath: linkable('M 65 - Leo Triplet', 'M 65'), label: 'x' });

      const off = await call('PUT', '/settings', { groupCatalogCompanions: false });
      expect(off.status).toBe(200);
      expect((await call('GET', '/settings')).body.data.groupCatalogCompanions).toBe(false);

      const offBoard = (await call('GET', '/catalogs/messier/progress')).body.data;
      const offById = new Map<string, { isImaged: boolean; imagedVia: unknown }>(offBoard.objects.map((o: { id: string }) => [o.id, o]));
      expect(offById.get('M65')?.isImaged).toBe(true); // the object you aimed at still counts
      expect(offById.get('M66')).toMatchObject({ isImaged: false, imagedVia: null });
      expect(offBoard.imagedCount).toBe(1);
      expect(offBoard.imagedInFrameCount).toBe(0);

      await call('PUT', '/settings', { groupCatalogCompanions: true });
      const onBoard = (await call('GET', '/catalogs/messier/progress')).body.data;
      expect(onBoard.imagedCount).toBe(2);
      expect(onBoard.imagedInFrameCount).toBe(1);
    });

    it('survives saving other settings (a partial save must not reset it)', async () => {
      await call('PUT', '/settings', { groupCatalogCompanions: false });
      await call('PUT', '/settings', { galleryProcessedOnlyDefault: true });
      expect((await call('GET', '/settings')).body.data.groupCatalogCompanions).toBe(false);
    });
  });
});
