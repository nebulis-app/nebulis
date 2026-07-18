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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dwarfisolation-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

const FAILING_OBJECT = 'M42';
const OK_OBJECT = 'M31';
const OK_SESSION_FOLDER = `DWARF_RAW_${OK_OBJECT}_2026-06-21_12-00-00`;
const FAIL_SESSION_FOLDER = `DWARF_RAW_${FAILING_OBJECT}_2026-06-21_12-00-00`;

// listDwarfObjectFiles is unwrapped in runImport's Dwarf branch — one
// unreadable session folder must not abort every remaining object. Mock the
// walker so one target throws and the other succeeds, isolating the fix
// (import.ts's per-object try/catch) from real Dwarf directory parsing.
vi.mock('../../server/lib/walkers/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/walkers/index')>();
  return {
    ...actual,
    discoverDwarfObjects: async () => ([
      { folderName: FAILING_OBJECT, subFolderName: null, _dwarfSessionFolders: [FAIL_SESSION_FOLDER] },
      { folderName: OK_OBJECT, subFolderName: null, _dwarfSessionFolders: [OK_SESSION_FOLDER] },
    ]),
    listDwarfObjectFiles: async (_profile: unknown, object: { folderName: string }) => {
      if (object.folderName === FAILING_OBJECT) {
        throw new Error('simulated unreadable session folder');
      }
      return {
        files: [{ type: 'file' as const, name: `${OK_SESSION_FOLDER}/stacked.jpg`, size: 5 }],
        subFiles: [],
      };
    },
  };
});

import { runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('runImport — Dwarf per-object isolation', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('one unreadable Dwarf session folder does not abort the remaining objects', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-isolation-device-'));
    const okFileDir = path.join(deviceRoot, 'Astronomy', OK_SESSION_FOLDER);
    fs.mkdirSync(okFileDir, { recursive: true });
    fs.writeFileSync(path.join(okFileDir, 'stacked.jpg'), 'jpg12'); // 5 bytes, matches mocked size

    const profile = createProfile({
      name: 'Dwarf Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    const status = getImportStatus();
    // Both objects were counted as processed — the failure didn't stop the loop.
    expect(status.objectsDone).toBe(2);
    expect(status.error).toContain(FAILING_OBJECT);

    // The failing object never got a DB row; the healthy one imported fine.
    expect(stmts.getObject.get(FAILING_OBJECT)).toBeUndefined();
    const okRow = stmts.getObject.get(OK_OBJECT);
    expect(okRow).toBeDefined();
    expect(okRow?.fileCount).toBe(1);
  });
});
