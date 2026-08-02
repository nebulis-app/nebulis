import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-nested-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import os from 'os';
import { runImport, claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import { getLocalSessions, getLocalFiles, deleteLocalSession, moveObservation } from '../../server/lib/library/observations';
import { getLibraryFilesForObject, roleForFile } from '../../server/lib/library/libraryFiles';
import { isDwarfMasterStack } from '../../server/lib/library/importFilter';
import { getObjectLayout, sessionFolderFor, canonicalSessionFolder, listObjectFiles } from '../../server/lib/library/libraryLayout';
import { scanImportFolder } from '../../server/lib/library/folderScan';
import { commitFolderImport } from '../../server/lib/library/import';
import { createProfile, updateSettingsData } from '../../server/lib/telescopes';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

/**
 * The decisive case for nesting, taken verbatim from a real user's library:
 * two captures of C 5 on the SAME observing night at different exposure and
 * gain. Both source folders contain a `stacked.jpg`. Under the flat layout one
 * overwrites the other unless the importer renames; under nesting both survive
 * with the names the Dwarf gave them.
 */
const SESSION_A = 'DWARF_RAW_TELE_C 5_EXP_60_GAIN_60_2026-02-26-21-54-49-673';
const SESSION_B = 'DWARF_RAW_TELE_C 5_EXP_120_GAIN_40_2026-02-26-23-11-44-030';
const SESSION_FILES = ['stacked.jpg', 'stacked_thumbnail.jpg'];

/** "C 5" is Caldwell 5, which the catalog resolves to its canonical id IC 342 —
 *  so that, not "C5", is the library object these imports land in. */
const OBJECT_ID = 'IC342';

let devicePath: string;

function seedDevice(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-dwarf-device-'));
  for (const session of [SESSION_A, SESSION_B]) {
    const dir = path.join(root, 'Astronomy', session);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of SESSION_FILES) fs.writeFileSync(path.join(dir, f), `bytes-of-${session}-${f}`);
    fs.writeFileSync(path.join(dir, 'shotsInfo.json'), '{"target":"C 5"}');
  }
  return root;
}

async function importDevice(
  opts: { archiveAllFiles?: boolean; allTypesOff?: boolean } = {},
): Promise<void> {
  const profile = createProfile({
    name: 'Dwarf Nested Test',
    kind: 'dwarf-3',
    connectionType: 'local',
    localPath: devicePath,
    archiveAllFiles: opts.archiveAllFiles,
    ...(opts.allTypesOff
      ? {
        importJpg: false, importFits: false, importThumbnails: false,
        importSubFrames: false, importVideos: false,
      }
      : {}),
  });
  expect(claimImportLock()).toBe(true);
  try {
    await runImport(undefined, undefined, { telescopeId: profile.id });
  } finally {
    releaseImportLock();
  }
}

function objDir(folder: string = OBJECT_ID): string {
  return path.join(LIBRARY_DIR, folder);
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM librarySessions').run();
  db.prepare('DELETE FROM libraryDeletedSessions').run();
  db.prepare('DELETE FROM telescopeProfiles').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true, importJpg: true, importFits: true, importThumbnails: true });
  devicePath = seedDevice();
});

describe('sessionFolderFor', () => {
  it('mirrors the source folder name verbatim', () => {
    expect(sessionFolderFor(SESSION_A, '2026-02-26', '215449')).toBe(SESSION_A);
  });

  it('synthesizes a folder when the source has none', () => {
    // SeeStar has no per-session directory, so one is built from the session
    // start. The time is part of it for the same reason the Dwarf folder is
    // kept: two sessions can share a night.
    expect(sessionFolderFor(null, '2026-02-26', '215449')).toBe('2026-02-26_21-54-49');
    expect(canonicalSessionFolder('2026-02-26', null)).toBe('2026-02-26_00-00-00');
  });

  it('returns null when there is neither a source folder nor a date', () => {
    expect(sessionFolderFor(null, null, null)).toBeNull();
  });

  it('replaces only filesystem-illegal characters, keeping spaces', () => {
    expect(sessionFolderFor('C 5/EXP:60', '2026-02-26', null)).toBe('C 5_EXP_60');
  });
});

