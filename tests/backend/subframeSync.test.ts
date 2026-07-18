import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-subframesync-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { syncSessionSubFrames, claimImportLock } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { createProfile } from '../../server/lib/telescopes';
import { stmts } from '../../server/lib/library/objects';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// syncSessionSubFrames previously persisted its whole in-memory index snapshot
// via saveIndex(index, profile.id) — which stamps every untagged session
// library-wide with the syncing telescope and claims primaryTelescopeId for
// every unclaimed object, not just the one being synced. These tests cover
// the per-object-scoped replacement (import.ts:1053) and its canonical-id
// resolution.
describe('syncSessionSubFrames — scoped writes', () => {
  beforeAll(() => {
    // Keep enrichment/weather fully offline + fast.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  });

  it('does not stamp or claim an object untouched by this sync', async () => {
    // Object B: pre-existing library object with an untagged session, wholly
    // unrelated to the sync below.
    stmts.upsertObject.run(
      'M42', 'M42', 1, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    stmts.addSession.run('M42', '2026-05-01');

    // Object A: a device exposing a _sub companion folder for NGC7293's
    // 2026-06-21 session (kind 'other' -> walker basePath '', so the sub
    // folder sits directly at localPath/NGC7293_sub).
    const deviceRoot = tmpDir('subsync-device-');
    fs.mkdirSync(path.join(deviceRoot, 'NGC7293_sub'));
    fs.writeFileSync(
      path.join(deviceRoot, 'NGC7293_sub', 'Light_NGC7293_10.0s_IRCUT_20260621-120000.fit'),
      'sub1',
    );

    const profile = createProfile({
      name: 'Test SeeStar (local)',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await syncSessionSubFrames('NGC7293', '2026-06-21', { telescopeId: profile.id });

    // Object A (the one synced) got the sub-frame and was stamped.
    const sessionA = stmts.getSession.get('NGC7293', '2026-06-21');
    expect(sessionA?.telescopeId).toBe(profile.id);
    const objA = stmts.getObject.get('NGC7293');
    expect(objA?.primaryTelescopeId).toBe(profile.id);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'NGC7293', 'Light_NGC7293_10.0s_IRCUT_20260621-120000.fit'))).toBe(true);

    // Object B — never touched by this run — must stay untagged and unclaimed.
    const sessionB = stmts.getSession.get('M42', '2026-05-01');
    expect(sessionB?.telescopeId).toBeNull();
    const objB = stmts.getObject.get('M42');
    expect(objB?.primaryTelescopeId).toBeNull();
  });

  it('resolves an alias objectId to the existing canonical library folder', async () => {
    // Pre-seed the canonical object with an existing library folder — mirrors
    // an object first imported under its canonical NGC id.
    fs.mkdirSync(path.join(LIBRARY_DIR, 'NGC7293'), { recursive: true });
    stmts.upsertObject.run(
      'NGC7293', 'NGC7293', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    const deviceRoot = tmpDir('subsync-alias-device-');
    fs.mkdirSync(path.join(deviceRoot, 'NGC7293_sub'));
    fs.writeFileSync(
      path.join(deviceRoot, 'NGC7293_sub', 'Light_NGC7293_10.0s_IRCUT_20260621-120000.fit'),
      'sub1',
    );

    const profile = createProfile({
      name: 'Test SeeStar (local) 2',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    // Caller passes the Caldwell alias "C63" — must land in the pre-existing
    // "NGC7293" library folder, not a brand-new "C63" one.
    await syncSessionSubFrames('C63', '2026-06-21', { telescopeId: profile.id });

    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C63'))).toBe(false);
    const files = fs.readdirSync(path.join(LIBRARY_DIR, 'NGC7293'));
    expect(files).toContain('Light_NGC7293_10.0s_IRCUT_20260621-120000.fit');
  });
});
