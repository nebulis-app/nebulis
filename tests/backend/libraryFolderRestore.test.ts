import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-folderrestore-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import * as objects from '../../server/lib/library/objects';
import { restoreSpaceStrippedFolders } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

void TEST_DATA_DIR;

// Real incident (2026-10-07): a startup repair renamed "C 5/" to "C5/" and
// updated libraryObjects.folderName, but every libraryFiles.relPath still began
// "C 5/". The object page then showed "No images yet" over a full folder, for
// every object whose name contained a space. The repair no longer runs;
// restoreSpaceStrippedFolders puts back what it changed.

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, layout)
     VALUES (?, ?, 1, '2026-01-01T00:00:00Z', 0, 'nested')`,
  ).run(objectId, folderName);
}

function seedRow(objectId: string, relPath: string): void {
  db.prepare(
    `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, bytes, importedAt)
     VALUES (?, ?, ?, ?, 'thumbnail', '2026-02-26', 1, '2026-01-01T00:00:00Z')`,
  ).run(objectId, relPath, path.basename(relPath), path.basename(relPath));
}

function seedDisk(folder: string, session = 'DWARF_RAW_TELE_C 5_EXP_120'): string {
  const dir = path.join(LIBRARY_DIR, folder, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stacked.jpg'), 'x');
  return path.join(LIBRARY_DIR, folder);
}

function folderOf(objectId: string): string {
  return db.prepare<[string], { folderName: string }>('SELECT folderName FROM libraryObjects WHERE objectId = ?').get(objectId)!.folderName;
}

beforeEach(() => {
  for (const t of ['libraryFiles', 'librarySessions', 'imageFavorites', 'libraryObjects']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
});

describe('restoreSpaceStrippedFolders', () => {
  it('renames a space-stripped folder back to the name its file records use', () => {
    seedObject('IC342', 'C5');
    seedRow('IC342', 'C 5/DWARF_RAW_TELE_C 5_EXP_120/stacked.jpg');
    seedDisk('C5');

    expect(restoreSpaceStrippedFolders()).toBe(1);

    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C5'))).toBe(false);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C 5', 'DWARF_RAW_TELE_C 5_EXP_120', 'stacked.jpg'))).toBe(true);
    expect(folderOf('IC342')).toBe('C 5');
    // The records were right all along and are not rewritten.
    expect(db.prepare('SELECT relPath FROM libraryFiles WHERE objectId = ?').all('IC342'))
      .toEqual([{ relPath: 'C 5/DWARF_RAW_TELE_C 5_EXP_120/stacked.jpg' }]);
  });

  it('handles several spaces, and is idempotent', () => {
    seedObject('C2025R3PANSTARRS', 'C2025R3PANSTARRS');
    seedRow('C2025R3PANSTARRS', 'C 2025 R3 PANSTARRS/s1/stacked.jpg');
    seedDisk('C2025R3PANSTARRS', 's1');

    expect(restoreSpaceStrippedFolders()).toBe(1);
    expect(folderOf('C2025R3PANSTARRS')).toBe('C 2025 R3 PANSTARRS');
    expect(restoreSpaceStrippedFolders()).toBe(0);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C 2025 R3 PANSTARRS', 's1', 'stacked.jpg'))).toBe(true);
  });

  it('leaves an object alone when its records and folder already agree', () => {
    seedObject('M42', 'M42');
    seedRow('M42', 'M42/s1/stacked.jpg');
    seedDisk('M42', 's1');

    expect(restoreSpaceStrippedFolders()).toBe(0);
    expect(folderOf('M42')).toBe('M42');
  });

  it('leaves a spaced folder that is correctly recorded as it is', () => {
    seedObject('IC1396', 'IC 1396');
    seedRow('IC1396', 'IC 1396/s1/stacked.jpg');
    seedDisk('IC 1396', 's1');

    expect(restoreSpaceStrippedFolders()).toBe(0);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'IC 1396', 's1', 'stacked.jpg'))).toBe(true);
    expect(folderOf('IC1396')).toBe('IC 1396');
  });

  it('touches nothing when both folders exist', () => {
    seedObject('IC342', 'C5');
    seedRow('IC342', 'C 5/s1/stacked.jpg');
    seedDisk('C5', 's1');
    seedDisk('C 5', 's1');

    expect(restoreSpaceStrippedFolders()).toBe(0);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C5', 's1', 'stacked.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C 5', 's1', 'stacked.jpg'))).toBe(true);
    expect(folderOf('IC342')).toBe('C5');
  });

  it('only undoes a pure space-strip, never an arbitrary mismatch', () => {
    // Records say "Andromeda" but the folder is "M31": that is not the damage
    // this repair caused, so it must not be renamed.
    seedObject('M31', 'M31');
    seedRow('M31', 'Andromeda/s1/stacked.jpg');
    seedDisk('M31', 's1');

    expect(restoreSpaceStrippedFolders()).toBe(0);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M31', 's1', 'stacked.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'Andromeda'))).toBe(false);
  });

  it('leaves an object whose records name more than one folder', () => {
    seedObject('IC342', 'C5');
    seedRow('IC342', 'C 5/s1/a.jpg');
    seedRow('IC342', 'C5/s1/b.jpg');
    seedDisk('C5', 's1');

    expect(restoreSpaceStrippedFolders()).toBe(0);
    expect(folderOf('IC342')).toBe('C5');
  });

  it('ignores deleted objects and objects with no copied files', () => {
    seedObject('IC342', 'C5');
    seedRow('IC342', 'C 5/s1/stacked.jpg');
    seedDisk('C5', 's1');
    db.prepare("UPDATE libraryObjects SET deleted = 1 WHERE objectId = 'IC342'").run();
    seedObject('NGC6888', 'NGC6888'); // no rows at all

    expect(restoreSpaceStrippedFolders()).toBe(0);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C5'))).toBe(true);
  });
});

describe('nothing renames library folders at startup', () => {
  it('the space-stripping repair is gone, and index.ts does not call a rename', () => {
    // A folder the importer creates under the device's own name ("C 5") must
    // keep it. The old repair renamed it at every boot and orphaned its files.
    expect('repairSpaceDirectories' in objects).toBe(false);
    const index = fs.readFileSync(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/repairSpaceDirectories/);
  });
});
