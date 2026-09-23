import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors calibrationScan.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-calibrationattach-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { getArchiveDir } from '../../server/lib/library/archiveFolders';
import { listCalibrationLibrary } from '../../server/lib/library/calibrationScan';
import {
  isAttachableCalibrationType,
  attachCalibrationBundle,
  detachCalibrationBundle,
  getAttachment,
  listAttachmentsForObject,
  resolveAttachmentsForSession,
  findAttachmentsForBundle,
  attachmentBundleStillExists,
  WHOLE_OBJECT_DATE,
} from '../../server/lib/library/calibrationAttachments';
import { stmts } from '../../server/lib/library/objects';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function writeFrame(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'frame-bytes');
}

/** Minimal library object row — attachments reference libraryObjects via a
 *  foreign key (ON DELETE CASCADE), so a real row has to exist first. */
function makeObject(objectId: string, objectName: string) {
  stmts.upsertObject.run(
    objectId, objectId, 1, new Date().toISOString(), 0, null,
    null, objectName, null, null, null, null, null, null, null,
  );
}

describe('isAttachableCalibrationType', () => {
  it('is true only for flat and flatDark', () => {
    expect(isAttachableCalibrationType('flat')).toBe(true);
    expect(isAttachableCalibrationType('flatDark')).toBe(true);
    expect(isAttachableCalibrationType('bias')).toBe(false);
    expect(isAttachableCalibrationType('dark')).toBe(false);
    expect(isAttachableCalibrationType('mixed')).toBe(false);
  });
});

describe('attachCalibrationBundle / detachCalibrationBundle', () => {
  it('attaches a bundle to the whole object when no date is given', () => {
    makeObject('NGC6888', 'NGC 6888');
    const attachment = attachCalibrationBundle({
      objectId: 'NGC6888',
      calibrationType: 'flat',
      scope: null,
      folderName: 'Flats',
      settingsKey: '5|1|100|-8',
    });
    expect(attachment.date).toBe(WHOLE_OBJECT_DATE);
    expect(attachment.objectId).toBe('NGC6888');
    expect(getAttachment(attachment.id)).toEqual(attachment);
  });

  it('attaches a bundle to one specific session date', () => {
    makeObject('IC5146', 'IC 5146');
    const attachment = attachCalibrationBundle({
      objectId: 'IC5146',
      date: '2026-09-04',
      calibrationType: 'flatDark',
      scope: null,
      folderName: 'FlatDarks',
      settingsKey: '5|1|100|-8',
    });
    expect(attachment.date).toBe('2026-09-04');
  });

  it('attaching two bundles of the same type with different settingsKeys creates two independent rows', () => {
    makeObject('M27', 'M 27');
    const first = attachCalibrationBundle({
      objectId: 'M27', date: '2026-08-01', calibrationType: 'flat',
      scope: null, folderName: 'Plan/Flat', settingsKey: 'Ha-key',
    });
    const second = attachCalibrationBundle({
      objectId: 'M27', date: '2026-08-01', calibrationType: 'flat',
      scope: null, folderName: 'Plan/Flat', settingsKey: 'SII-key',
    });
    // Different settingsKey → two separate rows, not a replacement
    expect(second.id).not.toBe(first.id);
    expect(listAttachmentsForObject('M27')).toHaveLength(2);
  });

  it('attaching the same bundle twice (same settingsKey) is idempotent — same id, no duplicate row', () => {
    makeObject('M27b', 'M 27b');
    const first = attachCalibrationBundle({
      objectId: 'M27b', date: '2026-08-01', calibrationType: 'flat',
      scope: null, folderName: 'Plan/Flat', settingsKey: 'Ha-key',
    });
    const second = attachCalibrationBundle({
      objectId: 'M27b', date: '2026-08-01', calibrationType: 'flat',
      scope: null, folderName: 'Plan/Flat', settingsKey: 'Ha-key',
    });
    expect(second.id).toBe(first.id);
    expect(listAttachmentsForObject('M27b')).toHaveLength(1);
  });

  it('a flat attachment and a flatDark attachment on the same (object, date) do not collide', () => {
    makeObject('M13', 'M 13');
    attachCalibrationBundle({ objectId: 'M13', date: '2026-08-01', calibrationType: 'flat', scope: null, folderName: 'Flats', settingsKey: 'A' });
    attachCalibrationBundle({ objectId: 'M13', date: '2026-08-01', calibrationType: 'flatDark', scope: null, folderName: 'FlatDarks', settingsKey: 'B' });
    expect(listAttachmentsForObject('M13')).toHaveLength(2);
  });

  it('detaches by id, and a repeat detach is a no-op that reports false', () => {
    makeObject('M31', 'M 31');
    const attachment = attachCalibrationBundle({
      objectId: 'M31', calibrationType: 'flat', scope: null, folderName: 'Flats', settingsKey: 'A',
    });
    expect(detachCalibrationBundle(attachment.id)).toBe(true);
    expect(getAttachment(attachment.id)).toBeNull();
    expect(detachCalibrationBundle(attachment.id)).toBe(false);
  });
});

