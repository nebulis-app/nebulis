import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-scopedcancel-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// A deferred gate lets the test pause the import mid-run (after the first of
// two objects starts, before the second's cancel check), so it can capture
// the run's real runId and call cancelImport() deterministically instead of
// racing real timers.
let gateResolve: (() => void) | null = null;
let gateReached = false;
function resetGate() {
  gateReached = false;
  gateResolve = null;
}
function openGate() {
  gateResolve?.();
}

const GATED_OBJECT = 'M1';
const OTHER_OBJECT = 'M2';
const GATED_SESSION_FOLDER = `DWARF_RAW_${GATED_OBJECT}_2026-06-21_12-00-00`;
const OTHER_SESSION_FOLDER = `DWARF_RAW_${OTHER_OBJECT}_2026-06-21_12-00-00`;

vi.mock('../../server/lib/walkers/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/walkers/index')>();
  return {
    ...actual,
    discoverDwarfObjects: async () => ([
      { folderName: GATED_OBJECT, subFolderName: null, _dwarfSessionFolders: [GATED_SESSION_FOLDER] },
      { folderName: OTHER_OBJECT, subFolderName: null, _dwarfSessionFolders: [OTHER_SESSION_FOLDER] },
    ]),
    listDwarfObjectFiles: async (_profile: unknown, object: { folderName: string }) => {
      if (object.folderName === GATED_OBJECT) {
        gateReached = true;
        await new Promise<void>(resolve => { gateResolve = resolve; });
      }
      return { files: [], subFiles: [] };
    },
  };
});

import { runImport, claimImportLock, getImportStatus, cancelImport } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function waitForGate(): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!gateReached) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the gate');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('cancelImport — scoped to a runId', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    resetGate();
  });

  it('does not cancel a run when the runId does not match', async () => {
    const profile = createProfile({
      name: 'Scoped Cancel Test 1',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-cancel-device-')),
    });

    expect(claimImportLock()).toBe(true);
    const runPromise = runImport(undefined, undefined, { telescopeId: profile.id });

    await waitForGate();
    const realRunId = getImportStatus().runId;
    expect(realRunId).not.toBeNull();

    // A caller that doesn't own this run (wrong id) must not cancel it.
    cancelImport('not-this-runs-id');
    openGate();
    await runPromise;

    expect(getImportStatus().error ?? '').not.toMatch(/cancelled/i);
  });

  it('cancels a run when the runId matches', async () => {
    const profile = createProfile({
      name: 'Scoped Cancel Test 2',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-cancel-device-')),
    });

    expect(claimImportLock()).toBe(true);
    const runPromise = runImport(undefined, undefined, { telescopeId: profile.id });

    await waitForGate();
    const realRunId = getImportStatus().runId;
    expect(realRunId).not.toBeNull();

    cancelImport(realRunId!);
    openGate();
    await runPromise;

    expect(getImportStatus().error).toMatch(/cancelled/i);
  });
});
