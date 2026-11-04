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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dwarfarchivescope-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import {
  ARCHIVE_DIR_NAME,
  ARCHIVE_UNSCOPED_DIR,
  getArchiveDir,
  listArchivedFolders,
  listArchiveScopes,
} from '../../server/lib/library/archiveFolders';
import { runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('archive: legacy flat-layout migration', () => {
  it('moves a pre-existing flat archived folder into the shared unscoped bucket, once', () => {
    // Simulate data left by a version of the app that predates telescope
    // scoping: a folder sitting directly under _archive/, matching one of the
    // known non-observation folder names.
    const legacyDir = path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'CALI_FRAME');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dark_001.fits'), 'legacy-bytes');

    // Any call into getArchiveDir triggers the lazy, once-per-process migration.
    getArchiveDir();

    const migratedPath = path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, ARCHIVE_UNSCOPED_DIR, 'CALI_FRAME', 'dark_001.fits');
    expect(fs.existsSync(migratedPath)).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);

    const folders = listArchivedFolders(); // no telescopeId → unscoped bucket
    expect(folders.map(f => f.name)).toContain('CALI_FRAME');
  });
});

describe('archive: telescope scoping', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('a live Dwarf sync archives CALI_FRAME/DWARF_DARK under that telescope\'s own scope', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-cal-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'CALI_FRAME'), { recursive: true });
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy', 'DWARF_DARK'), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'CALI_FRAME', 'cal_001.fits'), 'cal-bytes');
    fs.writeFileSync(path.join(deviceRoot, 'Astronomy', 'DWARF_DARK', 'dark_001.fits'), 'dark-bytes');

    const profile = createProfile({
      name: 'Dwarf Calibration Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeNull();

    const folders = listArchivedFolders(profile.id);
    expect(folders.map(f => f.name).sort()).toEqual(['CALI_FRAME', 'DWARF_DARK']);
    expect(fs.existsSync(path.join(getArchiveDir(profile.id), 'CALI_FRAME', 'cal_001.fits'))).toBe(true);
    expect(fs.existsSync(path.join(getArchiveDir(profile.id), 'DWARF_DARK', 'dark_001.fits'))).toBe(true);

    // Never registered as a library object.
    const { stmts } = await import('../../server/lib/library/objects');
    expect(stmts.getObject.get('CALI_FRAME')).toBeUndefined();
    expect(stmts.getObject.get('DWARF_DARK')).toBeUndefined();

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('two telescopes\' calibration data never collide, and both scopes are listed', async () => {
    const makeDevice = (fileContent: string) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-cal-multi-device-'));
      fs.mkdirSync(path.join(root, 'Astronomy', 'CALI_FRAME'), { recursive: true });
      // Same filename, different bytes: the exact clash telescope-scoping exists to prevent.
      fs.writeFileSync(path.join(root, 'Astronomy', 'CALI_FRAME', 'cal_001.fits'), fileContent);
      return root;
    };
    const deviceA = makeDevice('scope-A-bytes');
    const deviceB = makeDevice('scope-B-bytes-longer');

    const profileA = createProfile({ name: 'Dwarf A', kind: 'dwarf-3', connectionType: 'local', localPath: deviceA });
    const profileB = createProfile({ name: 'Dwarf B', kind: 'dwarf-3', connectionType: 'local', localPath: deviceB });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profileA.id });
    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profileB.id });

    const fileA = path.join(getArchiveDir(profileA.id), 'CALI_FRAME', 'cal_001.fits');
    const fileB = path.join(getArchiveDir(profileB.id), 'CALI_FRAME', 'cal_001.fits');
    expect(fs.readFileSync(fileA, 'utf8')).toBe('scope-A-bytes');
    expect(fs.readFileSync(fileB, 'utf8')).toBe('scope-B-bytes-longer');

    const scopes = listArchiveScopes();
    expect(scopes).toContain(profileA.id);
    expect(scopes).toContain(profileB.id);

    fs.rmSync(deviceA, { recursive: true, force: true });
    fs.rmSync(deviceB, { recursive: true, force: true });
  });

  it('a live Dwarf sync archives sibling folders outside Astronomy (e.g. a videos folder)', async () => {
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-video-device-'));
    fs.mkdirSync(path.join(deviceRoot, 'Astronomy'), { recursive: true });
    fs.mkdirSync(path.join(deviceRoot, 'DCIM', 'Video'), { recursive: true });
    fs.writeFileSync(path.join(deviceRoot, 'DCIM', 'Video', 'clip_001.mp4'), 'video-bytes');

    const profile = createProfile({
      name: 'Dwarf Video Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeNull();

    const folders = listArchivedFolders(profile.id);
    expect(folders.map(f => f.name)).toContain('DCIM');
    expect(fs.existsSync(path.join(getArchiveDir(profile.id), 'DCIM', 'Video', 'clip_001.mp4'))).toBe(true);
    // 'Astronomy' itself is the recognized object tree, never re-archived as a sibling folder.
    expect(folders.map(f => f.name)).not.toContain('Astronomy');

    fs.rmSync(deviceRoot, { recursive: true, force: true });
  });

  it('a live Dwarf sync never archives the app\'s own relocated library, even when it shares the device\'s local-mount root', async () => {
    // Reproduces a real incident (Sept 2026): the Nebulis library had been
    // relocated onto the same USB volume the Dwarf itself is mounted at
    // (both under /Volumes/DWARF_3). TEST_DATA_DIR stands in for that shared
    // volume here: LIBRARY_DIR already lives at <TEST_DATA_DIR>/library, so
    // pointing this profile's localPath straight at TEST_DATA_DIR reproduces
    // the overlap without needing a real relocation. Before the fix, the
    // "other device folders" pass swept the library folder in as an
    // unclaimed sibling and archived it into its own _archive dir, which the
    // next sync then rediscovered and archived again one level deeper.
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'Astronomy'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'OtherDeviceJunk'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'OtherDeviceJunk', 'panorama.jpg'), 'junk-bytes');

    const profile = createProfile({
      name: 'Dwarf Overlapping-Library Test',
      kind: 'dwarf-3',
      connectionType: 'local',
      localPath: TEST_DATA_DIR,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });
    expect(getImportStatus().error).toBeNull();

    const folders = listArchivedFolders(profile.id);
    // The library folder itself must never be treated as an archivable
    // "other device folder" ...
    expect(folders.map(f => f.name)).not.toContain('library');
    expect(fs.existsSync(path.join(getArchiveDir(profile.id), 'library'))).toBe(false);
    // ... but a genuine sibling folder the device wrote is still preserved,
    // proving the exclusion is scoped to the library dir specifically and
    // hasn't just disabled this archive pass altogether.
    expect(folders.map(f => f.name)).toContain('OtherDeviceJunk');
    expect(fs.existsSync(path.join(getArchiveDir(profile.id), 'OtherDeviceJunk', 'panorama.jpg'))).toBe(true);
  });
});

