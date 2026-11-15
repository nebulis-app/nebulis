import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-fav-follow-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { getImageFavorites, setImageFavorite, moveImageFavorites } from '../../server/lib/library/favorites';
import { addProcessedImage, replaceProcessedImageFile, deleteProcessedImage } from '../../server/lib/library/processed';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { deleteLocalFilesByRelPath } from '../../server/lib/library/observations';

const OBJECT_ID = 'M31';
const DATE = '2026-05-25';
const USER = 'u1';
let server: http.Server;
let baseUrl: string;

function stage(name: string, content = 'pixels'): string {
  const p = path.join(LIBRARY_DIR, `.stage-${Math.random().toString(36).slice(2)}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}

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
});

describe('a favorite follows its picture', () => {
  it('moveImageFavorites moves every user, keeps an existing star on the target, and drops the old rows', () => {
    setImageFavorite('a.jpg', 'u1', true);
    setImageFavorite('a.jpg', 'u2', true);
    setImageFavorite('b.jpg', 'u2', true);
    moveImageFavorites('a.jpg', 'b.jpg');
    expect(getImageFavorites('u1')).toEqual(['b.jpg']);
    expect(getImageFavorites('u2')).toEqual(['b.jpg']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM imageFavorites WHERE imagePath = ?').get('a.jpg')).toEqual({ n: 0 });
  });

  it('survives marking a file as processed and sending it back to the night', async () => {
    const original = `${OBJECT_ID}/S/final.jpg`;
    fs.writeFileSync(path.join(LIBRARY_DIR, original), 'pixels');
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: OBJECT_ID, sessionFolder: 'S', fileName: 'final.jpg',
      sessionDateOverride: DATE, telescopeId: null, bytes: 6,
    });
    setImageFavorite(original, USER, true);

    const promoted = await post(`/objects/${OBJECT_ID}/sessions/${DATE}/processed-images/from-file`, { path: original });
    expect(promoted.status).toBe(200);
    const processedPath = `${OBJECT_ID}/processed/final.jpg`;
    expect(getImageFavorites(USER)).toEqual([processedPath]);

    const id = (db.prepare('SELECT id FROM sessionProcessedImages WHERE objectId = ?').get(OBJECT_ID) as { id: string }).id;
    const back = await post(`/objects/${OBJECT_ID}/sessions/${DATE}/processed-images/${id}/unmark`);
    expect(back.status).toBe(200);
    expect(getImageFavorites(USER)).toEqual([back.json.data!.path]);
  });

  it('survives saving over a processed image in the editor, and goes when the image is deleted', () => {
    const rec = addProcessedImage(OBJECT_ID, DATE, stage('one.png'), 'one.png', 'image/png', '', '', null);
    setImageFavorite(rec.path, USER, true);

    const saved = replaceProcessedImageFile(rec.id, stage('two.jpg'), 'two.jpg', 'image/jpeg');
    expect(saved!.path).not.toBe(rec.path);
    expect(getImageFavorites(USER)).toEqual([saved!.path]);

    deleteProcessedImage(rec.id);
    expect(getImageFavorites(USER)).toEqual([]);
  });

  it('is forgotten when the user deletes the file, so a later file at that path starts unstarred', () => {
    const rel = `${OBJECT_ID}/S/x.jpg`;
    fs.writeFileSync(path.join(LIBRARY_DIR, rel), 'pixels');
    setImageFavorite(rel, USER, true);
    expect(deleteLocalFilesByRelPath(OBJECT_ID, ['S/x.jpg']).deleted).toBe(1);
    expect(getImageFavorites(USER)).toEqual([]);
  });
});
