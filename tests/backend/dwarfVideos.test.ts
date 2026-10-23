import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors dwarfStartrails.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dwarfvideos-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { discoverDwarfObjects } from '../../server/lib/walkers/dwarfWalker';
import { VIDEOS_TARGET_NAME, VIDEOS_OBJECT_TYPE, VIDEOS_DESCRIPTION, getVideosObjectId, patchVideosObjectMeta } from '../../server/lib/library/dwarfVideos';
import { runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('discoverDwarfObjects — Videos folding', () => {
  it('folds Videos/ clips into one synthetic object', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-videos-device-'));
    // Videos/ is a SIBLING of Astronomy/ on a real Dwarf 3, not nested under it.
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy'), { recursive: true });
    const videosDir = path.join(deviceRoot, 'Videos');
    fs.mkdirSync(path.join(videosDir, 'Thumbnail'), { recursive: true });
    fs.writeFileSync(path.join(videosDir, 'DWARF3_WIDE_TL_2026-08-10-21-07-30-368.mp4'), 'clip-1');
    fs.writeFileSync(path.join(videosDir, 'Thumbnail', 'DWARF3_WIDE_TL_2026-08-10-21-07-30-368.jpg'), 'thumb-1');

    const profile = createProfile({
      name: 'Dwarf Videos Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    const discovered = await discoverDwarfObjects(profile);
    // Astronomy/ is empty, so the folded Videos object is the only one, and
    // there is exactly one of it however many clips the folder holds.
    expect(discovered).toEqual([expect.objectContaining({ folderName: VIDEOS_TARGET_NAME, subFolderName: null })]);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('is unaffected when Videos is absent — no extra entries, ordinary discovery unchanged', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-novideos-device-'));
    const sessionFolder = 'DWARF3_RAW_M31_EXP_30_GAIN_80_2026-08-01_21-00-00-000';
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', sessionFolder), { recursive: true });

    const profile = createProfile({
      name: 'Dwarf no-Videos Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    const discovered = await discoverDwarfObjects(profile);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].folderName).toBe('M31');
    expect(discovered.find(o => o.folderName === VIDEOS_TARGET_NAME)).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('an empty Videos folder (no clips) produces no synthetic object', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-emptyvideos-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy'), { recursive: true });
    fs.mkdirSync(path.join(deviceRoot, 'Videos'), { recursive: true });

    const profile = createProfile({
      name: 'Dwarf empty Videos Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    const discovered = await discoverDwarfObjects(profile);
    expect(discovered.find(o => o.folderName === VIDEOS_TARGET_NAME)).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });
});

describe('runImport — Dwarf Videos end-to-end', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('does not create the object at all when importVideos is off, even though the preview is a plain importable JPG', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-videos-off-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy'), { recursive: true });
    const videosDir = path.join(deviceRoot, 'Videos');
    const thumbDir = path.join(videosDir, 'Thumbnail');
    fs.mkdirSync(thumbDir, { recursive: true });
    fs.writeFileSync(path.join(videosDir, 'DWARF3_WIDE_TL_2026-09-01-10-00-00-000.mp4'), 'clip');
    fs.writeFileSync(path.join(thumbDir, 'DWARF3_WIDE_TL_2026-09-01-10-00-00-000.jpg'), 'thumb');

    const profile = createProfile({
      name: 'Dwarf Videos Off Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
      importVideos: false,
      // importJpg defaults to on — without the includeThumbnails gate, the
      // preview alone would still be enough to materialize the object.
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    expect(getImportStatus().error).toBeFalsy();
    // Runs before any other test in this file creates the (deterministic,
    // shared-per-file-DB) Videos object row, so its absence here is
    // meaningful rather than a leftover from test order.
    const row = stmts.getObject.get(getVideosObjectId());
    expect(row).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('imports each video as its own session under one curated synthetic object, with its preview matched by basename', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-videos-import-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy'), { recursive: true });
    const videosDir = path.join(deviceRoot, 'Videos');
    const thumbDir = path.join(videosDir, 'Thumbnail');
    fs.mkdirSync(thumbDir, { recursive: true });
    fs.writeFileSync(path.join(videosDir, 'DWARF3_WIDE_TL_2026-08-10-21-07-30-368.mp4'), 'clip-content-1');
    fs.writeFileSync(path.join(thumbDir, 'DWARF3_WIDE_TL_2026-08-10-21-07-30-368.jpg'), 'thumb-content-1');
    fs.writeFileSync(path.join(videosDir, 'DWARF3_TELE_TL_2026-07-19-21-49-32-336.mp4'), 'clip-content-2');
    // No matching thumbnail for the second clip — must not block its import.

    const profile = createProfile({
      name: 'Dwarf Videos Import Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
      importVideos: true,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    const status = getImportStatus();
    expect(status.error).toBeFalsy();
    expect(status.objectsDone).toBeGreaterThanOrEqual(1);

    const objectId = getVideosObjectId();
    const row = stmts.getObject.get(objectId);
    expect(row).toBeDefined();
    expect(row?.objectName).toBe(VIDEOS_TARGET_NAME);
    expect(row?.objectType).toBe(VIDEOS_OBJECT_TYPE);
    expect(row?.description).toBe(VIDEOS_DESCRIPTION);

    // Each video is its own session (mirrors STARTRAILS: one capture, one session).
    const sessions = stmts.getSessions.all(objectId);
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // On-disk layout: each video lands in its own session directory (keyed by
    // its own basename, since there's no real per-video device folder), with
    // its basename preserved and its matched preview nested under Thumbnail/.
    // The object directory itself is named after the object id (space-
    // stripped), same convention as every other library object.
    const objectDir = path.join(LIBRARY_DIR, objectId);
    const videoWithThumbDir = path.join(objectDir, 'DWARF3_WIDE_TL_2026-08-10-21-07-30-368');
    expect(fs.existsSync(path.join(videoWithThumbDir, 'DWARF3_WIDE_TL_2026-08-10-21-07-30-368.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(videoWithThumbDir, 'Thumbnail', 'DWARF3_WIDE_TL_2026-08-10-21-07-30-368.jpg'))).toBe(true);
    const videoWithoutThumbDir = path.join(objectDir, 'DWARF3_TELE_TL_2026-07-19-21-49-32-336');
    expect(fs.existsSync(path.join(videoWithoutThumbDir, 'DWARF3_TELE_TL_2026-07-19-21-49-32-336.mp4'))).toBe(true);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });
});

describe('patchVideosObjectMeta — boot-time self-heal', () => {
  it('repairs a stale Videos row (objectType Unknown, no description, un-spaced name)', () => {
    const objectId = getVideosObjectId();
    stmts.upsertObject.run(
      objectId, objectId, 55, new Date().toISOString(), 0, null,
      objectId, objectId, 'Unknown', '', '', null, null, null, null,
    );
    db.prepare(
      `UPDATE libraryObjects SET objectName = ?, objectType = ?, constellation = ?, description = ? WHERE objectId = ?`,
    ).run(objectId, 'Unknown', '', '', objectId);
    const before = stmts.getObject.get(objectId);
    expect(before?.objectName).toBe(objectId);
    expect(before?.objectType).toBe('Unknown');
    expect(before?.description).toBe('');

    patchVideosObjectMeta(objectId);

    const after = stmts.getObject.get(objectId);
    expect(after?.objectName).toBe(VIDEOS_TARGET_NAME);
    expect(after?.objectType).toBe(VIDEOS_OBJECT_TYPE);
    expect(after?.constellation).toBe('');
    expect(after?.description).toBe(VIDEOS_DESCRIPTION);
  });
});