describe('nested import from a real Dwarf layout', () => {
  it('keeps two same-night sessions apart without renaming anything', async () => {
    await importDevice();

    // Both source folders exist under the object, named exactly as the device
    // had them — including the EXP/GAIN a date-named folder would have lost.
    const dirs = fs.readdirSync(objDir()).filter(d => !d.startsWith('.')).sort();
    expect(dirs).toEqual([SESSION_B, SESSION_A].sort());

    // And the file inside each kept its original name.
    for (const session of [SESSION_A, SESSION_B]) {
      expect(fs.existsSync(path.join(objDir(), session, 'stacked.jpg'))).toBe(true);
    }
  });

  it('records rows whose originalName equals the on-disk name', async () => {
    await importDevice();
    const rows = getLibraryFilesForObject(OBJECT_ID);
    const stacked = rows.filter(r => r.fileName === 'stacked.jpg');
    expect(stacked).toHaveLength(2);
    for (const row of stacked) {
      // Nothing was rewritten, so these are the same string.
      expect(row.originalName).toBe('stacked.jpg');
      expect(row.relPath.split('/').length).toBe(3); // C5/<session>/stacked.jpg
    }
  });

  it('marks the object nested', async () => {
    await importDevice();
    expect(getObjectLayout(OBJECT_ID)).toBe('nested');
  });

  it('groups both sessions under the one observing night they share', async () => {
    await importDevice();
    const sessions = getLocalSessions(OBJECT_ID);
    // 21:54 and 23:11 on 2026-02-26 are the same night. Two source folders,
    // one session — which is exactly why the folder cannot be named by date.
    expect(sessions.map(s => s.date)).toEqual(['2026-02-26']);
  });

  it('serves both stacks for that night with distinct paths', async () => {
    await importDevice();
    const files = getLocalFiles(OBJECT_ID, '2026-02-26');
    const stacked = files.filter(f => f.name === 'stacked.jpg');
    expect(stacked).toHaveLength(2);
    // The session directory is carried into the library path, so the two
    // same-named files address distinctly.
    const paths = stacked.map(f => f.path).sort();
    expect(new Set(paths).size).toBe(2);
    expect(paths[0]).toContain('/');
    expect(stacked.every(f => f.sessionFolder !== null)).toBe(true);
  });

  it('is idempotent — a second run adds nothing', async () => {
    await importDevice();
    const before = getLibraryFilesForObject(OBJECT_ID).length;
    await importDevice();
    expect(getLibraryFilesForObject(OBJECT_ID)).toHaveLength(before);
    const dirs = fs.readdirSync(objDir()).filter(d => !d.startsWith('.'));
    expect(dirs).toHaveLength(2);
  });
});

describe('nested deletes and moves', () => {
  it('deleting a session removes its files and prunes the emptied directories', async () => {
    await importDevice();
    deleteLocalSession(OBJECT_ID, '2026-02-26');
    // Both source folders belonged to that night, so both directories go.
    const left = fs.existsSync(objDir())
      ? fs.readdirSync(objDir()).filter(d => !d.startsWith('.'))
      : [];
    expect(left).toEqual([]);
    expect(getLibraryFilesForObject(OBJECT_ID)).toHaveLength(0);
  });

  it('moving an observation carries the session directories to the target', async () => {
    await importDevice();
    const moved = moveObservation(OBJECT_ID, '2026-02-26', 'M42');
    expect(moved.moved).toBeGreaterThan(0);
    // Target adopts the nested shape and keeps the session folders intact.
    expect(getObjectLayout('M42')).toBe('nested');
    const targetDirs = fs.readdirSync(objDir('M42')).filter(d => !d.startsWith('.')).sort();
    expect(targetDirs).toEqual([SESSION_B, SESSION_A].sort());
    expect(fs.existsSync(path.join(objDir('M42'), SESSION_A, 'stacked.jpg'))).toBe(true);
    // Rows followed, still two distinct stacked.jpg.
    expect(getLibraryFilesForObject('M42').filter(r => r.fileName === 'stacked.jpg')).toHaveLength(2);
  });
});

