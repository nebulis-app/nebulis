import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors deleteLocalObjectTransaction.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedsessions-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { stmts } from '../../server/lib/library/objects';
import { getLocalSessions, getLocalFiles } from '../../server/lib/library/observations';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function upsertBareObject(objectId: string, folderName = objectId): void {
  stmts.upsertObject.run(
    objectId, folderName, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
}

function linkFile(opts: {
  objectId: string; sourceId: string; rootPath: string;
  relPath: string; sourcePath: string; fileName: string;
  role: string; captureDate: string; captureTime: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`,
  ).run(opts.sourceId, opts.sourceId, opts.rootPath, new Date().toISOString());
  db.prepare(
    `INSERT INTO libraryFiles
       (objectId, relPath, fileName, originalName, role, captureDate, captureTime, bytes, sourceId, sourcePath, importedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?)`,
  ).run(opts.objectId, opts.relPath, opts.fileName, opts.fileName, opts.role,
    opts.captureDate, opts.captureTime, opts.sourceId, opts.sourcePath, new Date().toISOString());
}

describe('a linked-only object shows real sessions and files (no managed folder exists at all)', () => {
  const objectId = 'LinkedOnlyObj';
  let sourceRoot: string;

  beforeEach(() => {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM librarySources').run();
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkedsessions-source-'));
    upsertBareObject(objectId);
  });

  it('getLocalSessions reports two real sessions with correct file counts, not "fileCount: 0"', () => {
    fs.writeFileSync(path.join(sourceRoot, 'Stacked_1.jpg'), 'x'.repeat(50));
    fs.writeFileSync(path.join(sourceRoot, 'Stacked_2.jpg'), 'x'.repeat(50));
    linkFile({
      objectId, sourceId: 'src_a', rootPath: sourceRoot,
      relPath: '@src/src_a/Stacked_1.jpg', sourcePath: 'Stacked_1.jpg', fileName: 'Stacked_1.jpg',
      role: 'stacked', captureDate: '2026-05-24', captureTime: '231230',
    });
    linkFile({
      objectId, sourceId: 'src_a', rootPath: sourceRoot,
      relPath: '@src/src_a/Stacked_2.jpg', sourcePath: 'Stacked_2.jpg', fileName: 'Stacked_2.jpg',
      role: 'stacked', captureDate: '2026-06-01', captureTime: '220000',
    });

    const sessions = getLocalSessions(objectId);
    expect(sessions).toHaveLength(2);
    const dates = sessions.map(s => s.date).sort();
    expect(dates).toEqual(['2026-05-24', '2026-06-01']);
    for (const s of sessions) {
      expect(s.fileCount).toBe(1);
      expect(s.stackedCount).toBe(1);
      // The bug this fixes: before the merge, a linked-only object's sessions
      // always reported fileCount 0 and a generic object-level thumbnail.
      expect(s.thumbnailUrl).toContain('%40src%2Fsrc_a%2F'); // encodeURIComponent('@src/src_a/')
    }
  });

  it('getLocalFiles returns the linked files with their real @src/ path, not prefixed with a folder name', () => {
    linkFile({
      objectId, sourceId: 'src_b', rootPath: sourceRoot,
      relPath: '@src/src_b/M 42/Light_1.fit', sourcePath: 'M 42/Light_1.fit', fileName: 'Light_1.fit',
      role: 'sub', captureDate: '2026-07-01', captureTime: '210000',
    });
    fs.mkdirSync(path.join(sourceRoot, 'M 42'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'M 42', 'Light_1.fit'), 'x'.repeat(30));

    const files = getLocalFiles(objectId);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('@src/src_b/M 42/Light_1.fit');
    expect(files[0]!.size).toBe(30);
    expect(files[0]!.downloadUrl).toContain(encodeURIComponent('@src/src_b/M 42/Light_1.fit'));
  });

  it('getLocalFiles silently drops a linked row whose file has gone missing rather than crashing', () => {
    linkFile({
      objectId, sourceId: 'src_c', rootPath: sourceRoot,
      relPath: '@src/src_c/gone.jpg', sourcePath: 'gone.jpg', fileName: 'gone.jpg',
      role: 'stacked', captureDate: '2026-01-01', captureTime: '000000',
    });
    // Never actually created on disk.
    expect(() => getLocalFiles(objectId)).not.toThrow();
    expect(getLocalFiles(objectId)).toHaveLength(0);
  });
});

describe('an object with both managed and linked files merges both into one session/file list', () => {
  const objectId = 'MixedObj';
  let sourceRoot: string;

  beforeEach(() => {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM librarySources').run();
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-mixed-source-'));
    upsertBareObject(objectId);

    const managedDir = path.join(getLibraryDir(), objectId);
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, 'Stacked_managed.jpg'), 'x'.repeat(20));
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, captureTime, bytes, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', '2026-08-01', '200000', 20, ?)`,
    ).run(objectId, `${objectId}/Stacked_managed.jpg`, 'Stacked_managed.jpg', 'Stacked_managed.jpg', new Date().toISOString());

    linkFile({
      objectId, sourceId: 'src_mix', rootPath: sourceRoot,
      relPath: '@src/src_mix/Stacked_linked.jpg', sourcePath: 'Stacked_linked.jpg', fileName: 'Stacked_linked.jpg',
      role: 'stacked', captureDate: '2026-08-15', captureTime: '210000',
    });
    fs.writeFileSync(path.join(sourceRoot, 'Stacked_linked.jpg'), 'x'.repeat(40));
  });

  it('getLocalSessions reports both nights', () => {
    const sessions = getLocalSessions(objectId);
    const dates = sessions.map(s => s.date).sort();
    expect(dates).toEqual(['2026-08-01', '2026-08-15']);
  });

  it('getLocalFiles returns both files, each with the right kind of path', () => {
    const files = getLocalFiles(objectId).sort((a, b) => a.name.localeCompare(b.name));
    expect(files.map(f => f.name)).toEqual(['Stacked_linked.jpg', 'Stacked_managed.jpg']);
    expect(files.find(f => f.name === 'Stacked_managed.jpg')!.path).toBe(`${objectId}/Stacked_managed.jpg`);
    expect(files.find(f => f.name === 'Stacked_linked.jpg')!.path).toBe('@src/src_mix/Stacked_linked.jpg');
  });

  /**
   * The editor's "Save" overwrites the picture in place, so its path never
   * changes. The browser caches the thumbnail and preview tiers for a day, and
   * before this stamp the object page kept showing the un-edited picture even
   * after a reload while the editor (which loads the raw file) showed the
   * watermark. The stamp is the source mtime, the same one the route keys its
   * on-disk cache by.
   */
  it('getLocalFiles stamps thumbnail and preview URLs with the file mtime, so an in-place edit is fetched fresh', () => {
    const managedAbs = path.join(getLibraryDir(), objectId, 'Stacked_managed.jpg');
    const linkedAbs = path.join(sourceRoot, 'Stacked_linked.jpg');
    const older = new Date('2026-08-01T12:00:00Z');
    fs.utimesSync(managedAbs, older, older);
    fs.utimesSync(linkedAbs, older, older);
    const stamp = (abs: string) => `&v=${Math.round(fs.statSync(abs).mtimeMs)}`;

    const before = getLocalFiles(objectId);
    const managedBefore = before.find(f => f.name === 'Stacked_managed.jpg')!;
    const linkedBefore = before.find(f => f.name === 'Stacked_linked.jpg')!;
    for (const [file, abs] of [[managedBefore, managedAbs], [linkedBefore, linkedAbs]] as const) {
      expect(file.thumbUrl).toContain(stamp(abs));
      expect(file.previewUrl).toContain(stamp(abs));
    }

    const newer = new Date('2026-08-02T12:00:00Z');
    fs.writeFileSync(managedAbs, 'y'.repeat(30));
    fs.utimesSync(managedAbs, newer, newer);
    fs.writeFileSync(linkedAbs, 'y'.repeat(50));
    fs.utimesSync(linkedAbs, newer, newer);

    const after = getLocalFiles(objectId);
    const managedAfter = after.find(f => f.name === 'Stacked_managed.jpg')!;
    const linkedAfter = after.find(f => f.name === 'Stacked_linked.jpg')!;
    for (const [file, abs] of [[managedAfter, managedAbs], [linkedAfter, linkedAbs]] as const) {
      expect(file.thumbUrl).toContain(stamp(abs));
      expect(file.previewUrl).toContain(stamp(abs));
    }
    expect(managedAfter.thumbUrl).not.toBe(managedBefore.thumbUrl);
    expect(managedAfter.previewUrl).not.toBe(managedBefore.previewUrl);
    expect(linkedAfter.thumbUrl).not.toBe(linkedBefore.thumbUrl);
    expect(linkedAfter.previewUrl).not.toBe(linkedBefore.previewUrl);
  });
});
