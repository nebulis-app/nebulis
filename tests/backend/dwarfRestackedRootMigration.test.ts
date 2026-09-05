import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors dwarfArchiveScoping.test.ts.
// Its own file (not appended to that one) because migrateRestackedToSharedRootOnce
// is guarded by a module-level once-per-process flag — any earlier isDwarf
// runImport call in a shared file would consume it before this test runs.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-restack-migration-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import {
  ARCHIVE_DIR_NAME,
  RESTACKED_ROOT_DIR_NAME,
  getRestackArchiveDir,
  migrateRestackedToSharedRootOnce,
  isReservedLibraryDir,
} from '../../server/lib/library/archiveFolders';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('archive: RESTACKED shared-root migration', () => {
  it('moves telescope-scoped RESTACKED data from every scope into the shared root, once', async () => {
    // Simulate data left by a version of the app that scoped RESTACKED
    // per-telescope, same as CALI_FRAME/DWARF_DARK still are today.
    const scopeA = path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'telescope-a', RESTACKED_ROOT_DIR_NAME, 'M42');
    const scopeB = path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'telescope-b', RESTACKED_ROOT_DIR_NAME, 'NGC7000');
    fs.mkdirSync(scopeA, { recursive: true });
    fs.mkdirSync(scopeB, { recursive: true });
    fs.writeFileSync(path.join(scopeA, 'shotsInfo.json'), '{"target":"M42"}');
    fs.writeFileSync(path.join(scopeB, 'shotsInfo.json'), '{"target":"C20"}');

    await migrateRestackedToSharedRootOnce();

    expect(fs.existsSync(path.join(getRestackArchiveDir(), 'M42', 'shotsInfo.json'))).toBe(true);
    expect(fs.existsSync(path.join(getRestackArchiveDir(), 'NGC7000', 'shotsInfo.json'))).toBe(true);
    // Emptied out of the old telescope-scoped locations.
    expect(fs.existsSync(path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'telescope-a', RESTACKED_ROOT_DIR_NAME))).toBe(false);
    expect(fs.existsSync(path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'telescope-b', RESTACKED_ROOT_DIR_NAME))).toBe(false);

    // A second call (e.g. a later import run in the same process) is a no-op:
    // nothing left to migrate, and the flag prevents even trying.
    await migrateRestackedToSharedRootOnce();
    expect(fs.readdirSync(path.join(getRestackArchiveDir(), 'M42'))).toEqual(['shotsInfo.json']);
  });

  it('the shared root is excluded from every library-root object-discovery sweep', () => {
    expect(isReservedLibraryDir(RESTACKED_ROOT_DIR_NAME)).toBe(true);
  });
});