describe('archive: self-nesting safety net', () => {
  // Defense in depth, independent of the name-based exclusion tested above:
  // even if some future archive pass forgets to exclude an overlapping
  // folder by name, resolveArchiveDestination must still refuse to copy a
  // source that already lives inside the destination archive dir, rather
  // than creating a nested nth-generation copy.
  it('resolveArchiveDestination refuses to copy a source that is already inside the archive dir', async () => {
    const { resolveArchiveDestination, isAlreadyInsideArchive } = await import('../../server/lib/library/archiveFolders');

    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-self-nest-'));
    const archiveDir = path.join(scratchRoot, '_archive', 'scope-1');

    // A file that already lives inside the archive dir, as if a prior,
    // unguarded pass had copied a folder containing the archive into itself.
    const alreadyArchivedFile = path.join(archiveDir, 'library', 'M31', 'stack.fit');
    fs.mkdirSync(path.dirname(alreadyArchivedFile), { recursive: true });
    fs.writeFileSync(alreadyArchivedFile, 'real-bytes');

    expect(isAlreadyInsideArchive(alreadyArchivedFile, archiveDir)).toBe(true);
    expect(isAlreadyInsideArchive(path.join(scratchRoot, 'sibling', 'file.fit'), archiveDir)).toBe(false);

    // A rescan of that nested copy would ask to archive it again under a
    // longer relPath (exactly what a recursive walk produces). That must be
    // a no-op dedup, never a fresh copy: that's what keeps the nesting from
    // growing on every re-run.
    const { alreadyPresent } = await resolveArchiveDestination(
      archiveDir,
      'library/_archive/scope-1/library/M31/stack.fit',
      11,
      alreadyArchivedFile,
    );
    expect(alreadyPresent).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'library', '_archive'))).toBe(false);

    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });
});
