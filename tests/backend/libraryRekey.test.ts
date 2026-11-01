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

import { rekeyLibraryObject, OBJECT_ID_TABLES } from '../../server/lib/library/libraryRekey';
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
    'plannedSessions', 'processingRuns', 'calibrationAttachments', 'journalEntries', 'projectArchives', 'libraryObjects',
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

  // A RESTACKED import used to leave exactly this behind: a flat row with no
  // folder and no files, which raised the "one-time update" prompt for an
  // object with nothing to convert.
  it('flips an empty flat object with no folder on disk to nested', () => {
    seedObject('NGC6888', 'NGC6888', 'flat');

    expect(reconcileLayoutFromDisk()).toBe(1);
    expect(getObjectLayout('NGC6888')).toBe('nested');
  });

  it('flips a flat object whose folder holds only processed images to nested', () => {
    seedObject('NGC6888', 'NGC6888', 'flat');
    const processed = path.join(LIBRARY_DIR, 'NGC6888', 'processed');
    fs.mkdirSync(processed, { recursive: true });
    fs.writeFileSync(path.join(processed, 'stacked.jpg'), 'x');

    expect(reconcileLayoutFromDisk()).toBe(1);
    expect(getObjectLayout('NGC6888')).toBe('nested');
  });

  it('keeps a flat object whose folder is missing but still has copied-file rows (drive not where expected)', () => {
    seedObject('M31', 'M31', 'flat');
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, bytes, importedAt)
       VALUES ('M31', 'M31/a.jpg', 'a.jpg', 'a.jpg', 'stack', '2025-01-01', 1, '2025-01-01T00:00:00Z')`,
    ).run();

    expect(reconcileLayoutFromDisk()).toBe(0);
    expect(getObjectLayout('M31')).toBe('flat');
  });

  it('keeps a flat object whose files are on disk with no rows yet (legacy, pre-backfill)', () => {
    seedObject('M42', 'M42', 'flat');
    fs.mkdirSync(path.join(LIBRARY_DIR, 'M42'), { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M42', 'b.jpg'), 'x');

    expect(reconcileLayoutFromDisk()).toBe(0);
    expect(getObjectLayout('M42')).toBe('flat');
  });
});

describe('rekeyLibraryObject: every table that points at an object', () => {
  it('covers every table with an objectId column (a new one must be added to OBJECT_ID_TABLES or listed here)', () => {
    // Not object-keyed rows to move: the object table itself, a redirect (keyed by designation, points at an id) and a setting.
    const notMoved = new Set(['libraryObjects', 'objectDesignationRedirects', 'appSettings']);
    const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const withObjectId = tables
      .filter(t => db.prepare<[], { name: string }>(`PRAGMA table_info(${t.name})`).all().some(c => /^objectId$/i.test(c.name)))
      .map(t => t.name)
      .filter(name => !notMoved.has(name));
    expect([...OBJECT_ID_TABLES].sort()).toEqual(withObjectId.sort());
  });

  it('moves calibration attachments, journal entries and project archives, with foreign keys enforced', () => {
    seedObject('NGC224_MOSAIC', 'NGC224_mosaic', 'nested');
    db.prepare(
      `INSERT INTO calibrationAttachments (id, objectId, date, calibrationType, folderName, settingsKey, createdAt)
       VALUES ('c1', 'NGC224_MOSAIC', '2026-01-01', 'dark', 'darks', 'k', '2026-01-01')`,
    ).run();
    db.prepare(`INSERT INTO journalEntries (id, night, objectId, createdAt, updatedAt) VALUES ('j1', '2026-01-01', 'NGC224_MOSAIC', 'x', 'x')`).run();

    expect(rekeyLibraryObject('NGC224_MOSAIC', 'M31_MOSAIC')).toBe('rename');

    expect(db.prepare("SELECT objectId FROM calibrationAttachments WHERE id='c1'").get()).toEqual({ objectId: 'M31_MOSAIC' });
    expect(db.prepare("SELECT objectId FROM journalEntries WHERE id='j1'").get()).toEqual({ objectId: 'M31_MOSAIC' });
  });

  it('keeps both texts when two objects wrote a note for the same night', () => {
    seedObject('M31', 'M31', 'nested');
    seedObject('Andromeda', 'Andromeda', 'nested');
    const note = (id: string, objectId: string, text: string) => db.prepare(
      `INSERT INTO notes (id, objectId, date, equipment, notes, createdAt, updatedAt) VALUES (?, ?, '2026-01-01', '', ?, 'x', 'x')`,
    ).run(id, objectId, text);
    note('n1', 'M31', 'clear skies');
    note('n2', 'Andromeda', 'dew on the lens');

    expect(rekeyLibraryObject('Andromeda', 'M31')).toBe('merge');

    const rows = db.prepare<[], { notes: string }>("SELECT notes FROM notes WHERE objectId = 'M31'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBe('clear skies\n\ndew on the lens');
  });
});
