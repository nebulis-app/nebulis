import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-renest-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  renestObject,
  renestLibrary,
  countFlatObjects,
  UNSORTED_DIR,
} from '../../server/lib/library/libraryRenest';
import {
  recordLibraryFile,
  getLibraryFileRow,
  getLibraryFilesForObject,
} from '../../server/lib/library/libraryFiles';
import { getObjectLayout, setObjectLayout, listObjectFiles } from '../../server/lib/library/libraryLayout';
import { getLocalSessions, getLocalFiles } from '../../server/lib/library/observations';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { updateSettingsData } from '../../server/lib/telescopes';
import { claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import db from '../../server/lib/db';

const OBJECT_ID = 'M31';
const FOLDER = 'M31';

function objDir(folder = FOLDER): string {
  return path.join(LIBRARY_DIR, folder);
}

function seedObject(objectId = OBJECT_ID, folderName = FOLDER): void {
  stmts.upsertObject.run(
    objectId, folderName, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  setObjectLayout(objectId, 'flat');
}

/** Write a flat file and record it, the way a pre-nesting import would have. */
function seedFlatFile(fileName: string, captureDate: string | null, captureTime: string | null, bytes = 'x'): void {
  fs.mkdirSync(objDir(), { recursive: true });
  fs.writeFileSync(path.join(objDir(), fileName), bytes);
  recordLibraryFile({
    objectId: OBJECT_ID,
    folderName: FOLDER,
    fileName,
    originalName: fileName,
    captureDate,
    captureTime,
    bytes: bytes.length,
  });
}

beforeEach(() => {
  releaseImportLock();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySessions').run();
  db.prepare('DELETE FROM imageFavorites').run();
  db.prepare('DELETE FROM libraryObjects').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true });
});

describe('renestObject', () => {
  it('groups a flat object into one directory per observing night', () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    seedFlatFile('b_20260705-230000.jpg', '2026-07-05', '230000');
    seedFlatFile('c_20260708-220000.jpg', '2026-07-08', '220000');

    const result = renestObject(OBJECT_ID);
    expect(result.moved).toBe(3);
    expect(result.error).toBeUndefined();

    const dirs = fs.readdirSync(objDir()).filter(d => !d.startsWith('.')).sort();
    expect(dirs).toEqual(['2026-07-05', '2026-07-08']);
    expect(fs.readdirSync(path.join(objDir(), '2026-07-05')).sort())
      .toEqual(['a_20260705-220000.jpg', 'b_20260705-230000.jpg']);
  });

  it('marks the object nested and rewrites its file rows', () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    renestObject(OBJECT_ID);

    expect(getObjectLayout(OBJECT_ID)).toBe('nested');
    expect(getLibraryFileRow('M31/2026-07-05/a_20260705-220000.jpg')).toBeDefined();
    expect(getLibraryFileRow('M31/a_20260705-220000.jpg')).toBeUndefined();
  });

  it('keeps the file readable through the normal session queries afterwards', () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    renestObject(OBJECT_ID);

    expect(getLocalSessions(OBJECT_ID).map(s => s.date)).toEqual(['2026-07-05']);
    const files = getLocalFiles(OBJECT_ID, '2026-07-05');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('M31/2026-07-05/a_20260705-220000.jpg');
  });

  it('parks files with no derivable night in the unsorted bucket', () => {
    seedObject();
    seedFlatFile('mystery.jpg', null, null);
    renestObject(OBJECT_ID);
    expect(fs.existsSync(path.join(objDir(), UNSORTED_DIR, 'mystery.jpg'))).toBe(true);
  });

  it('records a file that had no row rather than leaving it unrecorded', () => {
    seedObject();
    fs.mkdirSync(objDir(), { recursive: true });
    fs.writeFileSync(path.join(objDir(), 'stray.jpg'), 'x');
    renestObject(OBJECT_ID);
    expect(getLibraryFileRow(`M31/${UNSORTED_DIR}/stray.jpg`)).toBeDefined();
  });

  it('is idempotent', () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    expect(renestObject(OBJECT_ID).moved).toBe(1);
    const second = renestObject(OBJECT_ID);
    expect(second.alreadyNested).toBe(true);
    expect(second.moved).toBe(0);
    expect(getLibraryFilesForObject(OBJECT_ID)).toHaveLength(1);
  });
});

describe('stored path references', () => {
  it('rewrites sessionImage so the per-session hero does not silently break', () => {
    seedObject();
    seedFlatFile('hero_20260705-220000.jpg', '2026-07-05', '220000');
    stmts.addSession.run(OBJECT_ID, '2026-07-05');
    db.prepare('UPDATE librarySessions SET sessionImage = ? WHERE objectId = ? AND date = ?')
      .run('M31/hero_20260705-220000.jpg', OBJECT_ID, '2026-07-05');

    renestObject(OBJECT_ID);

    const row = db.prepare<[string, string], { sessionImage: string | null }>(
      'SELECT sessionImage FROM librarySessions WHERE objectId = ? AND date = ?',
    ).get(OBJECT_ID, '2026-07-05');
    expect(row?.sessionImage).toBe('M31/2026-07-05/hero_20260705-220000.jpg');
    expect(fs.existsSync(path.join(LIBRARY_DIR, row!.sessionImage!))).toBe(true);
  });

  it('rewrites galleryImage', () => {
    seedObject();
    seedFlatFile('g_20260705-220000.jpg', '2026-07-05', '220000');
    db.prepare('UPDATE libraryObjects SET galleryImage = ? WHERE objectId = ?')
      .run('M31/g_20260705-220000.jpg', OBJECT_ID);

    renestObject(OBJECT_ID);

    const row = db.prepare<[string], { galleryImage: string | null }>(
      'SELECT galleryImage FROM libraryObjects WHERE objectId = ?',
    ).get(OBJECT_ID);
    expect(row?.galleryImage).toBe('M31/2026-07-05/g_20260705-220000.jpg');
  });

  it('rewrites image favorites so they do not vanish', () => {
    seedObject();
    seedFlatFile('f_20260705-220000.jpg', '2026-07-05', '220000');
    db.prepare('INSERT INTO imageFavorites (imagePath, userId) VALUES (?, ?)')
      .run('M31/f_20260705-220000.jpg', 'u1');

    renestObject(OBJECT_ID);

    const paths = db.prepare<[], { imagePath: string }>('SELECT imagePath FROM imageFavorites').all();
    expect(paths.map(p => p.imagePath)).toEqual(['M31/2026-07-05/f_20260705-220000.jpg']);
  });
});

