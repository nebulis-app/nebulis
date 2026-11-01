import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-resetcov-'));
});

import db, { resetLibraryData, RESET_LIBRARY_TABLES } from '../../server/lib/db';
import '../../server/lib/library/objects'; // creates the tables other modules own

// The reset used to clear 8 of 57 tables and then delete the library folder, leaving ghost cards and duplicated
// re-imports. A new table that points at an object must be added to the reset, or deliberately kept here.
const KEPT = new Set([
  'catalogOverrides',            // the user's corrections to catalog data, independent of what is imported
  'objectDesignationRedirects',  // "Remember this" reclassify choices
  'journalEntries',              // the user's own text; the links are cleared instead
  'appSettings',                 // a setting
]);

describe('resetLibraryData', () => {
  it('clears every table that holds an object id unless it is deliberately kept', () => {
    const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const objectKeyed = tables
      .filter(t => db.prepare<[], { name: string }>(`PRAGMA table_info(${t.name})`).all().some(c => /objectid$/i.test(c.name)))
      .map(t => t.name)
      .filter(name => !KEPT.has(name));
    const reset = new Set<string>(RESET_LIBRARY_TABLES);
    expect(objectKeyed.filter(name => !reset.has(name))).toEqual([]);
  });

  it('only names tables that exist', () => {
    const tables = new Set(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    expect([...RESET_LIBRARY_TABLES].filter(t => !tables.has(t))).toEqual([]);
  });

  it('removes object, file and plan rows and unlinks the journal, but keeps the user\'s other data', () => {
    db.prepare("INSERT INTO libraryObjects (objectId, folderName, lastImport) VALUES ('M31', 'M31', 'x')").run();
    db.prepare("INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, bytes, importedAt) VALUES ('M31', 'M31/a.fit', 'a.fit', 'a.fit', 'light', '2026-01-01', 1, 'x')").run();
    db.prepare("INSERT INTO calibrationAttachments (id, objectId, date, calibrationType, folderName, settingsKey, createdAt) VALUES ('c', 'M31', '', 'dark', 'd', 'k', 'x')").run();
    db.prepare("INSERT INTO journalEntries (id, night, objectId, title, createdAt, updatedAt) VALUES ('j', '2026-01-01', 'M31', 'Good night', 'x', 'x')").run();
    db.prepare("INSERT INTO objectDesignationRedirects (designation, targetObjectId, createdAt) VALUES ('M81', 'M82', 'x')").run();

    resetLibraryData();

    const count = (t: string) => (db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).get())!.n;
    expect(count('libraryObjects')).toBe(0);
    expect(count('libraryFiles')).toBe(0);
    expect(count('calibrationAttachments')).toBe(0);
    expect(db.prepare("SELECT title, objectId FROM journalEntries WHERE id = 'j'").get()).toEqual({ title: 'Good night', objectId: null });
    expect(count('objectDesignationRedirects')).toBe(1);
    expect(count('libraryMeta')).toBe(1);
  });
});
