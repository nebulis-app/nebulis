import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-objnote-merge-test-'));
});

import db from '../../server/lib/db';
import { stmts } from '../../server/lib/library/objects';
import { rekeyLibraryObject } from '../../server/lib/library/libraryRekey';
import { deleteLinkedFilesFromDisk, getLinkedFileRows } from '../../server/lib/library/librarySources';

// An object note is user text. A rekey merge must not lose either side's, and
// removing the last linked file must not soft-delete an object that has one.

const A = 'ObjNoteSrc';
const B = 'ObjNoteDst';
const ids = [A, B];

function seedObject(id: string): void {
  stmts.upsertObject.run(id, id, 0, new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null);
}
function setNote(id: string, text: string): void {
  db.prepare('INSERT OR REPLACE INTO objectNotes (objectId, text, updatedAt) VALUES (?, ?, ?)').run(id, text, '2026-01-01T00:00:00Z');
}
const noteOf = (id: string) => db.prepare<[string], { text: string }>('SELECT text FROM objectNotes WHERE objectId = ?').get(id)?.text;

function rekey(from: string, to: string): void {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => { rekeyLibraryObject(from, to, { skipManifest: true }); })();
  db.pragma('foreign_keys = ON');
}

beforeEach(() => {
  for (const id of ids) {
    for (const t of ['objectNotes', 'libraryFiles', 'librarySessions']) db.prepare(`DELETE FROM ${t} WHERE objectId = ?`).run(id);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(id);
  }
});

describe('rekey merge keeps both object notes', () => {
  it('appends the source note after the target note, separated by a blank line', () => {
    seedObject(A); seedObject(B);
    setNote(A, 'from source'); setNote(B, 'from target');
    rekey(A, B);
    expect(noteOf(B)).toBe('from target\n\nfrom source');
    expect(noteOf(A)).toBeUndefined();
  });
  it('moves the source note when the target has none', () => {
    seedObject(A); seedObject(B);
    setNote(A, 'only source');
    rekey(A, B);
    expect(noteOf(B)).toBe('only source');
    expect(noteOf(A)).toBeUndefined();
  });
  it('leaves the target note alone when the source has none', () => {
    seedObject(A); seedObject(B);
    setNote(B, 'only target');
    rekey(A, B);
    expect(noteOf(B)).toBe('only target');
  });
});

describe('retireEmptyObjects treats an object note as user data', () => {
  function linkOne(id: string): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-objnote-src-'));
    fs.writeFileSync(path.join(root, 'a.jpg'), 'x');
    db.prepare(`INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES ('src_on', 'S', ?, 1, ?)`).run(root, new Date().toISOString());
    db.prepare(
      `INSERT OR REPLACE INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, captureDate, sourceId, sourcePath, importedAt)
       VALUES (?, '@src/src_on/a.jpg', 'a.jpg', 'a.jpg', 'stacked', 1, '2026-09-10', 'src_on', 'a.jpg', ?)`,
    ).run(id, new Date().toISOString());
  }
  const deletedFlag = (id: string) => db.prepare<[string], { deleted: number }>('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(id)?.deleted;

  it('keeps an object whose only user data is a note', () => {
    seedObject(A); setNote(A, 'keep me'); linkOne(A);
    deleteLinkedFilesFromDisk(getLinkedFileRows(A));
    expect(deletedFlag(A)).toBe(0);
  });
  it('still retires an empty object with no user data', () => {
    seedObject(A); linkOne(A);
    deleteLinkedFilesFromDisk(getLinkedFileRows(A));
    expect(deletedFlag(A)).toBe(1);
  });
});
