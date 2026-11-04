import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Scratch dir nests under <repo>/.test-tmp (gitignored, wiped by tests/globalSetup.ts).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-adopt-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// The pipeline's stages reach the network (catalog enrichment, weather).
vi.mock('../../server/lib/library/postImport', () => ({ runPostImport: vi.fn() }));

import db from '../../server/lib/db';
import { getDefaultLibraryDir, setLibraryPath } from '../../server/lib/libraryPath';
import { analyzeLibrary, fixStaleRecords, fixMissingObjects } from '../../server/lib/library/analyze';
import { reconcileAdoptedLibrary } from '../../server/lib/library/adoptReconcile';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { startMigration, getMigrationStatus } from '../../server/lib/libraryMigration';
import { runPostImport } from '../../server/lib/library/postImport';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const STACKED = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';

function addObject(objectId: string, fileCount = 0): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, ?, ?, 0)',
  ).run(objectId, objectId, fileCount, new Date().toISOString());
}

function addSession(objectId: string): void {
  db.prepare('INSERT OR REPLACE INTO librarySessions (objectId, date) VALUES (?, ?)').run(objectId, '2024-10-08');
}

/** An object that was imported from the previous location: row, file record, session. */
function seedOldObject(objectId: string): void {
  addObject(objectId, 1);
  addSession(objectId);
  recordLibraryFile({
    objectId, folderName: objectId, fileName: STACKED, originalName: STACKED, role: 'stacked',
    captureDate: '2024-10-08', captureTime: '220000', bytes: 1,
  });
}

const isDeleted = (objectId: string): number =>
  db.prepare<[string], { deleted: number }>('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(objectId)?.deleted ?? -1;
const fileRows = (objectId: string): number =>
  db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE objectId = ?').get(objectId)?.n ?? 0;
const fileCount = (objectId: string): number =>
  db.prepare<[string], { fileCount: number }>('SELECT fileCount FROM libraryObjects WHERE objectId = ?').get(objectId)?.fileCount ?? -1;

beforeEach(async () => {
  await setLibraryPath('');
  fs.rmSync(getDefaultLibraryDir(), { recursive: true, force: true });
  fs.mkdirSync(getDefaultLibraryDir(), { recursive: true });
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySessions').run();
  db.prepare('DELETE FROM libraryObjects').run();
  vi.mocked(runPostImport).mockClear();
});

describe('missing objects are found whichever repair runs first', () => {
  it('still reports an object whose file rows were already dropped, because it has a session', async () => {
    seedOldObject('GONE1');

    await fixStaleRecords(); // zeroes the file count and deletes the row
    const analysis = await analyzeLibrary();

    expect(analysis.missingObjects.map(o => o.objectId)).toEqual(['GONE1']);
    expect((await fixMissingObjects()).retired).toBe(1);
    expect(isDeleted('GONE1')).toBe(1);
  });

  it('leaves an object with no file, no count and no session alone', async () => {
    addObject('NEVERHAD');

    expect((await analyzeLibrary()).missingObjectCount).toBe(0);
  });

  it('keeps the sessions of a retired object', async () => {
    seedOldObject('GONE2');
    await fixStaleRecords();
    await fixMissingObjects();

    const sessions = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM librarySessions WHERE objectId = ?').get('GONE2')?.n;
    expect(sessions).toBe(1);
  });
});

describe('reconcileAdoptedLibrary', () => {
  it('registers files the new location holds, retires objects it lacks and drops stale rows', async () => {
    // KEPT: has a folder with a file in the new location but lost its rows.
    addObject('KEPT');
    addSession('KEPT');
    fs.mkdirSync(path.join(getDefaultLibraryDir(), 'KEPT'), { recursive: true });
    fs.writeFileSync(path.join(getDefaultLibraryDir(), 'KEPT', STACKED), 'x');
    // GONE: imported before, no folder in the new location.
    seedOldObject('GONE');
    // WISH: never held a file or a session.
    addObject('WISH');

    const result = await reconcileAdoptedLibrary();

    expect(result).toMatchObject({ registeredObjects: 1, retiredObjects: 1, skipped: null });
    expect(fileRows('KEPT')).toBe(1);
    expect(fileCount('KEPT')).toBe(1);
    expect(isDeleted('KEPT')).toBe(0);
    expect(isDeleted('GONE')).toBe(1);
    expect(fileRows('GONE')).toBe(0);
    expect(isDeleted('WISH')).toBe(0);
    expect(runPostImport).toHaveBeenCalledWith(expect.objectContaining({ reason: 'adopt-library', touched: ['KEPT'] }));
  });

  it('reports what it did when a library is adopted', async () => {
    seedOldObject('GONE3');
    const backup = path.join(TEST_DATA_DIR, 'backup');
    fs.mkdirSync(path.join(backup, 'OTHER'), { recursive: true });
    fs.writeFileSync(path.join(backup, 'OTHER', STACKED), 'x');

    startMigration(backup, undefined, { adopt: true });
    for (let i = 0; i < 200 && getMigrationStatus().phase !== 'complete' && getMigrationStatus().phase !== 'error'; i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    const status = getMigrationStatus();
    expect(status.phase).toBe('complete');
    expect(status.adopted).toMatchObject({ retiredObjects: 1, skipped: null });
    expect(isDeleted('GONE3')).toBe(1);
  });
});
