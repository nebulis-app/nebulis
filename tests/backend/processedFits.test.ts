import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-processed-fits-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { getImageFavorites, setImageFavorite } from '../../server/lib/library/favorites';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { getAllLibraryImages, invalidateAllImagesCache } from '../../server/lib/library/gallery';

const OBJECT_ID = 'M31';
const DATE = '2026-05-25';
const USER = 'u1';
let server: http.Server;
let baseUrl: string;

async function post(url: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() as { data?: { path?: string } } };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 't'; req.userId = USER; req.userRole = 'admin'; next(); });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of ['libraryObjects', 'sessionProcessedImages', 'libraryFiles', 'imageFavorites']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(LIBRARY_DIR, OBJECT_ID, 'S'), { recursive: true });
  db.prepare('INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 0, ?)')
    .run(OBJECT_ID, OBJECT_ID, new Date().toISOString());
  invalidateAllImagesCache();
});

describe('a stacked FITS marked as processed', () => {
  const original = `${OBJECT_ID}/S/Stacked_300s_M31.fit`;

  async function promote(): Promise<string> {
    fs.writeFileSync(path.join(LIBRARY_DIR, original), 'SIMPLE');
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: OBJECT_ID, sessionFolder: 'S', fileName: 'Stacked_300s_M31.fit',
      sessionDateOverride: DATE, telescopeId: null, bytes: 6,
    });
    const res = await post(`/objects/${OBJECT_ID}/sessions/${DATE}/processed-images/from-file`, { path: original });
    expect(res.status).toBe(200);
    return `${OBJECT_ID}/processed/Stacked_300s_M31.fit`;
  }

  it('is accepted and keeps its favorite, and the Gallery still lists pictures only', async () => {
    setImageFavorite(original, USER, true);
    const processedPath = await promote();
    expect(getImageFavorites(USER)).toEqual([processedPath]);
    expect(getAllLibraryImages(USER).items.map(i => i.path)).not.toContain(processedPath);
  });

  it('can be sent back to the night it came from, favorite included', async () => {
    const processedPath = await promote();
    setImageFavorite(processedPath, USER, true);
    const id = (db.prepare('SELECT id FROM sessionProcessedImages WHERE objectId = ?').get(OBJECT_ID) as { id: string }).id;

    const back = await post(`/objects/${OBJECT_ID}/sessions/${DATE}/processed-images/${id}/unmark`);
    expect(back.status).toBe(200);
    expect(fs.existsSync(path.join(LIBRARY_DIR, back.json.data!.path!))).toBe(true);
    expect(getImageFavorites(USER)).toEqual([back.json.data!.path]);
  });

  it('still refuses an XISF going back, which the Images grid cannot show', async () => {
    db.prepare(`INSERT INTO sessionProcessedImages (id, objectId, date, filename, originalName, title, notes, size, mimeType, uploadedAt, source)
                VALUES ('x1', ?, ?, 'a.xisf', 'a.xisf', '', '', 1, 'application/x-xisf', ?, 'user')`)
      .run(OBJECT_ID, DATE, new Date().toISOString());
    const res = await post(`/objects/${OBJECT_ID}/sessions/${DATE}/processed-images/x1/unmark`);
    expect(res.status).toBe(422);
  });
});
