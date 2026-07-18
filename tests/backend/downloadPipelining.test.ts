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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-downloadpipe-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';
import { LIBRARY_DIR } from '../../server/lib/paths';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('runImport — concurrent download pipelining and streaming copy', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('downloads every file for an object over local (streaming-copy) transport without corruption', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'download-pipe-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'M42'));
    const contents: Record<string, string> = {};
    for (let i = 0; i < 6; i++) {
      const name = `light_${String(i).padStart(3, '0')}.fits`;
      const body = `fake-fits-content-${i}-${'x'.repeat(50)}`;
      contents[name] = body;
      fs.writeFileSync(path.join(deviceRoot, 'M42', name), body);
    }

    const profile = createProfile({
      name: 'Pipeline Test Scope',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    expect(getImportStatus().error).toBeNull();

    const objDir = path.join(LIBRARY_DIR, 'M42');
    for (const [name, body] of Object.entries(contents)) {
      const written = fs.readFileSync(path.join(objDir, name), 'utf8');
      expect(written).toBe(body);
    }
  });
});
