import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors remoteListingTraversal.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-smbcache-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// Lets each test swap in its own smbGetFile behavior without re-mocking the
// module. Declared with `let` so vi.hoisted's factory can close over it.
type SmbGetFileImpl = (path: string, maxBytes?: number) => Promise<Buffer>;
const mockState = vi.hoisted(() => ({
  impl: (async () => Buffer.from('unset')) as unknown as SmbGetFileImpl,
}));

vi.mock('../../server/lib/smb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/smb')>();
  return {
    ...actual,
    smbGetFile: (p: string, maxBytes?: number) => mockState.impl(p, maxBytes),
  };
});

import fs from 'fs';
import { cachedSmbGetFile } from '../../server/lib/smbCache';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// CODE_AUDIT.md Finding 13: cachedSmbGetFile wrote whatever rawSmbGetFile
// returned to the cache under a key that doesn't include maxBytes. Every
// backend returns a maxBytes-capped read as a truncated buffer, so a capped
// probe (e.g. a 4KB FITS header read) could poison the cache, and a later
// full-file read that failed live would then serve the truncated buffer back
// as if it were the complete file.
describe('cachedSmbGetFile — must not cache maxBytes-truncated reads as whole files', () => {
  const PROFILE = { hostname: 'scope', shareName: 'share', connectionType: 'local' as const };

  beforeEach(() => {
    mockState.impl = async () => Buffer.from('unset');
  });

  it('does not poison the cache with a capped read, so a later live-failing full read throws instead of returning truncated bytes', async () => {
    const path = 'M42/header-probe.fits';

    // 1. A capped read succeeds live (simulating a 4KB FITS-header probe).
    mockState.impl = async (_p, maxBytes) => Buffer.alloc(maxBytes ?? 4096, 7);
    const capped = await cachedSmbGetFile(path, 4096, PROFILE);
    expect(capped.length).toBe(4096);

    // 2. A later full-file read fails live. Before the fix, step 1 would have
    // written those 4096 bytes to the cache under this same key, and this
    // call would silently return them as if they were the whole file.
    mockState.impl = async () => { throw new Error('live SMB read failed'); };
    await expect(cachedSmbGetFile(path, undefined, PROFILE)).rejects.toThrow('live SMB read failed');
  });

  it('still caches a full (uncapped) read and serves it as an offline fallback', async () => {
    const path = 'M42/full-file.fits';
    const full = Buffer.alloc(10_000, 9);

    mockState.impl = async () => full;
    const first = await cachedSmbGetFile(path, undefined, PROFILE);
    expect(first).toEqual(full);

    mockState.impl = async () => { throw new Error('offline'); };
    const fallback = await cachedSmbGetFile(path, undefined, PROFILE);
    expect(fallback).toEqual(full);
  });

  it('subarrays a cached full read for a capped offline fallback request', async () => {
    const path = 'M42/full-file-2.fits';
    const full = Buffer.alloc(10_000, 3);

    mockState.impl = async () => full;
    await cachedSmbGetFile(path, undefined, PROFILE);

    mockState.impl = async () => { throw new Error('offline'); };
    const fallback = await cachedSmbGetFile(path, 100, PROFILE);
    expect(fallback.length).toBe(100);
    expect(fallback).toEqual(full.subarray(0, 100));
  });
});
