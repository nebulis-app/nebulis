import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-golden-import-test-'));
  _process.env.DATA_DIR = dir;
  return dir;
});

import { runImport, commitFolderImport, syncSessionSubFrames, claimImportLock, releaseImportLock, getImportStatus } from '../../server/lib/library/import';
import { scanImportFolder } from '../../server/lib/library/folderScan';
import { createProfile, updateSettingsData } from '../../server/lib/telescopes';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';
import { snapshotLibraryState, type ImportSnapshot } from './helpers/importSnapshot';
import {
  seestarFlat,
  seestarWithSubFolder,
  genericSmbLayout,
  asiairLayout,
  dwarfNested,
  dwarfWithRestacked,
  dwarfWithCalibration,
  type DeviceFixture,
} from './helpers/deviceFixtures';

/**
 * CORE-PIPELINE-REMEDIATION Phase 2 — golden regression gate.
 *
 * Each fixture runs a real import path against a temp device tree over the
 * `local` transport, snapshots every observable effect, then runs it again to
 * prove idempotency. Phases 3–5 must leave these snapshots byte-identical (or
 * explain each diff in the PR).
 */

const RESET_TABLES = [
  'libraryFiles', 'libraryObjects', 'librarySessions', 'libraryDeletedSessions',
  'captureInfo', 'telescopeProfiles', 'importHistory', 'sessionProcessedImages',
  'sessionImportLog',
];

function resetLibrary(): void {
  for (const t of RESET_TABLES) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
}

/** Replace the run's random telescope id with a stable token so the snapshot
 *  is machine-independent. */
function stable(snap: ImportSnapshot, telescopeId?: string): ImportSnapshot {
  const json = telescopeId
    ? JSON.stringify(snap).split(telescopeId).join('TELESCOPE_ID')
    : JSON.stringify(snap);
  return JSON.parse(json) as ImportSnapshot;
}

/** The parts of a snapshot a re-run must not change: everything persisted to
 *  disk or the DB. The live `status` object legitimately differs (a second run
 *  reports skips where the first reported downloads), and `latestHistory` may
 *  gain a zero-new-file row — both are checked separately. */
function persistent(snap: ImportSnapshot) {
  return {
    files: snap.files,
    libraryFiles: snap.libraryFiles,
    librarySessions: snap.librarySessions,
    libraryDeletedSessions: snap.libraryDeletedSessions,
    libraryObjects: snap.libraryObjects,
  };
}

async function importFixture(fx: DeviceFixture, opts: { importSubFrames?: boolean } = {}): Promise<string> {
  const profile = createProfile({
    name: 'Golden Scope',
    kind: fx.kind,
    connectionType: 'local',
    localPath: fx.root,
    importSubFrames: opts.importSubFrames,
  });
  expect(claimImportLock()).toBe(true);
  try {
    await runImport(undefined, undefined, { telescopeId: profile.id });
  } finally {
    releaseImportLock();
  }
  return profile.id;
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
beforeEach(() => {
  resetLibrary();
  updateSettingsData({ groupObservingNights: true, importJpg: true, importFits: true, importThumbnails: true });
});

const liveFixtures: Array<{ name: string; build: () => DeviceFixture; subFrames?: boolean }> = [
  { name: 'seestarFlat', build: seestarFlat },
  { name: 'seestarWithSubFolder', build: seestarWithSubFolder, subFrames: true },
  { name: 'genericSmbLayout', build: genericSmbLayout, subFrames: true },
  // ASIAIR's whole output is frames, so sub-frames on is the realistic case
  // (and what createProfile defaults an ASIAIR profile to).
  { name: 'asiairLayout', build: asiairLayout, subFrames: true },
  { name: 'dwarfNested', build: dwarfNested },
  { name: 'dwarfWithRestacked', build: dwarfWithRestacked },
  { name: 'dwarfWithCalibration', build: dwarfWithCalibration },
];

describe('golden import — runImport (live telescope path)', () => {
  for (const fixture of liveFixtures) {
    it(`${fixture.name} is stable and idempotent`, async () => {
      const fx = fixture.build();
      const telescopeId = await importFixture(fx, { importSubFrames: fixture.subFrames });
      expect(getImportStatus().error).toBeFalsy();

      const first = stable(snapshotLibraryState(), telescopeId);
      expect(first).toMatchSnapshot();

      // Second run: nothing new, persistent state unchanged.
      expect(claimImportLock()).toBe(true);
      try {
        await runImport(undefined, undefined, { telescopeId });
      } finally {
        releaseImportLock();
      }
      expect(getImportStatus().error).toBeFalsy();
      const second = stable(snapshotLibraryState(), telescopeId);
      expect(persistent(second)).toEqual(persistent(first));
      expect(second.latestHistory?.newFiles ?? 0).toBe(0);

      fs.rmSync(fx.root, { recursive: true, force: true });
    });
  }
});

describe('golden import — syncSessionSubFrames', () => {
  it('generic SMB session sub-frame pull is stable and idempotent', async () => {
    const fx = genericSmbLayout();
    const telescopeId = await importFixture(fx); // importSubFrames off by default

    expect(claimImportLock()).toBe(true);
    try {
      await syncSessionSubFrames('M31', '2026-04-26', { telescopeId });
    } finally {
      releaseImportLock();
    }
    expect(getImportStatus().error).toBeFalsy();

    const first = stable(snapshotLibraryState(), telescopeId);
    expect(first).toMatchSnapshot();

    expect(claimImportLock()).toBe(true);
    try {
      await syncSessionSubFrames('M31', '2026-04-26', { telescopeId });
    } finally {
      releaseImportLock();
    }
    const second = stable(snapshotLibraryState(), telescopeId);
    expect(persistent(second)).toEqual(persistent(first));

    fs.rmSync(fx.root, { recursive: true, force: true });
  });
});

describe('golden import — commitFolderImport (wizard path)', () => {
  it('the same Dwarf tree via the folder wizard — records the cross-path shape (Med-1)', async () => {
    const fx = dwarfNested();
    // The wizard equivalent of runImport's walkerBase: point at the Astronomy
    // tree the same way the live path roots itself there.
    const scanRoot = path.join(fx.root, 'Astronomy');
    const scan = scanImportFolder(scanRoot, { importFits: true, importJpg: true, importThumbnails: true } as never);

    await commitFolderImport({
      rootPath: scanRoot,
      importFits: true,
      importJpg: true,
      objects: scan.objects.map(o => ({
        folderName: o.folderName,
        targetObjectId: o.catalogMatch?.id ?? o.folderName,
        targetFolderName: o.catalogMatch?.id ?? o.folderName,
        sessionMap: Object.fromEntries(o.sessions.map(s => [s.date, s.date])),
      })),
    });
    expect(getImportStatus().error).toBeFalsy();

    // No telescope id on the folder path, so no normalization needed.
    const snap = snapshotLibraryState();
    expect(snap).toMatchSnapshot();

    fs.rmSync(fx.root, { recursive: true, force: true });
  });
});
