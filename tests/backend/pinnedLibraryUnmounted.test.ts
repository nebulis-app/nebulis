import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const DIRS = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const base = _fs.mkdtempSync(_path.join(_root, 'nebulis-pinned-library-'));
  const library = _path.join(base, 'mount-target');
  _fs.mkdirSync(library, { recursive: true });
  process.env.DATA_DIR = _path.join(base, 'data');
  process.env.LIBRARY_DIR = library; // pinned, as in the recommended Docker setup
  return { base, library };
});

import fs from 'fs';
import path from 'path';
import db from '../../server/lib/db';
import { isLibraryPinned } from '../../server/lib/libraryPath';
import { recordLibraryFiles } from '../../server/lib/library/libraryFiles';
import { analyzeLibrary, fixStaleRecords, fixMissingObjects, LibraryUnreadableError } from '../../server/lib/library/analyze';
import { getSubframeUsage, purgeAllSubframes } from '../../server/lib/library/cleanup';

/**
 * A pinned LIBRARY_DIR has no marker file, so nothing proves the right disk is mounted. If the share behind it is
 * missing, Docker leaves the empty mount-target folder, every file probes as ENOENT, and the old code called the
 * whole library stale and let a repair delete the index. The files were never touched; the index was.
 */

const FOLDER = 'PinnedObj';
const SESSION = '2024-10-08_22-00-00';
const OBJECT_ID = 'PINNEDOBJ';
const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `sub_0000${i + 1}_M31_10.0s_LP_20241008-22000${i}.fit`);

const abs = (name: string): string => path.join(DIRS.library, FOLDER, SESSION, name);
const rowCount = (): number =>
  db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE objectId = ?').get(OBJECT_ID)?.n ?? 0;

function seed(files: string[]): void {
  db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(OBJECT_ID);
  db.prepare('INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, ?, ?, 0)')
    .run(OBJECT_ID, FOLDER, files.length, new Date().toISOString());
  db.prepare("UPDATE libraryObjects SET layout = 'nested' WHERE objectId = ?").run(OBJECT_ID);
  for (const name of files) {
    fs.mkdirSync(path.dirname(abs(name)), { recursive: true });
    fs.writeFileSync(abs(name), name);
  }
  recordLibraryFiles(files.map(fileName => ({ objectId: OBJECT_ID, folderName: FOLDER, sessionFolder: SESSION, fileName, role: 'sub' as const })));
}

/** The share goes away: its contents vanish and the empty mount-target folder is what is left. */
function unmount(): void {
  fs.rmSync(DIRS.library, { recursive: true, force: true });
  fs.mkdirSync(DIRS.library, { recursive: true });
}

beforeEach(() => {
  fs.rmSync(DIRS.library, { recursive: true, force: true });
  fs.mkdirSync(DIRS.library, { recursive: true });
});

afterAll(() => {
  fs.rmSync(DIRS.base, { recursive: true, force: true });
});

describe('pinned LIBRARY_DIR with nothing mounted behind it', () => {
  it('is actually pinned in this test', () => {
    expect(isLibraryPinned()).toBe(true);
  });

  it('does not call the library stale: the check reports unreadable instead', async () => {
    seed(names(3));
    unmount();
    const analysis = await analyzeLibrary();
    expect(analysis.staleRecords.count).toBe(0);
    expect(analysis.missingObjectCount).toBe(0);
    expect(analysis.unreadable).toBeGreaterThan(0);
  });

  it('refuses to drop records or retire objects, and leaves every row in place', async () => {
    seed(names(3));
    unmount();
    await expect(fixStaleRecords()).rejects.toBeInstanceOf(LibraryUnreadableError);
    await expect(fixMissingObjects()).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(rowCount()).toBe(3);
    expect(db.prepare<[string], { deleted: number }>('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(OBJECT_ID)?.deleted).toBe(0);
  });

  it('the sub-frame purge removes no records and reports them unreadable', async () => {
    seed(names(3));
    unmount();
    expect((await getSubframeUsage()).unreadable).toBe(3);
    const result = await purgeAllSubframes();
    expect(result.staleRemoved).toBe(0);
    expect(result.deleted).toBe(0);
    expect(rowCount()).toBe(3);
  });
});

describe('pinned LIBRARY_DIR that is mounted: behaviour is unchanged', () => {
  it('still finds and removes a record whose file is really gone', async () => {
    seed(names(3));
    fs.unlinkSync(abs(names(3)[0]));
    expect((await analyzeLibrary()).staleRecords.count).toBe(1);
    expect(await fixStaleRecords()).toEqual({ removed: 1 });
    expect(rowCount()).toBe(2);
  });

  it('an empty pinned library with no records is not a problem', async () => {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(OBJECT_ID);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
    const analysis = await analyzeLibrary();
    expect(analysis.staleRecords.count).toBe(0);
  });
});
