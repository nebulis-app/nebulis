import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors genericSmbImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-asiair-import-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import os from 'os';
import { runImport, claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import { getLocalSessions } from '../../server/lib/library/observations';
import { getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { createProfile, updateSettingsData, getProfileById } from '../../server/lib/telescopes';
import { getArchiveDir } from '../../server/lib/library/archiveFolders';
import { clearAsiairRootCache } from '../../server/lib/walkers/asiairWalker';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

/**
 * End-to-end proof that an ASIAIR tree round-trips through a real import: the
 * frame-type-first layout resolves to objects, frames land as sub-frames with
 * their original names, Live output lands as a finished image, and calibration
 * goes to the archive instead of the object model.
 */
let sharePath: string;

const LIGHT_1 = 'Light_M42_10.0s_Bin1_S_gain360_20240320-203324_-10.0C_0001.fit';
const LIGHT_2 = 'Light_M42_10.0s_Bin1_S_gain360_20240320-203424_-10.0C_0002.fit';
const PLAN_LIGHT = 'Light_M42_300.0s_Bin1_Ha_gain100_20240321-013000_-10.0C_0001.fit';
const DARK = 'Dark_60s_Bin1_20240320-235959_0018.fit';
const FLAT = 'Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit';

function seedShare(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-asiair-share-'));
  const write = (rel: string, contents: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  };
  write(path.join('Autorun', 'Light', 'M42', LIGHT_1), 'asiair-light-1');
  write(path.join('Autorun', 'Light', 'M42', LIGHT_2), 'asiair-light-2');
  write(path.join('Plan', 'Light', 'M42', PLAN_LIGHT), 'asiair-plan-light');
  // Live output naming is unverified against real hardware; only the per-target
  // folder is documented. Left undated on purpose so these tests cover the
  // undated case rather than asserting a filename we invented.
  write(path.join('Live', 'M42', 'Live_Stack_M42.fit'), 'asiair-live-stack');
  write(path.join('Autorun', 'Dark', DARK), 'asiair-dark');
  write(path.join('Autorun', 'Flat', FLAT), 'asiair-flat');
  return root;
}

async function importShare(opts: { importSubFrames?: boolean } = {}): Promise<string> {
  const profile = createProfile({
    name: 'ASIAIR Test',
    kind: 'asiair',
    connectionType: 'local',
    localPath: sharePath,
    importSubFrames: opts.importSubFrames,
  });
  expect(claimImportLock()).toBe(true);
  try {
    await runImport(undefined, undefined, { telescopeId: profile.id });
  } finally {
    releaseImportLock();
  }
  return profile.id;
}

function objDir(folder = 'M42'): string {
  return path.join(LIBRARY_DIR, folder);
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM librarySessions').run();
  db.prepare('DELETE FROM libraryDeletedSessions').run();
  db.prepare('DELETE FROM telescopeProfiles').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true, importJpg: true, importFits: true, importThumbnails: true });
  clearAsiairRootCache();
  sharePath = seedShare();
});

describe('ASIAIR import', () => {
  it('creates a new profile with sub-frame import already on', () => {
    // Without this an ASIAIR would import nothing: its whole output is frames.
    const id = createProfile({ name: 'ASIAIR Default', kind: 'asiair' }).id;
    expect(getProfileById(id)?.importSubFrames).toBe(true);
  });

  it('discovers one object across Autorun, Plan and Live', async () => {
    await importShare();
    const names = getLibraryFilesForObject('M42').map(r => r.fileName);
    expect(names).toContain(LIGHT_1);
    expect(names).toContain(PLAN_LIGHT);
    expect(names).toContain('Live_Stack_M42.fit');
  });

  it('keeps every imported filename exactly as the device wrote it', async () => {
    await importShare();
    const rows = getLibraryFilesForObject('M42');
    for (const row of rows) {
      expect(row.fileName).toBe(row.originalName);
    }
  });

  it('records Autorun/Plan frames as sub-frames and Live output as a finished image', async () => {
    await importShare();
    const byName = new Map(getLibraryFilesForObject('M42').map(r => [r.fileName, r.role]));
    expect(byName.get(LIGHT_1)).toBe('sub');
    expect(byName.get(PLAN_LIGHT)).toBe('sub');
    expect(byName.get('Live_Stack_M42.fit')).not.toBe('sub');
  });

  it('imports nothing but the Live stack when sub-frame import is off', async () => {
    await importShare({ importSubFrames: false });
    const names = getLibraryFilesForObject('M42').map(r => r.fileName);
    expect(names).toContain('Live_Stack_M42.fit');
    expect(names).not.toContain(LIGHT_1);
    expect(names).not.toContain(PLAN_LIGHT);
  });

  it('splits nights using each frame filename timestamp, not a session folder', async () => {
    await importShare();
    // 20:33 on the 20th and 01:30 on the 21st are the same observing night;
    // the Plan frame after midnight must not open a second session.
    const dates = getLocalSessions('M42').map(s => s.date);
    expect(dates).toEqual(['2024-03-20']);
  });

  it('never creates library objects named after calibration folders', async () => {
    await importShare();
    expect(fs.existsSync(objDir('Dark'))).toBe(false);
    expect(fs.existsSync(objDir('Flat'))).toBe(false);
    expect(fs.existsSync(objDir('Autorun'))).toBe(false);
    expect(fs.existsSync(objDir('Live'))).toBe(false);
  });

  it('archives calibration frames under the telescope scope, keeping their folder', async () => {
    const profileId = await importShare();
    const archive = getArchiveDir(profileId);
    expect(fs.existsSync(path.join(archive, 'Autorun', 'Dark', DARK))).toBe(true);
    expect(fs.existsSync(path.join(archive, 'Autorun', 'Flat', FLAT))).toBe(true);
  });

  it('archives calibration even though archive-all mode is off', async () => {
    // Matches the Dwarf CALI_FRAME rule: on a live sync this data has nowhere
    // else to go, so it is never gated behind "archive everything".
    const profileId = await importShare();
    expect(getProfileById(profileId)?.archiveAllFiles).toBe(false);
    expect(fs.existsSync(path.join(getArchiveDir(profileId), 'Autorun', 'Dark', DARK))).toBe(true);
  });

  it('imports an ASIAIR tree nested under the ASIAir/ folder on removable media', async () => {
    const usbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-asiair-usb-'));
    const inner = path.join(usbRoot, 'ASIAir', 'Autorun', 'Light', 'M42');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, LIGHT_1), 'asiair-usb-light');
    sharePath = usbRoot;

    await importShare();
    expect(getLibraryFilesForObject('M42').map(r => r.fileName)).toContain(LIGHT_1);

    fs.rmSync(usbRoot, { recursive: true, force: true });
  });
});
