import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-housekeeping-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { purgeStaleImportTmp, purgeJunkFiles, tick } from '../../server/lib/library/housekeeping';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { setLibraryMigrating } from '../../server/lib/libraryMaintenance';
import { claimImportLock, releaseImportLock, getImportStatus, getImportLockStartedAt, runImport } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const IMPORT_TMP_BASE = path.join(TEST_DATA_DIR, 'import-tmp');
const HOUR_MS = 60 * 60 * 1000;
/** Matches IMPORT_TMP_MAX_AGE_MS in housekeeping.ts. */
const CUTOFF_MS = 6 * HOUR_MS;

function mkStaleDir(name: string, ageMs: number): void {
  const dir = path.join(IMPORT_TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, mtime, mtime);
}

describe('purgeStaleImportTmp', () => {
  beforeEach(() => {
    fs.rmSync(IMPORT_TMP_BASE, { recursive: true, force: true });
  });

  it('is a no-op when the import-tmp base directory does not exist', () => {
    expect(purgeStaleImportTmp()).toMatchObject({ deleted: 0, errors: 0, bytes: 0 });
  });

  it('deletes directories older than the cutoff and keeps fresh ones', () => {
    mkStaleDir('stale-1', CUTOFF_MS + 60_000);
    mkStaleDir('fresh-1', 60_000); // 1 minute old

    const result = purgeStaleImportTmp();

    expect(result).toMatchObject({ deleted: 1, errors: 0, skippedActive: 1 });
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'stale-1'))).toBe(false);
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'fresh-1'))).toBe(true);
  });

  it('treats the cutoff as inclusive (>=, not >)', () => {
    mkStaleDir('exactly-at-cutoff', CUTOFF_MS);
    const result = purgeStaleImportTmp();
    expect(result).toMatchObject({ deleted: 1, errors: 0 });
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'exactly-at-cutoff'))).toBe(false);
  });

  it('keeps a directory just under the cutoff', () => {
    // Margin rather than 1ms: the purge reads its own Date.now() after this
    // line, so a sub-millisecond gap races the clock and the assertion here is
    // about which side of the cutoff wins, not about clock resolution.
    mkStaleDir('just-under', CUTOFF_MS - 5_000);
    const result = purgeStaleImportTmp();
    expect(result).toMatchObject({ deleted: 0, errors: 0, skippedActive: 1 });
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'just-under'))).toBe(true);
  });

  it('ignores stray files at the top level (only directories are candidates)', () => {
    fs.mkdirSync(IMPORT_TMP_BASE, { recursive: true });
    const stray = path.join(IMPORT_TMP_BASE, 'stray.txt');
    fs.writeFileSync(stray, 'x');
    const oldTime = new Date(Date.now() - CUTOFF_MS - 60_000);
    fs.utimesSync(stray, oldTime, oldTime);

    const result = purgeStaleImportTmp();

    expect(result).toMatchObject({ deleted: 0, errors: 0 });
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('deletes a stale directory recursively, and reports the bytes reclaimed', () => {
    const dir = path.join(IMPORT_TMP_BASE, 'stale-with-children');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'upload.part'), 'x'.repeat(100));
    fs.writeFileSync(path.join(dir, 'nested', 'more.part'), 'x'.repeat(50));
    const mtime = new Date(Date.now() - CUTOFF_MS - 60_000);
    fs.utimesSync(dir, mtime, mtime);

    const result = purgeStaleImportTmp();

    expect(result).toMatchObject({ deleted: 1, errors: 0, bytes: 150 });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('skips the sweep entirely while an import is running', () => {
    mkStaleDir('stale-during-import', CUTOFF_MS + 60_000);
    expect(claimImportLock()).toBe(true);
    try {
      const result = purgeStaleImportTmp();
      expect(result).toMatchObject({ deleted: 0, errors: 0 });
      expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'stale-during-import'))).toBe(true);
    } finally {
      releaseImportLock();
    }
  });
});