describe('Dwarf master stack (img_stacked_all)', () => {
  it('is imported, unlike the other img_ working files', async () => {
    // img_stacked_all is a 32-bit float RGB integration at sensor resolution and
    // the best output the device produces. A blanket ^img_ reject discarded it
    // from every session; the reference frame and counter map are still refused.
    const dir = path.join(devicePath, 'Astronomy', SESSION_A);
    fs.writeFileSync(path.join(dir, 'img_stacked_all.tif'), 'master-stack-bytes');
    fs.writeFileSync(path.join(dir, 'img_reference.png'), 'reference-frame');
    fs.writeFileSync(path.join(dir, 'img_stacked_counter.png'), 'counter-map');

    await importDevice();

    const names = getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName);
    expect(names).toContain('img_stacked_all.tif');
    expect(names).not.toContain('img_reference.png');
    expect(names).not.toContain('img_stacked_counter.png');
    expect(fs.existsSync(path.join(objDir(), SESSION_A, 'img_stacked_all.tif'))).toBe(true);
  });

  it('is recorded as a stack, not a preview, despite the .tif extension', () => {
    expect(roleForFile('img_stacked_all.tif')).toBe('stacked');
    expect(roleForFile('img_reference.png')).toBe('preview');
  });

  it('matches only the exact stem, so the exception cannot widen', () => {
    expect(isDwarfMasterStack('img_stacked_all.tif')).toBe(true);
    expect(isDwarfMasterStack('IMG_STACKED_ALL.TIF')).toBe(true);
    expect(isDwarfMasterStack('img_stacked_all_v2.tif')).toBe(false);
    expect(isDwarfMasterStack('my_img_stacked_all.tif')).toBe(false);
    expect(isDwarfMasterStack('img_stacked_counter.png')).toBe(false);
  });
});

describe('archive mode, per telescope', () => {
  /** Files Nebulis has no use for, plus one it has no rule for at all. */
  function seedArchivables(): void {
    const dir = path.join(devicePath, 'Astronomy', SESSION_A);
    fs.writeFileSync(path.join(dir, 'img_reference.png'), 'reference-frame');
    fs.writeFileSync(path.join(dir, 'failed_C 5_60s60_Astro_20260226-215500123_31C.fits'), 'rejected');
    fs.writeFileSync(path.join(dir, 'telemetry.dat'), 'device log');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'os junk');
  }

  it('leaves them behind when the telescope has archiving off', async () => {
    seedArchivables();
    await importDevice({ archiveAllFiles: false });
    const names = getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName);
    expect(names).not.toContain('img_reference.png');
    expect(names).not.toContain('telemetry.dat');
  });

  it('keeps them when the telescope has archiving on', async () => {
    // The profile setting has to reach classifyImportFile through runImport's
    // settings merge; this is the end-to-end proof that it does.
    seedArchivables();
    await importDevice({ archiveAllFiles: true });
    const names = getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName);
    expect(names).toContain('img_reference.png');
    expect(names).toContain('telemetry.dat');
  });

  it('overrides every per-type toggle, so nothing is left behind', async () => {
    // The whole promise of the switch: with all five type toggles off, archive
    // mode still brings the sub-frames, previews and thumbnails across.
    seedArchivables();
    const dir = path.join(devicePath, 'Astronomy', SESSION_A);
    fs.writeFileSync(path.join(dir, 'C 5_60s60_Astro_20260226-215600001_31C.fits'), 'a-subframe');

    await importDevice({ archiveAllFiles: true, allTypesOff: true });

    const names = getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName);
    expect(names).toContain('stacked.jpg');            // importJpg: false
    expect(names).toContain('stacked_thumbnail.jpg');  // importThumbnails: false
    expect(names).toContain('C 5_60s60_Astro_20260226-215600001_31C.fits'); // subFrames: false
  });

  it('mirrors a session sub-directory instead of flattening it', async () => {
    // A Dwarf keeps per-frame previews in `Thumbnail/`. Archive mode copies them
    // and preserves the directory, so the library matches the device.
    const thumbDir = path.join(devicePath, 'Astronomy', SESSION_A, 'Thumbnail');
    fs.mkdirSync(thumbDir, { recursive: true });
    fs.writeFileSync(path.join(thumbDir, 'C 5_60s60_Astro_20260226-215500123_31C.jpg'), 'frame-preview');

    await importDevice({ archiveAllFiles: true });

    const rel = getLibraryFilesForObject(OBJECT_ID).map(r => r.relPath);
    expect(rel).toContain(`${OBJECT_ID}/${SESSION_A}/Thumbnail/C 5_60s60_Astro_20260226-215500123_31C.jpg`);
    expect(fs.existsSync(path.join(objDir(), SESSION_A, 'Thumbnail'))).toBe(true);
  });

  it('does not walk the sub-directory when archiving is off', async () => {
    // Listing it on every routine import would add a round trip per session for
    // files the app never uses.
    const thumbDir = path.join(devicePath, 'Astronomy', SESSION_A, 'Thumbnail');
    fs.mkdirSync(thumbDir, { recursive: true });
    fs.writeFileSync(path.join(thumbDir, 'preview.jpg'), 'frame-preview');

    await importDevice({ archiveAllFiles: false });

    expect(getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName)).not.toContain('preview.jpg');
  });

  it('stores an unknown type as role "unknown" so it is never rendered', async () => {
    seedArchivables();
    await importDevice({ archiveAllFiles: true });
    const row = getLibraryFilesForObject(OBJECT_ID).find(r => r.fileName === 'telemetry.dat')!;
    expect(row.role).toBe('unknown');
  });

  it('never archives OS junk', async () => {
    seedArchivables();
    await importDevice({ archiveAllFiles: true });
    const names = getLibraryFilesForObject(OBJECT_ID).map(r => r.fileName);
    expect(names).not.toContain('.DS_Store');
  });
});

