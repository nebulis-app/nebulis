import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Scratch dir nests under <repo>/.test-tmp (gitignored, wiped by
// tests/globalSetup.ts) so a crashed run never litters the repo root.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-migrate-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { startMigration, getMigrationStatus } from '../../server/lib/libraryMigration';
import {
  getLibraryDir, getDefaultLibraryDir, setLibraryPath, isLibraryAvailable, readMarker, getLibraryId, writeMarker,
  canRemoveLibraryTree,
} from '../../server/lib/libraryPath';
import { isLibraryMigrating } from '../../server/lib/libraryMaintenance';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function waitForMigration(timeoutMs = 5000): Promise<ReturnType<typeof getMigrationStatus>> {
  const start = Date.now();
  for (;;) {
    const s = getMigrationStatus();
    if (s.phase === 'complete' || s.phase === 'error') return s;
    if (Date.now() - start > timeoutMs) throw new Error(`migration timed out in phase ${s.phase}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

function seedLibrary(): { file: string; content: string } {
  const lib = getDefaultLibraryDir();
  fs.mkdirSync(path.join(lib, 'M31'), { recursive: true });
  const file = path.join(lib, 'M31', 'stack.jpg');
  const content = 'fake-image-bytes';
  fs.writeFileSync(file, content);
  return { file, content };
}

beforeEach(async () => {
  await setLibraryPath('');
  fs.rmSync(getDefaultLibraryDir(), { recursive: true, force: true });
});

describe('library migration', () => {
  it('copies files to the target, verifies, writes the marker, and flips the path', async () => {
    const { content } = seedLibrary();
    const target = path.join(TEST_DATA_DIR, 'ext-drive', 'Nebulis');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    startMigration(target);
    const result = await waitForMigration();

    expect(result.phase).toBe('complete');
    expect(result.previousPath).toBe(path.join(TEST_DATA_DIR, 'library'));
    // Copied content present at the new location
    expect(fs.readFileSync(path.join(target, 'M31', 'stack.jpg'), 'utf8')).toBe(content);
    // Marker written and matches our library id
    expect(readMarker(target)?.libraryId).toBe(getLibraryId());
    // Path flipped and reachable
    expect(getLibraryDir()).toBe(target);
    expect(await isLibraryAvailable()).toBe(true);
  });

  it('never deletes or modifies the source', async () => {
    const { file, content } = seedLibrary();
    const target = path.join(TEST_DATA_DIR, 'ext-drive2', 'Nebulis');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    startMigration(target);
    await waitForMigration();

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });

  it('clears the migrating flag when finished', async () => {
    seedLibrary();
    const target = path.join(TEST_DATA_DIR, 'ext-drive3', 'Nebulis');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    startMigration(target);
    await waitForMigration();

    expect(isLibraryMigrating()).toBe(false);
  });

  it('refuses a target that already holds other files', async () => {
    seedLibrary();
    const target = path.join(TEST_DATA_DIR, 'occupied');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'someone-elses.txt'), 'data');

    startMigration(target);
    const result = await waitForMigration();

    expect(result.phase).toBe('error');
    expect(getLibraryDir()).toBe(getDefaultLibraryDir()); // path not flipped
  });

  it('refuses to migrate into the current library', async () => {
    seedLibrary();
    const inside = path.join(getDefaultLibraryDir(), 'sub');

    startMigration(inside);
    const result = await waitForMigration();

    expect(result.phase).toBe('error');
  });

  it('refuses to create a library inside another library, which is how an empty second one gets made', async () => {
    seedLibrary();
    const other = path.join(TEST_DATA_DIR, 'drive', 'Nebulis');
    fs.mkdirSync(other, { recursive: true });
    writeMarker(other, 'some-other-id');

    startMigration(path.join(other, 'Nebulis'));
    const result = await waitForMigration();

    expect(result.phase).toBe('error');
    expect(result.error).toMatch(/already a Nebulis library/);
    expect(fs.existsSync(path.join(other, 'Nebulis'))).toBe(false);
  });

  it('points at "use an existing library" when the chosen folder is a library holding the current one', async () => {
    const outer = path.join(TEST_DATA_DIR, 'drive2', 'Nebulis');
    const inner = path.join(outer, 'Nebulis');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'a.txt'), 'x');
    writeMarker(outer, 'real-library-id');
    await setLibraryPath(inner);
    writeMarker(inner, getLibraryId());

    startMigration(outer);
    const result = await waitForMigration();

    expect(result.phase).toBe('error');
    expect(result.error).toMatch(/Use an existing library/);
  });

  it('rejects a second migration while one is active (single-flight)', async () => {
    seedLibrary();
    const target = path.join(TEST_DATA_DIR, 'ext-drive4', 'Nebulis');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    startMigration(target);
    // Immediately attempt another before the first completes.
    expect(() => startMigration(path.join(TEST_DATA_DIR, 'other'))).toThrow();
    // Let the first finish so it doesn't bleed into the next test.
    await waitForMigration();
  });

  it('handles a missing source as an empty move (onboarding case)', async () => {
    // No seedLibrary(): the default library dir does not exist.
    const target = path.join(TEST_DATA_DIR, 'fresh-drive', 'Nebulis');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    startMigration(target);
    const result = await waitForMigration();

    expect(result.phase).toBe('complete');
    expect(getLibraryDir()).toBe(target);
    expect(readMarker(target)?.libraryId).toBe(getLibraryId());
  });

  describe('adopting an existing library', () => {
    it('points at a populated folder without copying, and rewrites a foreign marker', async () => {
      const backup = path.join(TEST_DATA_DIR, 'backup-drive', 'Nebulis');
      fs.mkdirSync(path.join(backup, 'M31'), { recursive: true });
      fs.writeFileSync(path.join(backup, 'M31', 'stack.jpg'), 'backup-bytes');
      fs.writeFileSync(path.join(backup, '.nebulis-library.json'), JSON.stringify({ libraryId: 'old-install' }));

      startMigration(backup, undefined, { adopt: true });
      const result = await waitForMigration();

      expect(result.phase).toBe('complete');
      expect(result.previousPath).toBeNull();
      expect(getLibraryDir()).toBe(backup);
      expect(readMarker(backup)?.libraryId).toBe(getLibraryId());
      expect(await isLibraryAvailable()).toBe(true);
      expect(fs.readFileSync(path.join(backup, 'M31', 'stack.jpg'), 'utf8')).toBe('backup-bytes');
    });

    it('works when the current library folder no longer exists', async () => {
      const backup = path.join(TEST_DATA_DIR, 'backup-drive-gone-source');
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, 'a.fits'), 'x');
      await setLibraryPath(path.join(TEST_DATA_DIR, 'deleted-drive'));

      startMigration(backup, undefined, { adopt: true });

      expect((await waitForMigration()).phase).toBe('complete');
      expect(getLibraryDir()).toBe(backup);
    });

    it('marks a folder that had no marker as adopted, so a reset will not delete it', async () => {
      const pictures = path.join(TEST_DATA_DIR, 'Pictures');
      fs.mkdirSync(pictures, { recursive: true });
      fs.writeFileSync(path.join(pictures, 'holiday.jpg'), 'not-astro');

      startMigration(pictures, undefined, { adopt: true });
      expect((await waitForMigration()).phase).toBe('complete');

      expect(readMarker(pictures)?.adoptedUnverified).toBe(true);
      const verdict = canRemoveLibraryTree(pictures, []);
      expect(verdict.ok).toBe(false);
    });

    it('does not mark a folder that already carried a Nebulis marker', async () => {
      const backup = path.join(TEST_DATA_DIR, 'real-backup');
      fs.mkdirSync(path.join(backup, 'M31'), { recursive: true });
      fs.writeFileSync(path.join(backup, 'M31', 'a.fits'), 'x');
      fs.writeFileSync(path.join(backup, '.nebulis-library.json'), JSON.stringify({ libraryId: 'old-install' }));

      startMigration(backup, undefined, { adopt: true });
      expect((await waitForMigration()).phase).toBe('complete');

      expect(readMarker(backup)?.adoptedUnverified).toBeUndefined();
      expect(canRemoveLibraryTree(backup, [])).toEqual({ ok: true });
    });

    it('refuses an empty folder', async () => {
      const empty = path.join(TEST_DATA_DIR, 'empty-adopt');
      fs.mkdirSync(empty, { recursive: true });

      startMigration(empty, undefined, { adopt: true });
      const result = await waitForMigration();

      expect(result.phase).toBe('error');
      expect(getLibraryDir()).toBe(getDefaultLibraryDir());
    });

    it('refuses a folder that does not exist', async () => {
      startMigration(path.join(TEST_DATA_DIR, 'nope'), undefined, { adopt: true });

      expect((await waitForMigration()).phase).toBe('error');
    });
  });
});

describe('canRemoveLibraryTree', () => {
  it('refuses a filesystem root, a drive root, and any folder holding the home or data folder', () => {
    expect(canRemoveLibraryTree(path.parse(process.cwd()).root, []).ok).toBe(false);
    expect(canRemoveLibraryTree('/Volumes/Backup', []).ok).toBe(false);
    expect(canRemoveLibraryTree('/media/pi/Backup', []).ok).toBe(false);
    expect(canRemoveLibraryTree('/Users/someone', ['/Users/someone']).ok).toBe(false);
    expect(canRemoveLibraryTree('/Users', ['/Users/someone']).ok).toBe(false);
  });

  it('allows an ordinary library folder', () => {
    expect(canRemoveLibraryTree('/Volumes/Backup/Nebulis', ['/Users/someone', '/var/nebulis']).ok).toBe(true);
  });
});
