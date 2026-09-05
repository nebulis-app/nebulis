import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-subframe-streamed-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// Spy on both copy primitives while keeping their real implementations, so we
// can assert which path syncSessionSubFrames actually takes.
const spies = vi.hoisted(() => ({ get: vi.fn(), copy: vi.fn() }));
vi.mock('../../server/lib/smb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/smb')>();
  return {
    ...actual,
    smbGetFile: (...args: Parameters<typeof actual.smbGetFile>) => {
      spies.get(...args);
      return actual.smbGetFile(...args);
    },
    smbCopyFileTo: (...args: Parameters<typeof actual.smbCopyFileTo>) => {
      spies.copy(...args);
      return actual.smbCopyFileTo(...args);
    },
  };
});

import { syncSessionSubFrames, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { createProfile } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';

describe('syncSessionSubFrames — streamed copy on local transport (High-2)', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('streams a large frame to disk instead of buffering it via smbGetFile', async () => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    spies.get.mockClear();
    spies.copy.mockClear();

    stmts.upsertObject.run(
      'NGC7293', 'NGC7293', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subframe-streamed-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'NGC7293_sub'));
    // > 1 MB, the workload where buffering-in-RAM matters.
    const big = Buffer.alloc(1024 * 1024 + 512, 7);
    fs.writeFileSync(path.join(deviceRoot, 'NGC7293_sub', 'Light_NGC7293_10.0s_IRCUT_20260621-120000.fit'), big);

    const profile = createProfile({
      name: 'Streamed Copy Scope',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await syncSessionSubFrames('NGC7293', '2026-06-21', { telescopeId: profile.id });

    expect(getImportStatus().error).toBeNull();
    const dest = path.join(LIBRARY_DIR, 'NGC7293', 'Light_NGC7293_10.0s_IRCUT_20260621-120000.fit');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBe(big.length);

    expect(spies.copy).toHaveBeenCalled();
    expect(spies.get).not.toHaveBeenCalled();
  });
});
