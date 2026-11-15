import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors libraryTrash.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-deleteobjsessions-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts, deleteLocalObject, restoreLocalObject } from '../../server/lib/library/objects';
import { getLocalSessions, listDeletedSessions } from '../../server/lib/library/observations';

function seedObject(objectId: string, dates: string[]): void {
  fs.mkdirSync(path.join(LIBRARY_DIR, objectId), { recursive: true });
  for (const date of dates) {
    fs.writeFileSync(path.join(LIBRARY_DIR, objectId, `Light_${objectId}_${date.replace(/-/g, '')}-000000.fits`), 'fits');
  }
  stmts.upsertObject.run(objectId, objectId, dates.length, new Date().toISOString(), 0, null,
    objectId, objectId, 'Galaxy', '', '', null, null, null, null);
  for (const date of dates) stmts.addSession.run(objectId, date);
}

function sessionRows(objectId: string): string[] {
  return db.prepare<[string], { date: string }>('SELECT date FROM librarySessions WHERE objectId = ?')
    .all(objectId).map(r => r.date);
}

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

describe('deleteLocalObject: session rows', () => {
  it('removes the object\'s session rows along with its files', () => {
    seedObject('M83', ['2023-04-13', '2023-04-14']);
    expect(sessionRows('M83')).toHaveLength(2);

    deleteLocalObject('M83');

    expect(sessionRows('M83')).toEqual([]);
  });

  it('does not bring back empty sessions when the object comes back', () => {
    seedObject('NGC613', ['2024-09-28', '2024-09-29']);
    deleteLocalObject('NGC613');

    // Restoring re-enables sync; it must not resurrect the deleted nights as
    // sessions with no files.
    expect(restoreLocalObject('NGC613')).toBe(true);
    expect(getLocalSessions('NGC613')).toEqual([]);
  });

  it('does not tombstone the dates, so a later import of them is not refused', () => {
    seedObject('M20', ['2022-05-02']);
    deleteLocalObject('M20');
    restoreLocalObject('M20');

    expect(listDeletedSessions().filter(s => s.objectId === 'M20')).toEqual([]);
  });
});