describe('resolveAttachmentsForSession', () => {
  it('a session-specific attachment wins over the whole-object one for the same type', () => {
    makeObject('M42', 'M 42');
    attachCalibrationBundle({ objectId: 'M42', calibrationType: 'flat', scope: null, folderName: 'Flats', settingsKey: 'whole-object-flats' });
    attachCalibrationBundle({ objectId: 'M42', date: '2026-01-15', calibrationType: 'flat', scope: null, folderName: 'Flats', settingsKey: 'session-specific-flats' });

    const forThatNight = resolveAttachmentsForSession('M42', '2026-01-15');
    expect(forThatNight.find(a => a.calibrationType === 'flat')?.settingsKey).toBe('session-specific-flats');

    // A different night with no session-specific attachment of its own falls
    // back to the whole-object one rather than coming back empty.
    const otherNight = resolveAttachmentsForSession('M42', '2026-02-20');
    expect(otherNight.find(a => a.calibrationType === 'flat')?.settingsKey).toBe('whole-object-flats');
  });

  it('returns nothing for a type with no attachment at all', () => {
    makeObject('NoFlats', 'No Flats Object');
    expect(resolveAttachmentsForSession('NoFlats', '2026-01-01')).toEqual([]);
  });
});

describe('findAttachmentsForBundle', () => {
  it('finds every object a bundle is attached to, with the object name resolved', () => {
    makeObject('WithFlats', 'Pretty Nebula');
    attachCalibrationBundle({
      objectId: 'WithFlats', date: '2026-09-04', calibrationType: 'flat',
      scope: null, folderName: 'Flats', settingsKey: 'shared-key',
    });

    const found = findAttachmentsForBundle(null, 'Flats', 'shared-key');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ objectId: 'WithFlats', objectName: 'Pretty Nebula', date: '2026-09-04' });
  });

  it('does not cross-match a different scope with the same folderName/key', () => {
    makeObject('ScopeA', 'Scope A Object');
    attachCalibrationBundle({
      objectId: 'ScopeA', calibrationType: 'flat',
      scope: 'telescope-a', folderName: 'Flats', settingsKey: 'same-key',
    });
    // A different (or unscoped) telescope with the exact same folderName/key
    // must not see ScopeA's attachment.
    expect(findAttachmentsForBundle(null, 'Flats', 'same-key')).toEqual([]);
    expect(findAttachmentsForBundle('telescope-b', 'Flats', 'same-key')).toEqual([]);
    expect(findAttachmentsForBundle('telescope-a', 'Flats', 'same-key')).toHaveLength(1);
  });

  it('returns an empty list, not an error, for a bundle nothing is attached to', () => {
    expect(findAttachmentsForBundle(null, 'Flats', 'never-attached')).toEqual([]);
  });
});

describe('attachmentBundleStillExists', () => {
  it('is true once the archived files a settings key describes actually exist', () => {
    const scope = 'exists-scope';
    writeFrame(path.join(getArchiveDir(scope), 'Flats'), 'Flat_5.0s_Bin1_L_gain100_20260904-051928_2deg_-8.0C_0001.fit');
    const group = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Flats')!;
    const set = group.settingsGroups[0];

    makeObject('ExistsCheck', 'Exists Check');
    const attachment = attachCalibrationBundle({
      objectId: 'ExistsCheck', calibrationType: 'flat', scope, folderName: 'Flats', settingsKey: set.key,
    });
    expect(attachmentBundleStillExists(attachment)).toBe(true);
  });

  it('is false once the archive no longer has a bundle at that key (files moved/deleted)', () => {
    makeObject('GoneCheck', 'Gone Check');
    const attachment = attachCalibrationBundle({
      objectId: 'GoneCheck', calibrationType: 'flat', scope: null, folderName: 'Flats', settingsKey: 'no-such-key-anymore',
    });
    expect(attachmentBundleStillExists(attachment)).toBe(false);
  });
});
