import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-traversal-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// Simulates a hostile or buggy SMB server: one listing entry uses a name with
// path-traversal segments. Before the guard, path.join(objLocalDir, name)
// would resolve outside the object folder — path.join normalizes ".."
// segments through, it doesn't sandbox them.
vi.mock('../../server/lib/smb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/smb')>();
  const fsSync = await import('fs');
  return {
    ...actual,
    smbListDir: async (dirPath: string) => {
      if (dirPath === '') return [{ type: 'dir' as const, name: 'M42' }];
      if (dirPath === 'M42') {
        return [
          { type: 'file' as const, name: 'stacked_M42.fits', size: 5 },
          { type: 'file' as const, name: '../../escaped.fits', size: 5 },
          { type: 'file' as const, name: '..', size: 0 },
        ];
      }
      return [];
    },
    smbGetFile: async () => Buffer.from('fits1'),
    // Local transport streams the copy directly (Phase 5.4) instead of going
    // through smbGetFile — the guard must hold on this path too.
    smbCopyFileTo: async (_srcPath: string, destPath: string) => {
      fsSync.writeFileSync(destPath, 'fits1');
    },
  };
});

import os from 'os';
import { runImport, claimImportLock } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';
import { LIBRARY_DIR, DATA_DIR } from '../../server/lib/paths';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('runImport — rejects path separators in remote listing names', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('does not let a hostile remote file name write outside the object folder', async () => {
    const profile = createProfile({
      name: 'Hostile SMB Test',
      kind: 'other',
      connectionType: 'local',
      localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'traversal-device-')),
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    // The legitimate file landed inside the object folder.
    const objDir = path.join(LIBRARY_DIR, 'M42');
    expect(fs.existsSync(path.join(objDir, 'stacked_M42.fits'))).toBe(true);

    // Neither hostile entry escaped: nothing was written above LIBRARY_DIR,
    // and no file named ".." exists inside the object folder either.
    expect(fs.existsSync(path.join(LIBRARY_DIR, '..', 'escaped.fits'))).toBe(false);
    expect(fs.existsSync(path.join(DATA_DIR, 'escaped.fits'))).toBe(false);
    const entries = fs.readdirSync(objDir).filter(e => e !== '.thumbs');
    expect(entries).toEqual(['stacked_M42.fits']);
  });
});
