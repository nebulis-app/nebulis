import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-subframesync-nested-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  runImport,
  syncSessionSubFrames,
  claimImportLock,
  releaseImportLock,
} from '../../server/lib/library/import';
import { getObjectLayout } from '../../server/lib/library/libraryLayout';
import { getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { createProfile, updateSettingsData } from '../../server/lib/telescopes';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

// Same fixture shape as nestedLayout.test.ts: a real Dwarf session folder name,
// which is what makes the imported object nested (every new Dwarf/SeeStar
// object is nested — see libraryLayout.ts).
const SESSION = 'DWARF_RAW_TELE_C 5_EXP_60_GAIN_60_2026-02-26-21-54-49-673';
const SESSION_NIGHT = '2026-02-26';
const OBJECT_ID = 'IC342'; // "C 5" (Caldwell 5) resolves to its canonical NGC/IC id

let devicePath: string;

function seedDevice(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-dwarf-subsync-device-'));
  const dir = path.join(root, 'Astronomy', SESSION);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stacked.jpg'), 'stack-bytes');
  // Numbered sub-frame — matches dwarfWalker's isSub heuristic (/^\d{3,4}[_-]/).
  fs.writeFileSync(path.join(dir, '0001_frame.fits'), 'sub-frame-bytes');
  return root;
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
  devicePath = seedDevice();
});

describe('syncSessionSubFrames — nested-layout Dwarf object', () => {
  it('lands a synced sub-frame inside the existing session folder, not at the object root', async () => {
    const profile = createProfile({
      name: 'Dwarf Nested Subsync Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: devicePath,
      // Sub-frames disabled during the main import (default), so the numbered
      // file is not pulled in yet — that is what the follow-up sync is for.
      importSubFrames: false,
    });

    // Main import creates the object nested and pulls stacked.jpg, but not
    // the sub-frame (importSubFrames is off).
    expect(claimImportLock()).toBe(true);
    try {
      await runImport(undefined, undefined, { telescopeId: profile.id });
    } finally {
      releaseImportLock();
    }
    expect(getObjectLayout(OBJECT_ID)).toBe('nested');
    const objDir = path.join(LIBRARY_DIR, OBJECT_ID);
    expect(fs.existsSync(path.join(objDir, SESSION, 'stacked.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(objDir, SESSION, '0001_frame.fits'))).toBe(false);
    expect(fs.existsSync(path.join(objDir, '0001_frame.fits'))).toBe(false);

    // Now sync sub-frames for that session explicitly.
    expect(claimImportLock()).toBe(true);
    await syncSessionSubFrames(OBJECT_ID, SESSION_NIGHT, { telescopeId: profile.id });

    // Regression: this used to always write flat (path.join(objLocalDir,
    // file.localName)), scattering the sub-frame at the object root instead of
    // inside the session folder the rest of this object's files live in.
    expect(fs.existsSync(path.join(objDir, SESSION, '0001_frame.fits'))).toBe(true);
    expect(fs.existsSync(path.join(objDir, '0001_frame.fits'))).toBe(false);

    const row = getLibraryFilesForObject(OBJECT_ID).find(r => r.fileName === '0001_frame.fits');
    expect(row).toBeDefined();
    expect(row!.relPath).toBe(`${OBJECT_ID}/${SESSION}/0001_frame.fits`);
  });

  it('is idempotent — a second sync does not re-download or duplicate the file', async () => {
    const profile = createProfile({
      name: 'Dwarf Nested Subsync Idempotent Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: devicePath,
      importSubFrames: false,
    });
    expect(claimImportLock()).toBe(true);
    try {
      await runImport(undefined, undefined, { telescopeId: profile.id });
    } finally {
      releaseImportLock();
    }

    expect(claimImportLock()).toBe(true);
    await syncSessionSubFrames(OBJECT_ID, SESSION_NIGHT, { telescopeId: profile.id });
    expect(claimImportLock()).toBe(true);
    await syncSessionSubFrames(OBJECT_ID, SESSION_NIGHT, { telescopeId: profile.id });

    const rows = getLibraryFilesForObject(OBJECT_ID).filter(r => r.fileName === '0001_frame.fits');
    expect(rows).toHaveLength(1);
  });
});
