import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dupes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { findDuplicateSessionFiles, fixDuplicateSessionFiles } from '../../server/lib/library/duplicateSessions';
import { recordLibraryFile, getLibraryFileRow } from '../../server/lib/library/libraryFiles';
import { setObjectLayout } from '../../server/lib/library/libraryLayout';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { updateSettingsData } from '../../server/lib/telescopes';
import db from '../../server/lib/db';

const OBJECT_ID = 'C6';
const FOLDER = 'C6';
const NIGHT_DIR = '2026-09-15';
const DEVICE_DIR = 'DWARF_RAW_TELE_C 6_EXP_15_GAIN_60_2026-09-15-20-51-09-353';
const NAME = 'C 6_15s60_Duo-Band_20260915-205109160_29C.fits';

function seed(sessionDir: string, fileName: string, bytes: string, importedAt: string): string {
  const dir = path.join(LIBRARY_DIR, FOLDER, sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), bytes);
  recordLibraryFile({
    objectId: OBJECT_ID, folderName: FOLDER, sessionFolder: sessionDir, fileName, originalName: fileName,
    captureDate: '2026-09-15', captureTime: '205109', bytes: bytes.length,
  });
  const rel = `${FOLDER}/${sessionDir}/${fileName}`;
  db.prepare('UPDATE libraryFiles SET importedAt = ? WHERE relPath = ?').run(importedAt, rel);
  return rel;
}

beforeEach(() => {
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySessions').run();
  db.prepare('DELETE FROM imageFavorites').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true });
  stmts.upsertObject.run(
    OBJECT_ID, FOLDER, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  setObjectLayout(OBJECT_ID, 'nested');
});

describe('duplicate session files', () => {
  it('runs against the isolated test data dir', () => {
    expect(process.env.DATA_DIR).toBe(TEST_DATA_DIR);
  });

  it('keeps the device-named copy, deletes the night-named one, and prunes its folder', async () => {
    const night = seed(NIGHT_DIR, NAME, 'same-bytes', '2026-09-25T14:26:00Z');
    const device = seed(DEVICE_DIR, NAME, 'same-bytes', '2026-09-25T14:43:00Z');

    const scan = findDuplicateSessionFiles();
    expect(scan.count).toBe(1);
    expect(scan.pairs[0]).toMatchObject({ keep: device, remove: night });

    const result = await fixDuplicateSessionFiles();

    expect(result).toMatchObject({ removed: 1, skipped: 0 });
    expect(fs.existsSync(path.join(LIBRARY_DIR, FOLDER, NIGHT_DIR))).toBe(false);
    expect(fs.existsSync(path.join(LIBRARY_DIR, device))).toBe(true);
    expect(getLibraryFileRow(night)).toBeUndefined();
    expect(getLibraryFileRow(device)).toBeDefined();
    expect(findDuplicateSessionFiles().count).toBe(0);
  });

  it('repoints a session hero image at the surviving copy', async () => {
    const night = seed(NIGHT_DIR, NAME, 'same-bytes', '2026-09-25T14:26:00Z');
    const device = seed(DEVICE_DIR, NAME, 'same-bytes', '2026-09-25T14:43:00Z');
    stmts.addSession.run(OBJECT_ID, '2026-09-15');
    db.prepare('UPDATE librarySessions SET sessionImage = ? WHERE objectId = ? AND date = ?')
      .run(night, OBJECT_ID, '2026-09-15');

    await fixDuplicateSessionFiles();

    const row = db.prepare<[string, string], { sessionImage: string }>(
      'SELECT sessionImage FROM librarySessions WHERE objectId = ? AND date = ?',
    ).get(OBJECT_ID, '2026-09-15');
    expect(row?.sessionImage).toBe(device);
  });

  it('never deletes when the bytes differ, even though name and size match', async () => {
    const night = seed(NIGHT_DIR, NAME, 'aaaaaaaaaa', '2026-09-25T14:26:00Z');
    const device = seed(DEVICE_DIR, NAME, 'bbbbbbbbbb', '2026-09-25T14:43:00Z');

    const result = await fixDuplicateSessionFiles();

    expect(result).toMatchObject({ removed: 0, skipped: 1 });
    expect(fs.existsSync(path.join(LIBRARY_DIR, night))).toBe(true);
    expect(fs.existsSync(path.join(LIBRARY_DIR, device))).toBe(true);
  });

  it('never deletes when both paths are the same physical file', async () => {
    const night = seed(NIGHT_DIR, NAME, 'same-bytes', '2026-09-25T14:26:00Z');
    const deviceDir = path.join(LIBRARY_DIR, FOLDER, DEVICE_DIR);
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.linkSync(path.join(LIBRARY_DIR, night), path.join(deviceDir, NAME));
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, sessionFolder: DEVICE_DIR, fileName: NAME, originalName: NAME,
      captureDate: '2026-09-15', captureTime: '205109', bytes: 10,
    });

    const result = await fixDuplicateSessionFiles();

    expect(result).toMatchObject({ removed: 0, skipped: 1 });
    expect(fs.existsSync(path.join(LIBRARY_DIR, night))).toBe(true);
    expect(fs.existsSync(path.join(deviceDir, NAME))).toBe(true);
  });

  it('does not treat the same file name on two different nights as a duplicate', () => {
    seed(NIGHT_DIR, 'shotsInfo.json', 'same-bytes', '2026-09-25T14:26:00Z');
    const other = path.join(LIBRARY_DIR, FOLDER, '2026-10-02');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'shotsInfo.json'), 'same-bytes');
    recordLibraryFile({
      objectId: OBJECT_ID, folderName: FOLDER, sessionFolder: '2026-10-02', fileName: 'shotsInfo.json',
      originalName: 'shotsInfo.json', captureDate: '2026-10-02', captureTime: '210000', bytes: 10,
    });

    expect(findDuplicateSessionFiles().count).toBe(0);
  });

  it('is a no-op when there is nothing duplicated', async () => {
    seed(DEVICE_DIR, NAME, 'same-bytes', '2026-09-25T14:43:00Z');
    expect(await fixDuplicateSessionFiles()).toEqual({ removed: 0, freedBytes: 0, skipped: 0 });
  });
});
