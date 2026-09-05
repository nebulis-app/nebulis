import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dwarfrestack-listcache-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

const listDirCalls = vi.hoisted(() => [] as string[]);
vi.mock('../../server/lib/smb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/smb')>();
  return {
    ...actual,
    smbListDir: (dirPath: string, profile: unknown) => {
      listDirCalls.push(dirPath);
      return actual.smbListDir(dirPath, profile as never);
    },
  };
});

import { runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { getAllProcessedImagesForObject } from '../../server/lib/library/processed';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('RESTACKED — no double directory walk (High-6)', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('lists each RESTACKED path once (the archive walk), not a second time per subfolder', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-restack-listcache-device-'));
    for (const target of ['M42', 'M31']) {
      const session = `DWARF3_RAW_${target}_EXP_30_GAIN_80_2026-08-01_21-00-00-000`;
      fs.mkdirSync(path.join(deviceRoot, 'Astronomy', session), { recursive: true });
      fs.writeFileSync(path.join(deviceRoot, 'Astronomy', session, 'stacked.jpg'), 'stacked-jpg');
      fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', target), { recursive: true });
      fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'RESTACKED', target, 'megastack.jpg'), `mega-${target}`);
    }

    const profile = createProfile({
      name: 'Dwarf Restack ListCache Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    listDirCalls.length = 0;
    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeFalsy();

    // Both restacks still land.
    expect(getAllProcessedImagesForObject('M42')).toHaveLength(1);
    expect(getAllProcessedImagesForObject('M31')).toHaveLength(1);

    // collectRemoteArchiveCandidates walks RESTACKED once (root) + once per
    // subfolder = 3. The old code re-listed all of them → 6.
    const restackedListings = listDirCalls.filter(p => /(?:^|\/)RESTACKED(?:\/|$)/.test(p));
    expect(restackedListings.length).toBe(3);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });
});
