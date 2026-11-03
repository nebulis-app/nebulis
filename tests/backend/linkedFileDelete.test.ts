import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkeddelete-test-'));
  _process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import db from '../../server/lib/db';
import { stmts } from '../../server/lib/library/objects';
import { getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { deleteLinkedFilesFromDisk, getLinkedFileRows, summarizeLinkedFiles } from '../../server/lib/library/librarySources';

/**
 * Deleting from a linked folder is real: the user's own original goes, because
 * there is no Nebulis copy. These tests pin the guardrails around that. The route
 * refuses without an explicit confirm, a source that cannot be reached is never
 * mistaken for "the files are gone", and an object or night only takes its
 * originals with it when asked.
 */

let server: http.Server;
let baseUrl: string;
const objectId = 'LinkedDeleteObj';
let sourceRoot: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = 'admin';
    next();
  });
  app.use('/library', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function link(name: string, captureDate: string, sourceId = 'src_del'): string {
  const relPath = `@src/${sourceId}/${name}`;
  fs.writeFileSync(path.join(sourceRoot, name), 'original');
  db.prepare(
    `INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`,
  ).run(sourceId, 'Seestar library', sourceRoot, new Date().toISOString());
  db.prepare(
    `INSERT OR REPLACE INTO libraryFiles
       (objectId, relPath, fileName, originalName, role, bytes, captureDate, sourceId, sourcePath, importedAt)
     VALUES (?, ?, ?, ?, 'stacked', 8, ?, ?, ?, ?)`,
  ).run(objectId, relPath, name, name, captureDate, sourceId, name, new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO librarySessions (objectId, date) VALUES (?, ?)').run(objectId, captureDate);
  return relPath;
}

beforeEach(() => {
  sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkeddelete-source-'));
  for (const table of ['libraryFiles', 'librarySessions']) db.prepare(`DELETE FROM ${table} WHERE objectId = ?`).run(objectId);
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  stmts.upsertObject.run(objectId, objectId, 0, new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null);
});

const del = (url: string) => fetch(`${baseUrl}${url}`, { method: 'DELETE' }).then(async r => ({ status: r.status, body: await r.json() as { error?: { code: string } } }));

describe('DELETE /library/file on a linked file', () => {
  it('refuses without an explicit confirm and leaves the file and row alone', async () => {
    const rel = link('a.jpg', '2026-09-10');
    const res = await del(`/library/file?path=${encodeURIComponent(rel)}`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('LINKED_DELETE_UNCONFIRMED');
    expect(fs.existsSync(path.join(sourceRoot, 'a.jpg'))).toBe(true);
    expect(getLibraryFilesForObject(objectId)).toHaveLength(1);
  });

  it('deletes the original from disk, drops the row, and retires the emptied night and object', async () => {
    const rel = link('a.jpg', '2026-09-10');
    const res = await del(`/library/file?path=${encodeURIComponent(rel)}&deleteLinked=1`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot, 'a.jpg'))).toBe(false);
    expect(getLibraryFilesForObject(objectId)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM librarySessions WHERE objectId = ?').get(objectId)).toEqual({ n: 0 });
    expect(db.prepare<[string], { deleted: number }>('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(objectId)?.deleted).toBe(1);
  });

  it('keeps the object and the other nights when only one file goes', async () => {
    const one = link('a.jpg', '2026-09-10');
    link('b.jpg', '2026-09-11');
    expect((await del(`/library/file?path=${encodeURIComponent(one)}&deleteLinked=1`)).status).toBe(200);
    expect(getLibraryFilesForObject(objectId)).toHaveLength(1);
    expect(fs.existsSync(path.join(sourceRoot, 'b.jpg'))).toBe(true);
    expect(db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM librarySessions WHERE objectId = ?').get(objectId)?.n).toBe(1);
    expect(db.prepare<[string], { deleted: number }>('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(objectId)?.deleted).toBe(0);
  });

  it('refuses when the linked folder cannot be reached, instead of dropping rows for files that are still there', async () => {
    const rel = link('a.jpg', '2026-09-10');
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    const res = await del(`/library/file?path=${encodeURIComponent(rel)}&deleteLinked=1`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('LINKED_SOURCE_UNAVAILABLE');
    expect(getLibraryFilesForObject(objectId)).toHaveLength(1);
  });

  it('treats a file that is already gone as deleted', async () => {
    const rel = link('a.jpg', '2026-09-10');
    fs.unlinkSync(path.join(sourceRoot, 'a.jpg'));
    expect((await del(`/library/file?path=${encodeURIComponent(rel)}&deleteLinked=1`)).status).toBe(200);
    expect(getLibraryFilesForObject(objectId)).toHaveLength(0);
  });
});

describe('deleting linked originals: guardrails for the wrong disk and for links that leave the folder', () => {
  const setFingerprint = (value: string | null) =>
    db.prepare('UPDATE librarySources SET fingerprint = ? WHERE id = ?').run(value, 'src_del');

  it('refuses when the path exists but holds a different disk than the one linked (empty mount point)', async () => {
    const rel = link('a.jpg', '2026-09-10');
    setFingerprint(JSON.stringify(['a.jpg', 'b.jpg']));
    // The share unmounts and the mount point is left behind, empty: unlinking would say ENOENT for every file.
    fs.unlinkSync(path.join(sourceRoot, 'a.jpg'));
    const res = await del(`/library/file?path=${encodeURIComponent(rel)}&deleteLinked=1`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('LINKED_SOURCE_UNAVAILABLE');
    expect(getLibraryFilesForObject(objectId)).toHaveLength(1);
  });

  it('still deletes normally when the fingerprint matches the folder', async () => {
    const rel = link('a.jpg', '2026-09-10');
    setFingerprint(JSON.stringify(['a.jpg']));
    expect((await del(`/library/file?path=${encodeURIComponent(rel)}&deleteLinked=1`)).status).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot, 'a.jpg'))).toBe(false);
    expect(getLibraryFilesForObject(objectId)).toHaveLength(0);
  });

  it('does not delete a file that is reached through a symlinked folder pointing outside the linked folder', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkeddelete-outside-'));
    fs.writeFileSync(path.join(outside, 'precious.jpg'), 'keep me');
    fs.symlinkSync(outside, path.join(sourceRoot, 'elsewhere'));
    const relPath = `@src/src_del/elsewhere/precious.jpg`;
    db.prepare(`INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`)
      .run('src_del', 'Seestar library', sourceRoot, new Date().toISOString());
    db.prepare(
      `INSERT OR REPLACE INTO libraryFiles
         (objectId, relPath, fileName, originalName, role, bytes, captureDate, sourceId, sourcePath, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', 8, ?, ?, ?, ?)`,
    ).run(objectId, relPath, 'precious.jpg', 'precious.jpg', '2026-09-10', 'src_del', 'elsewhere/precious.jpg', new Date().toISOString());

    expect(() => deleteLinkedFilesFromDisk(getLibraryFilesForObject(objectId))).toThrow(/outside|leaves/);
    expect(fs.readFileSync(path.join(outside, 'precious.jpg'), 'utf8')).toBe('keep me');
    expect(getLibraryFilesForObject(objectId)).toHaveLength(1);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('deletes a file under a symlinked folder that stays inside the linked folder', () => {
    fs.mkdirSync(path.join(sourceRoot, 'real'));
    fs.writeFileSync(path.join(sourceRoot, 'real', 'x.jpg'), 'x');
    fs.symlinkSync(path.join(sourceRoot, 'real'), path.join(sourceRoot, 'alias'));
    db.prepare(`INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`)
      .run('src_del', 'Seestar library', sourceRoot, new Date().toISOString());
    db.prepare(
      `INSERT OR REPLACE INTO libraryFiles
         (objectId, relPath, fileName, originalName, role, bytes, captureDate, sourceId, sourcePath, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', 1, ?, ?, ?, ?)`,
    ).run(objectId, '@src/src_del/alias/x.jpg', 'x.jpg', 'x.jpg', '2026-09-10', 'src_del', 'alias/x.jpg', new Date().toISOString());
    expect(deleteLinkedFilesFromDisk(getLibraryFilesForObject(objectId))).toEqual({ deleted: 1 });
    expect(fs.existsSync(path.join(sourceRoot, 'real', 'x.jpg'))).toBe(false);
  });

  it('a symlinked file is unlinked as a link: the file it points at survives', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkeddelete-outside-'));
    fs.writeFileSync(path.join(outside, 'target.jpg'), 'keep me');
    fs.symlinkSync(path.join(outside, 'target.jpg'), path.join(sourceRoot, 'pointer.jpg'));
    db.prepare(`INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`)
      .run('src_del', 'Seestar library', sourceRoot, new Date().toISOString());
    db.prepare(
      `INSERT OR REPLACE INTO libraryFiles
         (objectId, relPath, fileName, originalName, role, bytes, captureDate, sourceId, sourcePath, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', 1, ?, ?, ?, ?)`,
    ).run(objectId, '@src/src_del/pointer.jpg', 'pointer.jpg', 'pointer.jpg', '2026-09-10', 'src_del', 'pointer.jpg', new Date().toISOString());
    expect(deleteLinkedFilesFromDisk(getLibraryFilesForObject(objectId))).toEqual({ deleted: 1 });
    expect(fs.readFileSync(path.join(outside, 'target.jpg'), 'utf8')).toBe('keep me');
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('deleting an object or a night that has linked files', () => {
  it('drops the object from Nebulis but leaves the originals by default', async () => {
    link('a.jpg', '2026-09-10');
    expect((await del(`/library/objects/${objectId}`)).status).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot, 'a.jpg'))).toBe(true);
  });

  it('also deletes the originals when asked', async () => {
    link('a.jpg', '2026-09-10');
    link('b.jpg', '2026-09-11');
    expect((await del(`/library/objects/${objectId}?deleteLinkedFiles=1`)).status).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot, 'a.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, 'b.jpg'))).toBe(false);
    expect(db.prepare<[string], { deleted: number }>('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(objectId)?.deleted).toBe(1);
  });

  it('only takes the originals of the night being deleted', async () => {
    link('a.jpg', '2026-09-10');
    link('b.jpg', '2026-09-11');
    expect((await del(`/library/objects/${objectId}/sessions/2026-09-10?deleteLinkedFiles=1`)).status).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot, 'a.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, 'b.jpg'))).toBe(true);
  });

  it('does not tombstone the object when the originals could not be deleted', async () => {
    link('a.jpg', '2026-09-10');
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    const res = await del(`/library/objects/${objectId}?deleteLinkedFiles=1`);
    expect(res.status).toBe(409);
    expect(db.prepare<[string], { deleted: number }>('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(objectId)?.deleted).toBe(0);
  });
});

describe('linked file helpers', () => {
  it('summarises what a delete would take, per object and per night', () => {
    link('a.jpg', '2026-09-10');
    link('b.jpg', '2026-09-11');
    expect(summarizeLinkedFiles(objectId)).toEqual({ files: 2, bytes: 16, folders: ['Seestar library'] });
    expect(summarizeLinkedFiles(objectId, '2026-09-10').files).toBe(1);
    expect(getLinkedFileRows(objectId, '2026-09-12')).toEqual([]);
  });

  it('skips a managed row handed to it, and leaves that file on disk', () => {
    const managedFile = path.join(sourceRoot, 'managed.jpg');
    fs.writeFileSync(managedFile, 'x');
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', 1, ?)`,
    ).run(objectId, `${objectId}/managed.jpg`, 'managed.jpg', 'managed.jpg', new Date().toISOString());
    const rows = getLibraryFilesForObject(objectId);
    expect(deleteLinkedFilesFromDisk(rows)).toEqual({ deleted: 0 });
    expect(fs.existsSync(managedFile)).toBe(true);
    expect(getLibraryFilesForObject(objectId)).toHaveLength(1);
  });
});
