import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// This suite runs with LIBRARY_DIR set, so it must live in its own file:
// paths.ts reads the env var once at module load. Both DATA_DIR and LIBRARY_DIR
// are pinned before any server module resolves (vi.hoisted runs first).
const { TEST_DATA_DIR, PINNED_LIBRARY_DIR } = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dataDir = _fs.mkdtempSync(_path.join(_root, 'nebulis-libpin-data-'));
  // Deliberately NOT created on disk: the override must be treated as available
  // even before the directory exists.
  const libDir = _path.join(_root, `nebulis-libpin-lib-${Date.now()}`);
  _process.env.DATA_DIR = dataDir;
  _process.env.LIBRARY_DIR = libDir;
  return { TEST_DATA_DIR: dataDir, PINNED_LIBRARY_DIR: libDir };
});

import {
  getLibraryDir,
  getDefaultLibraryDir,
  isDefaultLocation,
  isNetworkLocation,
  isLibraryPinned,
  isLibraryAvailable,
  setLibraryPath,
  setNetworkLibraryConfig,
  getLibraryLocationInfo,
  reconcilePinnedLibraryConfig,
} from '../../server/lib/libraryPath';
import { startMigration } from '../../server/lib/libraryMigration';
import db from '../../server/lib/db';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(PINNED_LIBRARY_DIR, { recursive: true, force: true });
  delete process.env.LIBRARY_DIR;
});

beforeEach(async () => {
  await setLibraryPath('');
});

describe('LIBRARY_DIR override', () => {
  it('reports pinned and resolves to the override path', () => {
    expect(isLibraryPinned()).toBe(true);
    expect(getLibraryDir()).toBe(PINNED_LIBRARY_DIR);
    expect(getDefaultLibraryDir()).toBe(PINNED_LIBRARY_DIR);
    expect(isDefaultLocation()).toBe(true);
    expect(isNetworkLocation()).toBe(false);
  });

  it('is available even though the directory does not exist and has no marker', async () => {
    expect(fs.existsSync(PINNED_LIBRARY_DIR)).toBe(false);
    expect(await isLibraryAvailable()).toBe(true);
  });

  it('wins over a stored local relocation', async () => {
    await setLibraryPath(path.join(TEST_DATA_DIR, 'somewhere-else'));
    expect(getLibraryDir()).toBe(PINNED_LIBRARY_DIR);
    expect(isDefaultLocation()).toBe(true);
    expect(await isLibraryAvailable()).toBe(true);
  });

  it('wins over a stored network configuration', () => {
    setNetworkLibraryConfig({
      host: 'nas.local', share: 'Photos', domain: '', username: '', password: '', subpath: 'Nebulis',
    });
    expect(getLibraryDir()).toBe(PINNED_LIBRARY_DIR);
    expect(isNetworkLocation()).toBe(false);
  });

  it('exposes pinned + isDefault in the location info', async () => {
    const info = await getLibraryLocationInfo();
    expect(info.pinned).toBe(true);
    expect(info.isDefault).toBe(true);
    expect(info.available).toBe(true);
    expect(info.path).toBe(PINNED_LIBRARY_DIR);
    expect(info.locationType).toBe('local');
  });

  it('reconcilePinnedLibraryConfig clears a stale stored path', async () => {
    await setLibraryPath(path.join(TEST_DATA_DIR, 'D-drive-path'));
    reconcilePinnedLibraryConfig();
    const row = db
      .prepare<[], { libraryPath: string; libraryLocationType: string }>(
        'SELECT libraryPath, libraryLocationType FROM appSettings WHERE id = 1',
      )
      .get();
    expect(row?.libraryPath).toBe('');
    expect(row?.libraryLocationType).toBe('local');
  });

  it('reconcilePinnedLibraryConfig is a no-op when nothing is stored', () => {
    expect(() => reconcilePinnedLibraryConfig()).not.toThrow();
    expect(() => reconcilePinnedLibraryConfig()).not.toThrow();
  });

  it('refuses to start a migration', () => {
    expect(() => startMigration(path.join(TEST_DATA_DIR, 'new-home'))).toThrow(/LIBRARY_DIR/);
  });
});