describe('crash recovery', () => {
  it('finishes a move that happened on disk but never reached the database', () => {
    // Exactly the state a crash between renameSync and the row update leaves:
    // the file is already nested, the row still names the flat path.
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    const from = path.join(objDir(), 'a_20260705-220000.jpg');
    const to = path.join(objDir(), '2026-07-05', 'a_20260705-220000.jpg');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    // Row deliberately left pointing at the old path.
    expect(getLibraryFileRow('M31/a_20260705-220000.jpg')).toBeDefined();

    const result = renestObject(OBJECT_ID);

    expect(result.moved).toBe(1);
    expect(result.error).toBeUndefined();
    expect(getObjectLayout(OBJECT_ID)).toBe('nested');
    expect(getLibraryFileRow('M31/2026-07-05/a_20260705-220000.jpg')).toBeDefined();
    expect(getLibraryFileRow('M31/a_20260705-220000.jpg')).toBeUndefined();
  });

  it('leaves the object flat when verification does not balance', () => {
    // A file that disappears mid-run must not be papered over by flipping the
    // layout: a flat reader over a half-nested folder still shows what is left,
    // claiming nested would hide it.
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated failure');
    });
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('simulated failure');
    });
    try {
      const result = renestObject(OBJECT_ID);
      expect(result.skipped).toBe(1);
    } finally {
      spy.mockRestore();
      copySpy.mockRestore();
    }
    expect(getObjectLayout(OBJECT_ID)).toBe('flat');
    expect(fs.existsSync(path.join(objDir(), 'a_20260705-220000.jpg'))).toBe(true);
  });

  it('cleans up an EXDEV copy that reached the destination before the source was removed', () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000', 'same-bytes');
    const from = path.join(objDir(), 'a_20260705-220000.jpg');
    const to = path.join(objDir(), '2026-07-05', 'a_20260705-220000.jpg');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);

    const result = renestObject(OBJECT_ID);

    expect(result.error).toBeUndefined();
    expect(getObjectLayout(OBJECT_ID)).toBe('nested');
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.existsSync(to)).toBe(true);
    expect(getLibraryFileRow('M31/2026-07-05/a_20260705-220000.jpg')).toBeDefined();
    expect(getLibraryFileRow('M31/a_20260705-220000.jpg')).toBeUndefined();
  });

  it('does not delete the source when an existing destination only matches by size', () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000', 'source');
    const from = path.join(objDir(), 'a_20260705-220000.jpg');
    const to = path.join(objDir(), '2026-07-05', 'a_20260705-220000.jpg');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, 'target');

    const result = renestObject(OBJECT_ID);

    expect(result.skipped).toBe(1);
    expect(getObjectLayout(OBJECT_ID)).toBe('flat');
    expect(fs.readFileSync(from, 'utf-8')).toBe('source');
    expect(fs.readFileSync(to, 'utf-8')).toBe('target');
    expect(getLibraryFileRow('M31/a_20260705-220000.jpg')).toBeDefined();
  });
});

describe('renestLibrary', () => {
  it('converts every flat object and reports a summary', async () => {
    seedObject('M31', 'M31');
    seedObject('M42', 'M42');
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    fs.mkdirSync(objDir('M42'), { recursive: true });
    fs.writeFileSync(path.join(objDir('M42'), 'b.jpg'), 'x');

    expect(countFlatObjects()).toBe(2);
    const summary = await renestLibrary();
    expect(summary.objects).toBe(2);
    expect(summary.failed).toBe(0);
    expect(countFlatObjects()).toBe(0);
  });

  it('leaves an already-nested object untouched', async () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    renestObject(OBJECT_ID);
    const before = listObjectFiles(objDir(), 'nested').map(e => e.relPath);
    await renestLibrary();
    expect(listObjectFiles(objDir(), 'nested').map(e => e.relPath)).toEqual(before);
  });

  it('refuses to run while an import lock is held', () => {
    seedObject();
    seedFlatFile('a_20260705-220000.jpg', '2026-07-05', '220000');
    expect(claimImportLock()).toBe(true);
    try {
      const result = renestObject(OBJECT_ID);
      expect(result.error).toMatch(/running/i);
      expect(getObjectLayout(OBJECT_ID)).toBe('flat');
    } finally {
      releaseImportLock();
    }
  });
});

describe('isolation', () => {
  it('runs against its own data dir', () => {
    expect(process.env.DATA_DIR).toBe(TEST_DATA_DIR);
  });
});
