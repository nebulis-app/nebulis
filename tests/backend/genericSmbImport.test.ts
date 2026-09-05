import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors nestedLayout.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-generic-import-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import os from 'os';
import { runImport, syncSessionSubFrames, claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import { getLocalSessions, getLocalFiles } from '../../server/lib/library/observations';
import { getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { getObjectLayout } from '../../server/lib/library/libraryLayout';
import { getCaptureInfoForSession } from '../../server/lib/library/captureInfo';
import { createProfile, updateSettingsData } from '../../server/lib/telescopes';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

/**
 * End-to-end proof that the "Generic SMB Layout" documented in the Add
 * Telescope modal and the Help page actually round-trips through a real
 * import — not just that the walker's own unit tests parse it correctly.
 */
let sharePath: string;

function seedShare(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-generic-share-'));
  const session = path.join(root, 'M31', '2026-04-26_2030');
  fs.mkdirSync(path.join(session, 'lights'), { recursive: true });
  fs.mkdirSync(path.join(session, 'subframes'), { recursive: true });
  fs.writeFileSync(path.join(session, 'lights', 'M31_stacked.fit'), 'stacked-fits-bytes');
  fs.writeFileSync(path.join(session, 'lights', 'M31_stacked.jpg'), 'stacked-jpg-bytes');
  fs.writeFileSync(path.join(session, 'subframes', 'M31_001.fit'), 'sub-1');
  fs.writeFileSync(path.join(session, 'subframes', 'M31_002.fit'), 'sub-2');
  fs.writeFileSync(path.join(session, 'meta.json'), JSON.stringify({
    exposureSec: 30, gain: 80, filter: 'L', frameCount: 120,
  }));
  return root;
}

async function importShare(
  opts: { importSubFrames?: boolean } = {},
): Promise<string> {
  const profile = createProfile({
    name: 'Generic SMB Test',
    kind: 'other',
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

function objDir(folder: string = 'M31'): string {
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
  db.prepare('DELETE FROM captureInfo').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true, importJpg: true, importFits: true, importThumbnails: true });
  sharePath = seedShare();
});

describe('Generic SMB Layout import (telescope kind "other")', () => {
  it('imports the lights/ finals', async () => {
    await importShare();
    const names = getLibraryFilesForObject('M31').map(r => r.fileName);
    expect(names).toContain('M31_stacked.fit');
    expect(names).toContain('M31_stacked.jpg');
  });

  it('leaves subframes/ behind when sub-frame import is off (the default)', async () => {
    await importShare();
    const names = getLibraryFilesForObject('M31').map(r => r.fileName);
    expect(names).not.toContain('M31_001.fit');
    expect(names).not.toContain('M31_002.fit');
  });

  it('imports subframes/ when sub-frame import is on', async () => {
    await importShare({ importSubFrames: true });
    const names = getLibraryFilesForObject('M31').map(r => r.fileName);
    expect(names).toContain('M31_001.fit');
    expect(names).toContain('M31_002.fit');
  });

  it('places files under a session directory named for the source session folder', async () => {
    await importShare();
    expect(getObjectLayout('M31')).toBe('nested');
    expect(fs.existsSync(path.join(objDir(), '2026-04-26_2030', 'M31_stacked.jpg'))).toBe(true);
  });

  it('reads the session date from the YYYY-MM-DD prefix of the session folder', async () => {
    await importShare();
    const sessions = getLocalSessions('M31');
    expect(sessions.map(s => s.date)).toEqual(['2026-04-26']);
  });

  it('serves the imported files back through the observations API', async () => {
    await importShare();
    const files = getLocalFiles('M31', '2026-04-26').map(f => f.name);
    expect(files).toContain('M31_stacked.jpg');
  });

  it('ingests meta.json into captureInfo', async () => {
    await importShare();
    const rows = getCaptureInfoForSession('M31', '2026-04-26');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ exposureSec: 30, gain: 80, filter: 'L', framesStacked: 120 });
  });

  it('does not create a library object for a folder with no valid session', async () => {
    fs.mkdirSync(path.join(sharePath, 'EmptyObject', '2026-05-01_1900', 'subframes'), { recursive: true });
    fs.writeFileSync(path.join(sharePath, 'EmptyObject', '2026-05-01_1900', 'subframes', 'a.fit'), 'x');

    await importShare();

    expect(fs.existsSync(objDir('EmptyObject'))).toBe(false);
  });

  it('is idempotent — a second run adds nothing new', async () => {
    await importShare();
    const before = getLibraryFilesForObject('M31').length;
    await importShare();
    expect(getLibraryFilesForObject('M31')).toHaveLength(before);
  });

  it('still imports a flat (non-nested) custom SMB folder the old way, unaffected', async () => {
    // Backward compatibility: an object with no session-folder layout at all
    // (the pre-existing "any SMB share" behavior) must keep working exactly
    // as it did before the Generic SMB Layout was added.
    fs.mkdirSync(path.join(sharePath, 'NGC7000'), { recursive: true });
    fs.writeFileSync(path.join(sharePath, 'NGC7000', 'NGC7000_20260501-210000.jpg'), 'flat-file-bytes');

    await importShare();

    const names = getLibraryFilesForObject('NGC7000').map(r => r.fileName);
    expect(names).toContain('NGC7000_20260501-210000.jpg');
  });
});

describe('syncSessionSubFrames — pulling subframes/ on demand for one session', () => {
  it('downloads subframes/ for a session that was imported without them', async () => {
    const telescopeId = await importShare(); // importSubFrames defaults to off
    expect(getLibraryFilesForObject('M31').map(r => r.fileName)).not.toContain('M31_001.fit');

    expect(claimImportLock()).toBe(true);
    try {
      await syncSessionSubFrames('M31', '2026-04-26', { telescopeId });
    } finally {
      releaseImportLock();
    }

    const names = getLibraryFilesForObject('M31').map(r => r.fileName);
    expect(names).toContain('M31_001.fit');
    expect(names).toContain('M31_002.fit');
    expect(fs.existsSync(path.join(objDir(), '2026-04-26_2030', 'M31_001.fit'))).toBe(true);
  });

  it('errors when the object has no session folder on the requested date', async () => {
    const telescopeId = await importShare();

    expect(claimImportLock()).toBe(true);
    try {
      await syncSessionSubFrames('M31', '2099-01-01', { telescopeId });
    } finally {
      releaseImportLock();
    }

    expect(getLibraryFilesForObject('M31').map(r => r.fileName)).not.toContain('M31_001.fit');
  });
});
