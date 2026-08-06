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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-foldercancel-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { commitFolderImport, getImportStatus, cancelImport, getImportHistory } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Gate the real fs.promises.copyFile the first time it's called, so the test
 *  can pause commitFolderImport mid-object, capture its runId, cancel it, and
 *  resume — deterministically, without racing real timers. Mirrors the
 *  approach in scopedCancel.test.ts, but the folder-import copy loop has no
 *  swappable walker module to hook, so the real fs.promises.copyFile is
 *  patched in place instead (same singleton object import.ts calls into). */
let gateReached = false;
let gateResolve: (() => void) | null = null;
function resetGate() {
  gateReached = false;
  gateResolve = null;
}
function openGate() {
  gateResolve?.();
}

describe('commitFolderImport — cancellation', () => {
  const realCopyFile = fs.promises.copyFile.bind(fs.promises);

  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    resetGate();
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      if (!gateReached) {
        gateReached = true;
        await new Promise<void>(resolve => { gateResolve = resolve; });
      }
      // @ts-expect-error — forwarding whatever args this call received
      return realCopyFile(...args);
    });
  });

  it('stops mid-object on cancel: the in-flight file lands, the rest do not', async () => {
    const root = tmpDir('src-cancel-');
    fs.mkdirSync(path.join(root, 'M42'));
    // Two files in the same object/session; distinct capture times so neither
    // canonical name collides with the other.
    fs.writeFileSync(
      path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg'),
      'jpg-1',
    );
    fs.writeFileSync(
      path.join(root, 'M42', 'Stacked_11_M42_30.0s_IRCUT_20240115-220100.jpg'),
      'jpg-2',
    );

    const commitPromise = commitFolderImport({
      rootPath: root,
      importFits: true,
      objects: [{
        folderName: 'M42',
        targetObjectId: 'M42',
        targetFolderName: 'M42',
        sessionMap: { '2024-01-15': '2024-01-15' },
      }],
    });

    const deadline = Date.now() + 2000;
    while (!gateReached) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the copy gate');
      await new Promise(r => setTimeout(r, 5));
    }

    const runId = getImportStatus().runId;
    expect(runId).not.toBeNull();
    cancelImport(runId!);
    openGate();
    await commitPromise;

    const status = getImportStatus();
    expect(status.running).toBe(false);
    expect(status.error).toMatch(/cancelled/i);
    expect(status.cancelled).toBe(true);

    // Only the file whose copy was already in flight when cancellation was
    // requested landed in the library — the second file, checked by the inner
    // per-file loop's cancel guard, must never have been copied.
    const filesOnDisk = fs.readdirSync(path.join(LIBRARY_DIR, 'M42'))
      .filter(n => !n.startsWith('.'));
    expect(filesOnDisk.length).toBe(1);

    // Recorded in Sync History as a cancellation, not a generic failure.
    const { entries } = getImportHistory(1, 0);
    expect(entries[0].cancelled).toBe(true);
  });
});
