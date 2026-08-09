import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-trash-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts, deleteLocalObject, restoreLocalObject, listDeletedObjects } from '../../server/lib/library/objects';
import {
  deleteLocalSession,
  restoreLocalSession,
  listDeletedSessions,
  getLocalSessions,
} from '../../server/lib/library/observations';

function seedObject(objectId: string, dates: string[]): void {
  fs.mkdirSync(path.join(LIBRARY_DIR, objectId), { recursive: true });
  for (const date of dates) {
    fs.writeFileSync(path.join(LIBRARY_DIR, objectId, `Light_${objectId}_${date.replace(/-/g, '')}-000000.fits`), 'fits');
  }
  const cat = { catalogId: objectId, objectName: objectId, objectType: 'Galaxy', constellation: '', description: '', magnitude: null, ra: null, dec: null, distanceLy: null };
  stmts.upsertObject.run(objectId, objectId, dates.length, new Date().toISOString(), 0, null,
    cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
    cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
  for (const date of dates) stmts.addSession.run(objectId, date);
}

describe('library trash: object restore', () => {
  afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

  it('is restorable after delete, and re-eligible for sync', () => {
    seedObject('M81', ['2026-01-01']);
    deleteLocalObject('M81');

    const before = stmts.getObject.get('M81');
    expect(before?.deleted).toBe(1);
    expect(before?.deletedAt).toBeTruthy();
    // The delete really did remove the files — restore must not fabricate them.
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M81'))).toBe(false);

    expect(restoreLocalObject('M81')).toBe(true);

    const after = stmts.getObject.get('M81');
    expect(after?.deleted).toBe(0);
    expect(after?.deletedAt).toBeNull();
    // Still no files on disk: restoring re-enables sync, it does not undelete.
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M81'))).toBe(false);
  });

  it('reports false for an object that is not deleted', () => {
    seedObject('M82', ['2026-01-01']);
    expect(restoreLocalObject('M82')).toBe(false);
  });

  it('reports false for an object that does not exist', () => {
    expect(restoreLocalObject('NOT-A-REAL-OBJECT')).toBe(false);
  });

  it('sorts by deletedAt descending, and excludes live objects', () => {
    seedObject('M83', ['2026-01-01']);
    seedObject('M84', ['2026-01-01']);
    deleteLocalObject('M83');
    // Two deletes in the same test can land in the same millisecond, which
    // would make the ordering assertion below flaky rather than meaningful —
    // so the timestamp is backdated deliberately instead of racing the clock.
    deleteLocalObject('M84');
    stmts.markObjectDeleted.run(new Date(Date.now() - 60_000).toISOString(), 'M83');

    const trash = listDeletedObjects();
    const ids = trash.map(o => o.objectId);
    expect(ids).toContain('M83');
    expect(ids).toContain('M84');
    // M84's deletedAt is newer, so it sorts first.
    expect(ids.indexOf('M84')).toBeLessThan(ids.indexOf('M83'));
    expect(ids).not.toContain('M82'); // never deleted

    restoreLocalObject('M83');
    restoreLocalObject('M84');
    expect(listDeletedObjects().map(o => o.objectId)).not.toContain('M83');
  });
});

describe('library trash: session restore', () => {
  afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

  it('is restorable after delete, without resurrecting the session until a re-sync', () => {
    seedObject('NGC1', ['2026-02-01', '2026-02-02']);
    deleteLocalSession('NGC1', '2026-02-01');

    expect(getLocalSessions('NGC1').map(s => s.date)).not.toContain('2026-02-01');
    expect(restoreLocalSession('NGC1', '2026-02-01')).toBe(true);
    // The tombstone is gone (a future sync would no longer be blocked), but
    // there is nothing to show yet since no files came back.
    expect(getLocalSessions('NGC1').map(s => s.date)).not.toContain('2026-02-01');
  });

  it('reports false for a session that was never deleted', () => {
    seedObject('NGC2', ['2026-02-01']);
    expect(restoreLocalSession('NGC2', '2026-02-01')).toBe(false);
  });

  it('lists deleted sessions, and excludes sessions of a fully-deleted object', () => {
    seedObject('NGC3', ['2026-03-01', '2026-03-02']);
    seedObject('NGC4', ['2026-03-01']);
    deleteLocalSession('NGC3', '2026-03-01');
    deleteLocalSession('NGC3', '2026-03-02');
    deleteLocalObject('NGC4'); // whole-object delete, not a per-session one

    const trash = listDeletedSessions();
    const forNgc3 = trash.filter(s => s.objectId === 'NGC3').map(s => s.date);
    expect(forNgc3).toEqual(expect.arrayContaining(['2026-03-01', '2026-03-02']));
    // NGC4 already shows up whole in the object trash — listing it here too
    // would just be a confusing duplicate of the same restore action.
    expect(trash.some(s => s.objectId === 'NGC4')).toBe(false);

    restoreLocalSession('NGC3', '2026-03-01');
    restoreLocalSession('NGC3', '2026-03-02');
    expect(listDeletedSessions().some(s => s.objectId === 'NGC3')).toBe(false);
  });
});