describe('purgeJunkFiles', () => {
  const OBJ = 'M42';
  const objDir = () => path.join(LIBRARY_DIR, OBJ);
  const write = (name: string) => fs.writeFileSync(path.join(objDir(), name), 'x');

  beforeEach(() => {
    setLibraryMigrating(false);
    fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    fs.mkdirSync(objDir(), { recursive: true });
  });

  it('deletes macOS resource forks and .DS_Store but keeps real image/data files', async () => {
    write('._Light_001.fit');
    write('.DS_Store');
    write('Light_001.fit');
    write('Stacked.jpg');

    const result = await purgeJunkFiles();

    expect(result).toEqual({ deleted: 2, errors: 0 });
    expect(fs.existsSync(path.join(objDir(), '._Light_001.fit'))).toBe(false);
    expect(fs.existsSync(path.join(objDir(), '.DS_Store'))).toBe(false);
    expect(fs.existsSync(path.join(objDir(), 'Light_001.fit'))).toBe(true);
    expect(fs.existsSync(path.join(objDir(), 'Stacked.jpg'))).toBe(true);
  });

  it('keeps the per-file manifest, which is dot-prefixed like real junk', async () => {
    // `.nebulis-files.json` fails isRealFile for exactly the same reason
    // `.DS_Store` does, so without an explicit exclusion this purge silently
    // destroys the rebuild-from-disk record on every scheduled run.
    write('.nebulis-files.json');
    write('.DS_Store');

    const result = await purgeJunkFiles();

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(path.join(objDir(), '.nebulis-files.json'))).toBe(true);
    expect(fs.existsSync(path.join(objDir(), '.DS_Store'))).toBe(false);
  });

  it('does not try to unlink a nested object\'s session directories', async () => {
    // Session folder names carry no file extension, so isRealFile calls them
    // junk. Unlinking a directory fails, which would count an error on every
    // run for every session of every nested object.
    fs.mkdirSync(path.join(objDir(), 'DWARF_RAW_TELE_M42_EXP_60_GAIN_60_2026-02-26-21-54-49-673'));
    fs.mkdirSync(path.join(objDir(), 'processed'));

    const result = await purgeJunkFiles();

    expect(result).toEqual({ deleted: 0, errors: 0 });
    expect(fs.existsSync(path.join(objDir(), 'processed'))).toBe(true);
  });

  it('is a no-op when the library directory does not exist', async () => {
    fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    const result = await purgeJunkFiles();
    expect(result).toEqual({ deleted: 0, errors: 0 });
  });

  it('does not touch junk files sitting directly at the library root (not inside an object dir)', async () => {
    fs.writeFileSync(path.join(LIBRARY_DIR, '.DS_Store'), 'x');
    const result = await purgeJunkFiles();
    // Top-level entries are only ever treated as object directories; a
    // non-directory entry at that level is skipped, not recursed into.
    expect(result).toEqual({ deleted: 0, errors: 0 });
    expect(fs.existsSync(path.join(LIBRARY_DIR, '.DS_Store'))).toBe(true);
  });

  it('skips entirely while the library is migrating', async () => {
    write('.DS_Store');
    setLibraryMigrating(true);
    try {
      const result = await purgeJunkFiles();
      expect(result).toEqual({ deleted: 0, errors: 0 });
      expect(fs.existsSync(path.join(objDir(), '.DS_Store'))).toBe(true);
    } finally {
      setLibraryMigrating(false);
    }
  });
});

describe('auto-import watchdog (tick)', () => {
  beforeEach(() => {
    setLibraryMigrating(false);
    // Reset any lock state a previous test in this suite left behind.
    stmts.setImportRunning.run(0, null);
  });

  it('force-releases a lock held past the stale window and logs loudly', async () => {
    createProfile({
      name: 'Watchdog Scope',
      kind: 'other',
      connectionType: 'local',
      localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-device-')),
      autoImportEnabled: true,
    });

    // Simulate a stuck run: the lock is held, and the DB row says it was
    // claimed 7 hours ago — well past any real import's runtime.
    expect(claimImportLock()).toBe(true);
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    stmts.setImportRunning.run(1, sevenHoursAgo);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await tick();
    // Loud log line, naming how long the lock was stuck. Assert before
    // restoring — mockRestore() clears recorded calls.
    const sawStaleLockError = errorSpy.mock.calls.some(call => String(call[0]).includes('over 6 hours'));
    errorSpy.mockRestore();
    expect(sawStaleLockError).toBe(true);

    // The stale claim was replaced by a fresh one for the due telescope's
    // run, not left stuck at the 7-hour-old timestamp.
    const startedAt = getImportLockStartedAt();
    expect(startedAt).not.toBeNull();
    expect(Date.now() - Date.parse(startedAt!)).toBeLessThan(5000);

    // Let the resumed (local, empty-dir) import finish so it doesn't leak
    // into a later test.
    await vi.waitFor(() => {
      expect(getImportStatus().running).toBe(false);
    }, { timeout: 3000, interval: 20 });
  });

  it('does not touch a lock that is merely busy (not stale)', async () => {
    expect(claimImportLock()).toBe(true);
    // Freshly claimed — nowhere near the 6-hour staleness window.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await tick();
    const sawStaleLockError = errorSpy.mock.calls.some(call => String(call[0]).includes('over 6 hours'));
    errorSpy.mockRestore();

    expect(sawStaleLockError).toBe(false);
    // Still held by the original (simulated) caller — tick() must not have
    // force-released or reclaimed it.
    expect(claimImportLock()).toBe(false);
    stmts.setImportRunning.run(0, null);
  });
});

describe('import lock ownership (runId)', () => {
  beforeEach(() => {
    // A prior test's `claimImportLock()` without a matching release can leave
    // in-memory `importStatus.running` true even after its own DB-row reset.
    releaseImportLock();
    stmts.setImportRunning.run(0, null);
  });

  it('releaseImportLock is a no-op when the passed runId does not match the current owner', async () => {
    const profile = createProfile({
      name: 'Ownership Scope',
      kind: 'other',
      connectionType: 'local',
      localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-device-')),
    });

    // Route handlers always claim the lock before dispatching a run.
    expect(claimImportLock()).toBe(true);

    // runImport runs synchronously up through minting its fresh importStatus
    // (with a new runId) before its first await, so the freshly-minted id is
    // already visible the instant this call returns — no need to await it.
    const runPromise = runImport(undefined, undefined, { telescopeId: profile.id, manual: true });
    const mintedRunId = getImportStatus().runId;
    expect(mintedRunId).toBeTruthy();
    expect(getImportStatus().running).toBe(true);

    // Simulates a run that was force-released as stale by the watchdog and
    // only now, belatedly, reaches its own release call: it must not be able
    // to clobber a different run's (here: this run's) lock.
    releaseImportLock('some-other-runs-id');
    expect(getImportStatus().running).toBe(true);
    expect(getImportStatus().runId).toBe(mintedRunId);

    // The real owner releasing still works.
    releaseImportLock(mintedRunId);
    expect(getImportStatus().running).toBe(false);

    // Let the (local, empty-dir) import actually finish so it doesn't leak
    // into a later test — its own finally will call releaseImportLock again
    // with the same runId, which is a harmless idempotent no-op by then.
    await runPromise;
  });
});
