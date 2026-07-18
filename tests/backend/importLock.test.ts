import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-importlock-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// selectActiveTransport runs before the inner try/catch in both runImport and
// syncSessionSubFrames. Before the Phase 2 fix, a throw here propagated all
// the way out with nobody releasing the lock, permanently 409-ing every
// future import until a server restart.
vi.mock('../../server/lib/telescopeTransports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/telescopeTransports')>();
  return {
    ...actual,
    selectActiveTransport: () => { throw new Error('simulated selectActiveTransport failure'); },
  };
});

import { runImport, syncSessionSubFrames, claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('import lock — unleakable claim/release', () => {
  it('runImport releases the lock even when selectActiveTransport throws before the inner try', async () => {
    const profile = createProfile({ name: 'Throws SeeStar', kind: 'other', hostname: '10.0.0.5' });

    // Route handlers claim the lock before dispatching; simulate that here.
    expect(claimImportLock()).toBe(true);

    await expect(
      runImport(undefined, undefined, { telescopeId: profile.id }),
    ).rejects.toThrow('simulated selectActiveTransport failure');

    // The lock must be released, not stuck — a fresh claim must succeed.
    expect(claimImportLock()).toBe(true);
    releaseImportLock();
  });

  it('syncSessionSubFrames releases the lock even when selectActiveTransport throws before the inner try', async () => {
    const profile = createProfile({ name: 'Throws SeeStar 2', kind: 'other', hostname: '10.0.0.6' });

    expect(claimImportLock()).toBe(true);

    await expect(
      syncSessionSubFrames('M42', '2026-06-21', { telescopeId: profile.id }),
    ).rejects.toThrow('simulated selectActiveTransport failure');

    expect(claimImportLock()).toBe(true);
    releaseImportLock();
  });
});
