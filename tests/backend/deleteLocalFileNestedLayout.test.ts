import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors galleryImageTraversal.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-nestedlayout-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { deleteLocalFile, stmts } from '../../server/lib/library/objects';
import { setObjectLayout } from '../../server/lib/library/libraryLayout';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

const OBJECT_ID = 'NestedTestObj';

function sessionRows(): string[] {
  return db.prepare<[string], { date: string }>('SELECT date FROM librarySessions WHERE objectId = ? ORDER BY date')
    .all(OBJECT_ID)
    .map(r => r.date);
}

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
  db.prepare('DELETE FROM librarySessions WHERE objectId = ?').run(OBJECT_ID);
  db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(OBJECT_ID);
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });

  stmts.upsertObject.run(
    OBJECT_ID, OBJECT_ID, 2, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  setObjectLayout(OBJECT_ID, 'nested');

  // Two nested session folders, each with one real file whose name carries a
  // parseable date. Nested objects store files one level down — this is the
  // shape CODE_AUDIT.md Finding 7 says deleteLocalFile mishandled.
  const objDir = path.join(LIBRARY_DIR, OBJECT_ID);
  const sessionA = path.join(objDir, 'DWARF_RAW_TELE_Session_A');
  const sessionB = path.join(objDir, 'DWARF_RAW_TELE_Session_B');
  fs.mkdirSync(sessionA, { recursive: true });
  fs.mkdirSync(sessionB, { recursive: true });
  fs.writeFileSync(path.join(sessionA, 'Light_NestedTestObj_10.0s_IRCUT_20260621-120000.fits'), 'a');
  fs.writeFileSync(path.join(sessionB, 'Light_NestedTestObj_10.0s_IRCUT_20260622-120000.fits'), 'b');
});

// CODE_AUDIT.md Finding 7: deleteLocalFile rebuilt fileCount/sessions from a
// top-level-only fs.readdirSync(objDir). For a nested-layout object, the top
// level holds session *directories*, not files, so `remaining` was a list of
// directory names, identity.session() derived no date from any of them,
// sessionSet stayed empty, and clearSessions then wiped every session row for
// the object — after deleting a single file from one session.
describe('deleteLocalFile — nested-layout objects', () => {
  it('does not wipe the untouched session after deleting a file from a different session', () => {
    expect(sessionRows()).toEqual([]); // seeded by upsertObject only, not by any session-derivation pass yet

    deleteLocalFile(`${OBJECT_ID}/DWARF_RAW_TELE_Session_A/Light_NestedTestObj_10.0s_IRCUT_20260621-120000.fits`);

    // Session B's file was never touched — its session row must survive.
    expect(sessionRows()).toEqual(['2026-06-22']);
  });

  it('reports the correct fileCount after deleting one file from a nested object', () => {
    deleteLocalFile(`${OBJECT_ID}/DWARF_RAW_TELE_Session_A/Light_NestedTestObj_10.0s_IRCUT_20260621-120000.fits`);

    const row = db.prepare<[string], { fileCount: number }>('SELECT fileCount FROM libraryObjects WHERE objectId = ?').get(OBJECT_ID);
    // One real file remains (session B's); the emptied session-A directory
    // itself must not be counted as a file.
    expect(row?.fileCount).toBe(1);
  });

  it('removes the emptied session once its last file is also deleted', () => {
    deleteLocalFile(`${OBJECT_ID}/DWARF_RAW_TELE_Session_A/Light_NestedTestObj_10.0s_IRCUT_20260621-120000.fits`);
    deleteLocalFile(`${OBJECT_ID}/DWARF_RAW_TELE_Session_B/Light_NestedTestObj_10.0s_IRCUT_20260622-120000.fits`);

    expect(sessionRows()).toEqual([]);
    const row = db.prepare<[string], { fileCount: number }>('SELECT fileCount FROM libraryObjects WHERE objectId = ?').get(OBJECT_ID);
    expect(row?.fileCount).toBe(0);
  });
});
