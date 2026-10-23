import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Redirect DATA_DIR + LIBRARY_DIR before any server module loads (paths.ts
// captures them at import time). Same pattern as libraryFolderRestore.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-aliasrepair-test-'));
  process.env.DATA_DIR = dir;
  process.env.LIBRARY_DIR = _path.join(dir, 'library');
  return dir;
});

import fs from 'fs';
import path from 'path';
import { repairAliasDirectories } from '../../server/lib/library/objects';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { resolveCanonicalId } from '../../server/lib/catalogAliases';
import db from '../../server/lib/db';

// repairAliasDirectories runs on every boot: any top-level library folder whose
// name is a catalog alias (C30 -> NGC7331) has its loose files moved into the
// canonical object's folder, and the alias folder is removed once empty.

function lib(...parts: string[]): string {
  return path.join(getLibraryDir(), ...parts);
}

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, layout)
     VALUES (?, ?, 0, '2026-01-01T00:00:00Z', 0, 'flat')`,
  ).run(objectId, folderName);
}

function writeFile(rel: string, body = 'x'): void {
  fs.mkdirSync(path.dirname(lib(rel)), { recursive: true });
  fs.writeFileSync(lib(rel), body);
}

function fileCountOf(objectId: string): number {
  return db.prepare<[string], { fileCount: number }>('SELECT fileCount FROM libraryObjects WHERE objectId = ?').get(objectId)!.fileCount;
}

beforeEach(() => {
  for (const t of ['libraryFiles', 'librarySessions', 'imageFavorites', 'libraryObjects']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  fs.mkdirSync(getLibraryDir(), { recursive: true });
});

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('repairAliasDirectories', () => {
  it('uses the temp library dir (isolation sanity check)', () => {
    expect(getLibraryDir()).toBe(path.join(TEST_DATA_DIR, 'library'));
    expect(resolveCanonicalId('C30')).toBe('NGC7331');
  });

  it('moves files from an alias folder into the canonical object folder and removes the alias folder', () => {
    seedObject('NGC7331', 'NGC7331');
    writeFile('NGC7331/existing.fit');
    writeFile('C30/a.fit');
    writeFile('C30/b.jpg');

    repairAliasDirectories();

    expect(fs.existsSync(lib('C30'))).toBe(false);
    expect(fs.readdirSync(lib('NGC7331')).sort()).toEqual(['a.fit', 'b.jpg', 'existing.fit']);
    expect(fileCountOf('NGC7331')).toBe(3);
  });

  it('targets the DB folderName, not the raw canonical id', () => {
    seedObject('NGC7331', 'NGC 7331');
    writeFile('C30/a.fit');

    repairAliasDirectories();

    expect(fs.existsSync(lib('NGC 7331', 'a.fit'))).toBe(true);
    expect(fs.existsSync(lib('NGC7331'))).toBe(false);
  });

  it('never overwrites an existing file in the target and keeps the alias folder when files remain', () => {
    seedObject('NGC7331', 'NGC7331');
    writeFile('NGC7331/a.fit', 'canonical');
    writeFile('C30/a.fit', 'alias');

    repairAliasDirectories();

    expect(fs.readFileSync(lib('NGC7331', 'a.fit'), 'utf8')).toBe('canonical');
    expect(fs.readFileSync(lib('C30', 'a.fit'), 'utf8')).toBe('alias');
    // Nothing moved, so fileCount is left alone.
    expect(fileCountOf('NGC7331')).toBe(0);
  });

  it('leaves an alias folder alone when the canonical object is not in the DB', () => {
    writeFile('C30/a.fit');

    repairAliasDirectories();

    expect(fs.existsSync(lib('C30', 'a.fit'))).toBe(true);
    expect(fs.existsSync(lib('NGC7331'))).toBe(false);
  });

  it('does not touch non-alias folders or reserved folders', () => {
    seedObject('M31', 'M31');
    writeFile('M31/a.fit');
    writeFile('_archive/C30/a.fit');
    writeFile('RESTACKED/x.fit');

    repairAliasDirectories();

    expect(fs.existsSync(lib('M31', 'a.fit'))).toBe(true);
    expect(fs.existsSync(lib('_archive', 'C30', 'a.fit'))).toBe(true);
    expect(fs.existsSync(lib('RESTACKED', 'x.fit'))).toBe(true);
  });

  it('moves only loose files: nested session folders stay in the alias folder', () => {
    seedObject('NGC7331', 'NGC7331');
    writeFile('C30/loose.fit');
    writeFile('C30/DWARF_RAW_session/stacked.jpg');

    repairAliasDirectories();

    expect(fs.existsSync(lib('NGC7331', 'loose.fit'))).toBe(true);
    expect(fs.existsSync(lib('C30', 'DWARF_RAW_session', 'stacked.jpg'))).toBe(true);
  });

  it('is a no-op when the library directory does not exist', () => {
    fs.rmSync(getLibraryDir(), { recursive: true, force: true });

    expect(() => repairAliasDirectories()).not.toThrow();
    expect(fs.existsSync(getLibraryDir())).toBe(false);
  });

  // Regression (found 2026-10-08, Test Crusade): the repair moved files on disk
  // but never rewrote libraryFiles.relPath, leaving "C30/a.fit" pointing at a
  // path that no longer existed.
  it('keeps libraryFiles.relPath pointing at the moved file', () => {
    seedObject('NGC7331', 'NGC7331');
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, bytes, importedAt)
       VALUES ('NGC7331', 'C30/a.fit', 'a.fit', 'a.fit', 'light', '2026-02-26', 1, '2026-01-01T00:00:00Z')`,
    ).run();
    writeFile('C30/a.fit');

    repairAliasDirectories();

    const { relPath } = db.prepare<[], { relPath: string }>('SELECT relPath FROM libraryFiles').get()!;
    expect(fs.existsSync(lib(relPath))).toBe(true);
  });
});
