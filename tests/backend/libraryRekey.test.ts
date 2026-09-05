import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-rekey-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { rekeyLibraryObject } from '../../server/lib/library/libraryRekey';
import { reconcileLayoutFromDisk, getObjectLayout, setObjectLayout } from '../../server/lib/library/libraryLayout';
import { getLibraryFilesForObject, MANIFEST_NAME } from '../../server/lib/library/libraryFiles';
import '../../server/lib/library/objects'; // runs the table-creation + migration blocks
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

void TEST_DATA_DIR;

function seedObject(objectId: string, folderName: string, layout: 'flat' | 'nested'): void {
  db.prepare(
    `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, layout, primaryTelescopeId)
     VALUES (?, ?, ?, ?, 0, ?, 'scope-1')`,
  ).run(objectId, folderName, 3, '2026-01-01T00:00:00Z', layout);
}

function rekey(from: string, to: string): 'rename' | 'merge' | 'noop' {
  db.pragma('foreign_keys = OFF');
  let mode: 'rename' | 'merge' | 'noop' = 'noop';
  db.transaction(() => { mode = rekeyLibraryObject(from, to); })();
  db.pragma('foreign_keys = ON');
  return mode;
}

beforeEach(() => {
  const existing = new Set(
    db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name),
  );
  for (const t of [
    'libraryFiles', 'librarySessions', 'libraryDeletedSessions', 'notes',
    'favorites', 'wishlist', 'sessionProcessedImages', 'captureInfo',
    'plannedSessions', 'processingRuns', 'libraryObjects',
  ]) {
    if (existing.has(t)) db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
});

describe('rekeyLibraryObject — rename (destination absent)', () => {
  it('moves the object and every child row, keeping the layout column', () => {
    seedObject('M31_MOSAIC', 'M31_mosaic', 'nested');
    db.prepare('INSERT INTO librarySessions (objectId, date) VALUES (?, ?)').run('M31_MOSAIC', '2025-10-22');
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, bytes, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', '2025-10-22', 1, '2026-01-01T00:00:00Z')`,
    ).run('M31_MOSAIC', 'M31_mosaic/2025-10-22_00-00-00/stacked.jpg', 'stacked.jpg', 'stacked.jpg');
    db.prepare('INSERT INTO notes (id, objectId, date, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run('n1', 'M31_MOSAIC', '2025-10-22', 'x', 'x');
    db.prepare("INSERT INTO favorites (objectId, userId) VALUES (?, '')").run('M31_MOSAIC');

    const mode = rekey('M31_MOSAIC', 'M31_mosaic');
    expect(mode).toBe('rename');

    expect(db.prepare('SELECT objectId FROM libraryObjects WHERE objectId = ?').get('M31_MOSAIC')).toBeUndefined();
    const row = db.prepare('SELECT layout, primaryTelescopeId FROM libraryObjects WHERE objectId = ?').get('M31_mosaic') as
      | { layout: string; primaryTelescopeId: string }
      | undefined;
    expect(row?.layout).toBe('nested');
    expect(row?.primaryTelescopeId).toBe('scope-1');

    expect(getLibraryFilesForObject('M31_mosaic')).toHaveLength(1);
    expect(getLibraryFilesForObject('M31_MOSAIC')).toHaveLength(0);
    expect(db.prepare('SELECT objectId FROM librarySessions').get()).toEqual({ objectId: 'M31_mosaic' });
    expect(db.prepare('SELECT objectId FROM notes').get()).toEqual({ objectId: 'M31_mosaic' });
    expect(db.prepare('SELECT objectId FROM favorites').get()).toEqual({ objectId: 'M31_mosaic' });
  });

  it('rewrites the on-disk manifest envelope to the new id', () => {
    seedObject('M31_MOSAIC', 'M31_mosaic', 'nested');
    const objDir = path.join(LIBRARY_DIR, 'M31_mosaic', '2025-10-22_00-00-00');
    fs.mkdirSync(objDir, { recursive: true });
    fs.writeFileSync(path.join(objDir, 'stacked.jpg'), 'x');
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, bytes, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', '2025-10-22', 1, '2026-01-01T00:00:00Z')`,
    ).run('M31_MOSAIC', 'M31_mosaic/2025-10-22_00-00-00/stacked.jpg', 'stacked.jpg', 'stacked.jpg');
    fs.writeFileSync(
      path.join(LIBRARY_DIR, 'M31_mosaic', MANIFEST_NAME),
      JSON.stringify({ version: 1, objectId: 'M31_mosaic', updatedAt: '', files: [] }),
    );

    rekey('M31_MOSAIC', 'M31_mosaic');

    const manifest = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'M31_mosaic', MANIFEST_NAME), 'utf-8'));
    expect(manifest.objectId).toBe('M31_mosaic');
    expect(manifest.files).toHaveLength(1);
  });
});

describe('rekeyLibraryObject — merge (destination present)', () => {
  it('folds file count into the destination and drops the source row', () => {
    seedObject('C30', 'C30', 'flat');
    seedObject('NGC7331', 'NGC7331', 'nested');
    db.prepare('INSERT INTO librarySessions (objectId, date) VALUES (?, ?)').run('C30', '2025-01-01');
    db.prepare('INSERT INTO librarySessions (objectId, date) VALUES (?, ?)').run('NGC7331', '2025-02-02');
    // Same date on both sides — the merge must not throw on the PK collision.
    db.prepare('INSERT INTO librarySessions (objectId, date) VALUES (?, ?)').run('C30', '2025-02-02');

    const mode = rekey('C30', 'NGC7331');
    expect(mode).toBe('merge');

    expect(db.prepare('SELECT objectId FROM libraryObjects WHERE objectId = ?').get('C30')).toBeUndefined();
    const merged = db.prepare('SELECT fileCount, layout FROM libraryObjects WHERE objectId = ?').get('NGC7331') as
      | { fileCount: number; layout: string }
      | undefined;
    expect(merged?.fileCount).toBe(6); // 3 + 3
    expect(merged?.layout).toBe('nested');
    const dates = db.prepare('SELECT date FROM librarySessions WHERE objectId = ? ORDER BY date').all('NGC7331');
    expect(dates).toEqual([{ date: '2025-01-01' }, { date: '2025-02-02' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM librarySessions WHERE objectId = ?').get('C30')).toEqual({ n: 0 });
  });
});

describe('reconcileLayoutFromDisk', () => {
  it("flips a flat-marked object to nested when the disk is nested", () => {
    seedObject('M31_mosaic', 'M31_mosaic', 'flat');
    const sess = path.join(LIBRARY_DIR, 'M31_mosaic', '2025-10-22_00-00-00');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, 'Stacked_1_M 31.jpg'), 'x');

    expect(reconcileLayoutFromDisk()).toBe(1);
    expect(getObjectLayout('M31_mosaic')).toBe('nested');
  });

  it('leaves a genuinely flat object alone', () => {
    seedObject('M31', 'M31', 'flat');
    fs.mkdirSync(path.join(LIBRARY_DIR, 'M31'), { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M31', 'Stacked_1_M 31.jpg'), 'x');

    expect(reconcileLayoutFromDisk()).toBe(0);
    expect(getObjectLayout('M31')).toBe('flat');
  });

  it('does not touch an object already marked nested', () => {
    seedObject('M42', 'M42', 'nested');
    setObjectLayout('M42', 'nested');
    // No disk presence at all.
    expect(reconcileLayoutFromDisk()).toBe(0);
  });
});
