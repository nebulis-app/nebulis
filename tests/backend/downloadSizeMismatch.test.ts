import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-sizemismatch-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// A buggy/lying listing claims a size that doesn't match the file streaming
// copy actually produces. The download must be rejected as a mismatch, not
// silently accepted as a truncated or padded file — real smbListDir/
// smbCopyFileTo run underneath so this exercises the actual local-transport
// streaming-copy code path, only the reported size is wrong.
vi.mock('../../server/lib/smb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/smb')>();
  return {
    ...actual,
    smbListDir: async (dirPath: string, profile: unknown) => {
      const real = await actual.smbListDir(dirPath, profile as never);
      return real.map(e => (e.name === 'light_001.fits' ? { ...e, size: 99999 } : e));
    },
  };
});

import { runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('runImport — size mismatch detection survives the streaming-copy path', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a size mismatch as an import error instead of silently accepting a truncated file', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'download-mismatch-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'M31'));
    fs.writeFileSync(path.join(deviceRoot, 'M31', 'light_001.fits'), 'actual-content');

    const profile = createProfile({
      name: 'Mismatch Test Scope',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    expect(getImportStatus().error).toMatch(/size mismatch|failed to download/i);
  });
});
