import { describe, it, expect, afterAll, vi } from 'vitest';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors galleryImageTraversal.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-deleteobjtxn-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// Simulates a mid-delete crash/failure at the last of three DB statements.
vi.mock('../../server/lib/library/captureInfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/library/captureInfo')>();
  return {
    ...actual,
    deleteCaptureInfoForObject: vi.fn(() => {
      throw new Error('simulated captureInfo delete failure');
    }),
  };
});

import fs from 'fs';
import db from '../../server/lib/db';
import { deleteLocalObject, stmts } from '../../server/lib/library/objects';
import { recordLibraryFile, getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { saveCaptureInfo, getCaptureInfoForObject } from '../../server/lib/library/captureInfo';

const OBJECT_ID = 'TxnTestObj';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// CODE_AUDIT.md Finding 20: deleteLocalObject ran markObjectDeleted /
// deleteLibraryFileRowsForObject / deleteCaptureInfoForObject as three
// separate statements with no db.transaction. A crash or thrown error
// between them left partial state — e.g. an object tombstoned but its
// libraryFiles/captureInfo rows still present. Wrapping all three in one
// transaction means a failure anywhere rolls all of them back together.
describe('deleteLocalObject — transactional DB update', () => {
  it('rolls back the tombstone and row deletes together when one step fails', () => {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(OBJECT_ID);
    db.prepare('DELETE FROM captureInfo WHERE objectId = ?').run(OBJECT_ID);

    stmts.upsertObject.run(
      OBJECT_ID, OBJECT_ID, 1, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    recordLibraryFile({ objectId: OBJECT_ID, folderName: OBJECT_ID, fileName: 'frame.fits', bytes: 10 });
    saveCaptureInfo({
      objectId: OBJECT_ID, sessionFolder: 'session-a', sessionDate: '2026-06-21',
      exposureSec: 10, gain: 60, filter: null, binning: null,
      framesStacked: 1, framesTaken: 1, framesPlanned: 1,
      minTempC: null, maxTempC: null, raHours: null, decDeg: null,
      target: null, sourceRelPath: null,
    });

    expect(() => deleteLocalObject(OBJECT_ID)).toThrow('simulated captureInfo delete failure');

    // Nothing committed: the object must not be tombstoned, and the rows
    // deleteLibraryFileRowsForObject already ran (before the throwing step,
    // in the same transaction) must have been rolled back with it.
    const row = db.prepare<[string], { deleted: number }>(
      'SELECT deleted FROM libraryObjects WHERE objectId = ?',
    ).get(OBJECT_ID);
    expect(row?.deleted).toBe(0);
    expect(getLibraryFilesForObject(OBJECT_ID)).toHaveLength(1);
    expect(getCaptureInfoForObject(OBJECT_ID)).toHaveLength(1);
  });
});