describe('folder-import wizard, nested', () => {
  /** A NAS mirror of a Dwarf volume: the real case this wizard exists for. */
  function mirrorTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-mirror-'));
    for (const session of [SESSION_A, SESSION_B]) {
      const dir = path.join(root, session);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stacked.jpg'), `bytes-${session}`);
    }
    return root;
  }

  async function commitMirror(root: string): Promise<void> {
    const scan = scanImportFolder(root, { importJpg: true, importFits: true });
    await commitFolderImport({
      rootPath: root,
      objects: scan.objects.map(o => ({
        folderName: o.folderName,
        targetObjectId: OBJECT_ID,
        targetFolderName: OBJECT_ID,
        sessionMap: {},
      })),
    });
  }

  it('mirrors the source session folders and keeps both same-named stacks', async () => {
    const root = mirrorTree();
    await commitMirror(root);

    const dirs = fs.readdirSync(objDir()).filter(d => !d.startsWith('.')).sort();
    expect(dirs).toEqual([SESSION_B, SESSION_A].sort());
    for (const session of [SESSION_A, SESSION_B]) {
      expect(fs.existsSync(path.join(objDir(), session, 'stacked.jpg'))).toBe(true);
    }
    // Same result the telescope path produces: two files, one shared night.
    expect(getLocalSessions(OBJECT_ID).map(s => s.date)).toEqual(['2026-02-26']);
    expect(getLibraryFilesForObject(OBJECT_ID).filter(r => r.fileName === 'stacked.jpg')).toHaveLength(2);
  });

  it('does not rename, so originalName equals the on-disk name', async () => {
    await commitMirror(mirrorTree());
    for (const row of getLibraryFilesForObject(OBJECT_ID)) {
      expect(row.fileName).toBe(row.originalName);
    }
  });

  it('is idempotent across two commits of the same mirror', async () => {
    const root = mirrorTree();
    await commitMirror(root);
    const before = getLibraryFilesForObject(OBJECT_ID).length;
    await commitMirror(root);
    expect(getLibraryFilesForObject(OBJECT_ID)).toHaveLength(before);
    expect(fs.readdirSync(objDir()).filter(d => !d.startsWith('.'))).toHaveLength(2);
  });
});

describe('listObjectFiles', () => {
  it('returns files at object level for a flat object', () => {
    const dir = path.join(LIBRARY_DIR, 'Flat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
    const out = listObjectFiles(dir, 'flat');
    expect(out).toEqual([{ relPath: 'a.jpg', fileName: 'a.jpg', sessionFolder: null }]);
  });

  it('does not descend into directories for a flat object', () => {
    const dir = path.join(LIBRARY_DIR, 'Flat2');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'a.jpg'), 'x');
    expect(listObjectFiles(dir, 'flat')).toEqual([]);
  });

  it('skips processed/ and dot-dirs when nested', () => {
    const dir = path.join(LIBRARY_DIR, 'Nested');
    fs.mkdirSync(path.join(dir, 'processed'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.thumbs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'S1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'processed', 'p.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '.thumbs', 't.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'S1', 'stacked.jpg'), 'x');
    expect(listObjectFiles(dir, 'nested').map(e => e.relPath)).toEqual(['S1/stacked.jpg']);
  });

  it('still returns a stray file left at the root of a nested object', () => {
    // A partially-migrated object, or something dropped in by hand, must not
    // silently vanish from the library.
    const dir = path.join(LIBRARY_DIR, 'Nested2');
    fs.mkdirSync(path.join(dir, 'S1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'S1', 'a.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'stray.jpg'), 'x');
    const out = listObjectFiles(dir, 'nested');
    expect(out.map(e => e.relPath).sort()).toEqual(['S1/a.jpg', 'stray.jpg']);
    expect(out.find(e => e.relPath === 'stray.jpg')!.sessionFolder).toBeNull();
  });
});

describe('isolation', () => {
  it('runs against its own data dir', () => {
    expect(process.env.DATA_DIR).toBe(TEST_DATA_DIR);
  });
});
