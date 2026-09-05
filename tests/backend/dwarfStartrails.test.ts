import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors dwarfIsolation.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dwarfstartrails-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { discoverDwarfObjects } from '../../server/lib/walkers/dwarfWalker';
import { STARTRAILS_TARGET_NAME, STARTRAILS_OBJECT_TYPE, getStartrailsObjectId, patchStartrailsObjectMeta } from '../../server/lib/library/dwarfStartrails';
import { runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';
import db from '../../server/lib/db';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('discoverDwarfObjects — STARTRAILS folding', () => {
  it('folds STARTRAILS capture folders into one synthetic object', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-startrails-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'STARTRAILS', '2026-08-01_22-15-00'), { recursive: true });
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'STARTRAILS', '2026-08-02_21-40-00'), { recursive: true });

    const profile = createProfile({
      name: 'Dwarf STARTRAILS Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    const discovered = await discoverDwarfObjects(profile);
    const startrails = discovered.find(o => o.folderName === STARTRAILS_TARGET_NAME);
    expect(startrails).toBeDefined();
    expect(startrails?._dwarfSessionFolders?.sort()).toEqual(['2026-08-01_22-15-00', '2026-08-02_21-40-00']);
    expect(startrails?._dwarfSessionBase).toBe(path.posix.join('Astronomy', 'STARTRAILS'));

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('is unaffected when STARTRAILS is absent — no extra entries, ordinary discovery unchanged', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-nostartrails-device-'));
    const sessionFolder = 'DWARF3_RAW_M31_EXP_30_GAIN_80_2026-08-01_21-00-00-000';
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', sessionFolder), { recursive: true });

    const profile = createProfile({
      name: 'Dwarf no-STARTRAILS Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    const discovered = await discoverDwarfObjects(profile);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].folderName).toBe('M31');
    expect(discovered.find(o => o.folderName === STARTRAILS_TARGET_NAME)).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('an empty STARTRAILS folder (no capture subfolders) produces no synthetic object', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-emptystartrails-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'STARTRAILS'), { recursive: true });

    const profile = createProfile({
      name: 'Dwarf empty STARTRAILS Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    const discovered = await discoverDwarfObjects(profile);
    expect(discovered.find(o => o.folderName === STARTRAILS_TARGET_NAME)).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });
});

describe('runImport — Dwarf STARTRAILS end-to-end', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('imports STARTRAILS captures as sessions under one curated synthetic object', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-startrails-import-device-'));
    const capture1 = path.join(deviceRoot, 'Astronomy', 'STARTRAILS', '2026-08-01_22-15-00');
    const capture2 = path.join(deviceRoot, 'Astronomy', 'STARTRAILS', '2026-08-02_21-40-00');
    fs.mkdirSync(capture1, { recursive: true });
    fs.mkdirSync(capture2, { recursive: true });
    fs.writeFileSync(path.join(capture1, 'startrail.jpg'), 'jpg-1');
    fs.writeFileSync(path.join(capture2, 'startrail.jpg'), 'jpg-2');

    const profile = createProfile({
      name: 'Dwarf STARTRAILS Import Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    const status = getImportStatus();
    expect(status.objectsDone).toBeGreaterThanOrEqual(1);

    const objectId = getStartrailsObjectId();
    const row = stmts.getObject.get(objectId);
    expect(row).toBeDefined();
    expect(row?.objectName).toBe(STARTRAILS_TARGET_NAME);
    expect(row?.objectType).toBe(STARTRAILS_OBJECT_TYPE);
    expect(row?.description).toBeTruthy();

    const sessions = stmts.getSessions.all(objectId);
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });
});

describe('patchStartrailsObjectMeta — boot-time self-heal', () => {
  it('repairs a stale Star Trails row (objectType Unknown, no description, un-spaced name)', () => {
    const objectId = getStartrailsObjectId();
    // Ensure a row exists, then force it stale via a raw UPDATE -- a prior
    // test in this file may have already created and correctly patched this
    // same deterministic id, and upsertObject's COALESCE only fills NULLs,
    // so it can't simulate "already exists but stale" by itself. This
    // reproduces a row created before this boot-time patch existed and never
    // re-imported since: the generic placeholders resolveCatalogMeta writes
    // for any id it doesn't recognize ('Unknown' type, empty description),
    // and the raw un-spaced name rather than the curated "DWARF Star Trails".
    stmts.upsertObject.run(
      objectId, objectId, 55, new Date().toISOString(), 0, null,
      objectId, objectId, 'Unknown', '', '', null, null, null, null,
    );
    db.prepare(
      `UPDATE libraryObjects SET objectName = ?, objectType = ?, constellation = ?, description = ? WHERE objectId = ?`,
    ).run(objectId, 'Unknown', '', '', objectId);
    const before = stmts.getObject.get(objectId);
    expect(before?.objectName).toBe(objectId);
    expect(before?.objectType).toBe('Unknown');
    expect(before?.description).toBe('');

    // server/lib/library/objects.ts calls this unconditionally, once, at
    // module load (server boot) -- not gated behind any import ever having
    // touched this object -- specifically so a row like the one seeded above
    // gets fixed on the next boot even if this device never syncs again.
    patchStartrailsObjectMeta(objectId);

    const after = stmts.getObject.get(objectId);
    expect(after?.objectName).toBe(STARTRAILS_TARGET_NAME);
    expect(after?.objectType).toBe(STARTRAILS_OBJECT_TYPE);
    expect(after?.constellation).toBe('');
    expect(after?.description).toBeTruthy();
  });
});
