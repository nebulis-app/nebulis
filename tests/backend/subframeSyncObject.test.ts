import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads.
// Mirrors subframeSync.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-subframesync-object-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { syncObjectSubFrames, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { createProfile } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// syncObjectSubFrames runs syncSessionSubFrames once per night of an object,
// re-claiming the import lock between nights.
describe('syncObjectSubFrames — every night in one pass', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  });

  it('downloads sub-frames for all of an object\'s nights and skips deleted ones', async () => {
    // Library object with three nights, one of which was deleted.
    stmts.upsertObject.run(
      'NGC7000', 'NGC7000', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    stmts.addSession.run('NGC7000', '2026-06-21');
    stmts.addSession.run('NGC7000', '2026-06-22');
    stmts.addSessionTombstone.run('NGC7000', '2026-06-23', new Date().toISOString());

    // Device: kind 'other' → walker basePath '' → _sub folder sits at
    // localPath/NGC7000_sub. Files for all three dates are present; only the
    // two live nights should be pulled.
    const deviceRoot = tmpDir('subsync-object-device-');
    fs.mkdirSync(path.join(deviceRoot, 'NGC7000_sub'));
    for (const stamp of ['20260621-120000', '20260622-120000', '20260623-120000']) {
      fs.writeFileSync(
        path.join(deviceRoot, 'NGC7000_sub', `Light_NGC7000_10.0s_IRCUT_${stamp}.fit`),
        `sub-${stamp}`,
      );
    }

    const profile = createProfile({
      name: 'Test SeeStar object-sync',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });
    stmts.setObjectPrimaryTelescopeIfNull.run(profile.id, 'NGC7000');

    expect(claimImportLock()).toBe(true);
    await syncObjectSubFrames('NGC7000');

    const objDir = path.join(LIBRARY_DIR, 'NGC7000');
    const files = fs.existsSync(objDir) ? fs.readdirSync(objDir) : [];
    expect(files).toContain('Light_NGC7000_10.0s_IRCUT_20260621-120000.fit');
    expect(files).toContain('Light_NGC7000_10.0s_IRCUT_20260622-120000.fit');
    // Deleted night must never be resurrected.
    expect(files).not.toContain('Light_NGC7000_10.0s_IRCUT_20260623-120000.fit');

    const status = getImportStatus();
    expect(status.running).toBe(false);
    expect(status.filesDone).toBe(2);
    expect(status.error).toBeNull();
  });

  it('skips nights that have no sub-frames instead of erroring, and downloads the rest', async () => {
    stmts.upsertObject.run(
      'NGC6888', 'NGC6888', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    stmts.addSession.run('NGC6888', '2026-06-21');
    stmts.addSession.run('NGC6888', '2026-06-22');

    // Device has a _sub folder, but only one dated file in it. The 06-22 night
    // has nothing — that must be a silent skip, not a failure.
    const deviceRoot = tmpDir('subsync-object-partial-');
    fs.mkdirSync(path.join(deviceRoot, 'NGC6888_sub'));
    fs.writeFileSync(
      path.join(deviceRoot, 'NGC6888_sub', 'Light_NGC6888_10.0s_IRCUT_20260621-120000.fit'),
      'sub-21',
    );

    const profile = createProfile({
      name: 'Test SeeStar partial',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });
    stmts.setObjectPrimaryTelescopeIfNull.run(profile.id, 'NGC6888');

    expect(claimImportLock()).toBe(true);
    await syncObjectSubFrames('NGC6888');

    const files = fs.readdirSync(path.join(LIBRARY_DIR, 'NGC6888'));
    expect(files).toContain('Light_NGC6888_10.0s_IRCUT_20260621-120000.fit');

    const status = getImportStatus();
    expect(status.running).toBe(false);
    expect(status.filesDone).toBe(1);
    expect(status.error).toBeNull();
  });

  it('reports a plain empty run (no error) when no night has sub-frames', async () => {
    stmts.upsertObject.run(
      'IC5070', 'IC5070', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    stmts.addSession.run('IC5070', '2026-06-21');
    stmts.addSession.run('IC5070', '2026-06-22');

    // Device with NO _sub folder at all.
    const deviceRoot = tmpDir('subsync-object-nosubs-');
    fs.mkdirSync(path.join(deviceRoot, 'IC5070'));

    const profile = createProfile({
      name: 'Test SeeStar no-subs',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });
    stmts.setObjectPrimaryTelescopeIfNull.run(profile.id, 'IC5070');

    expect(claimImportLock()).toBe(true);
    await syncObjectSubFrames('IC5070');

    const status = getImportStatus();
    expect(status.running).toBe(false);
    expect(status.filesDone).toBe(0);
    expect(status.skippedFiles).toBe(0);
    expect(status.error).toBeNull();
  });

  it('does not count failed frame downloads as downloaded (High-7)', async () => {
    // chmod 000 can't block root; skip rather than false-pass.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    stmts.upsertObject.run(
      'NGC6960', 'NGC6960', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    stmts.addSession.run('NGC6960', '2026-06-21');

    const deviceRoot = tmpDir('subsync-object-fail-');
    fs.mkdirSync(path.join(deviceRoot, 'NGC6960_sub'));
    const frame = path.join(deviceRoot, 'NGC6960_sub', 'Light_NGC6960_10.0s_IRCUT_20260621-120000.fit');
    fs.writeFileSync(frame, 'sub-21');
    // Discovery still lists + stats it (dir perms intact); the copy then fails.
    fs.chmodSync(frame, 0o000);

    const profile = createProfile({
      name: 'Test SeeStar all-fail',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });
    stmts.setObjectPrimaryTelescopeIfNull.run(profile.id, 'NGC6960');

    expect(claimImportLock()).toBe(true);
    await syncObjectSubFrames('NGC6960');

    const status = getImportStatus();
    expect(status.running).toBe(false);
    expect(status.filesDone).toBe(0);
    expect(status.error).toBeTruthy();

    fs.chmodSync(frame, 0o644);
  });

  it('reports a finished empty run when the object has no nights', async () => {
    stmts.upsertObject.run(
      'M100', 'M100', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    expect(claimImportLock()).toBe(true);
    await syncObjectSubFrames('M100');

    const status = getImportStatus();
    expect(status.running).toBe(false);
    expect(status.filesDone).toBe(0);
    expect(status.skippedFiles).toBe(0);
    expect(status.error).toBeNull();
  });
});
