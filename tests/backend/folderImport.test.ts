import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors libraryImport.test.ts.
// Nests under <repo>/.test-tmp (gitignored, wiped by tests/globalSetup.ts) so a
// crashed run never litters the repo root.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-folderimport-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { scanImportFolder } from '../../server/lib/library/folderScan';
import { commitFolderImport, runImport, claimImportLock, getImportStatus } from '../../server/lib/library/import';
import { getLocalSessions } from '../../server/lib/library/observations';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { createProfile, updateSettingsData } from '../../server/lib/telescopes';
import { parseFilename, sessionNightFor } from '../../server/lib/telescopeFiles';
import { stmts } from '../../server/lib/library/objects';
import { getLibraryFilesForObject, sessionDateForRow } from '../../server/lib/library/libraryFiles';
import { ARCHIVE_DIR_NAME, listArchivedFolders } from '../../server/lib/library/archiveFolders';

/**
 * Every file inside an object folder, at any depth, as basenames.
 *
 * Objects created by the wizard are now nested (one directory per session), so
 * a flat readdir would report an object as empty. These assertions are about
 * *which files landed*, not where in the object folder they sit.
 */
function objectFileNames(objDir: string): string[] {
  const walk = (dir: string): string[] => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.flatMap(e =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]);
  };
  return walk(objDir).filter(n => !n.startsWith('.'));
}

/** Build a minimal FITS header buffer with the given cards. */
function fitsBuffer(cards: Record<string, string>): Buffer {
  const lines: string[] = [];
  const card = (key: string, value: string) =>
    (`${key.padEnd(8)}= '${value}'`).padEnd(80).slice(0, 80);
  lines.push(`${'SIMPLE'.padEnd(8)}=                    T`.padEnd(80).slice(0, 80));
  for (const [k, v] of Object.entries(cards)) lines.push(card(k, v));
  lines.push('END'.padEnd(80));
  const body = lines.join('');
  const buf = Buffer.alloc(2880, ' ');
  buf.write(body, 0, 'ascii');
  return buf;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── Scan + commit integration ───────────────────────────────────────────────

describe('scan + commit', () => {
  beforeAll(() => {
    // Keep enrichment/weather (which run after commit) fully offline + fast.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    // Guard against a prior test leaking the toggle off.
    updateSettingsData({ groupObservingNights: true });
  });

  function makeSourceTree(): string {
    const root = tmpDir('src-lib-');
    // M42: one filename-dated JPG + one undated FITS with DATE-OBS on the next day.
    fs.mkdirSync(path.join(root, 'M42'));
    fs.writeFileSync(
      path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg'),
      'jpg',
    );
    fs.writeFileSync(
      path.join(root, 'M42', 'light_001.fits'),
      fitsBuffer({ 'DATE-OBS': '2024-01-16T01:00:00' }),
    );
    // NGC7000: a FITS with no date card, under a date-named subfolder.
    fs.mkdirSync(path.join(root, 'NGC7000', '2023-09-10'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'NGC7000', '2023-09-10', 'frame.fits'),
      fitsBuffer({ OBJECT: 'NGC7000' }),
    );
    return root;
  }

  const settings = { importFits: true, importJpg: true };

  /** A replicated Dwarf tree: one real session folder plus the non-observation
   *  folders that sit next to it on the volume. */
  function makeDwarfVolumeTree(): string {
    const root = tmpDir('src-dwarf-vol-');
    const session = 'DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345';
    fs.mkdirSync(path.join(root, session));
    // A rolling-stack preview (imported by default) plus a numbered sub-frame
    // (gated behind importSubFrames). Both undated in their own names, so the
    // session date comes from the folder name.
    fs.writeFileSync(path.join(root, session, 'stacked.jpg'), 'jpg');
    fs.writeFileSync(
      path.join(root, session, '001-DWARF3_M42_2024-10-15_21-05-30-345.fits'),
      fitsBuffer({ OBJECT: 'M42' }),
    );
    // Calibration frames, restacks, star trails, and daytime captures.
    for (const dir of ['CALI_FRAME', 'DWARF_DARK', 'RESTACKED', 'STARTRAILS', 'Normal_Photos', 'Panoramas']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'dark_001.fits'), fitsBuffer({ 'DATE-OBS': '2024-10-15T21:00:00' }));
    }
    return root;
  }

  it('never turns CALI_FRAME/DWARF_DARK/RESTACKED into library objects', () => {
    // Regression: isObjectFolder accepts any non-dot, non-_sub directory, so a
    // replicated Dwarf tree produced objects literally named "CALI_FRAME" and
    // imported darks as if they were light frames of an object by that name.
    const root = makeDwarfVolumeTree();
    const result = scanImportFolder(root, settings);

    expect(result.objects.map(o => o.folderName)).toEqual(['M42']);
    for (const name of ['CALI_FRAME', 'DWARF_DARK', 'RESTACKED', 'STARTRAILS', 'Normal_Photos', 'Panoramas']) {
      expect(result.objects.map(o => o.folderName)).not.toContain(name);
    }
  });

  it('reports excluded folders so the user is told rather than left guessing', () => {
    const root = makeDwarfVolumeTree();
    const result = scanImportFolder(root, settings);

    const skip = result.skipped.find(s => s.reason === 'non-observation-folder');
    expect(skip).toBeDefined();
    // Counted per folder, not per file.
    expect(skip!.count).toBe(6);
    expect(skip!.label).toMatch(/calibration/i);
  });

  it('names the excluded folders, not just how many there were', () => {
    // A count on its own reads as files going missing. The user knows which
    // folders they pointed us at, so naming them turns a silent exclusion into
    // an explained decision.
    const root = makeDwarfVolumeTree();
    const result = scanImportFolder(root, settings);

    expect(result.excludedFolders).toEqual([
      'CALI_FRAME', 'DWARF_DARK', 'Normal_Photos', 'Panoramas', 'RESTACKED', 'STARTRAILS',
    ]);
    const skip = result.skipped.find(s => s.reason === 'non-observation-folder');
    expect(result.excludedFolders.length).toBe(skip!.count);
  });

  it('commit does not import from an excluded folder even if the plan names it', () => {
    // The plan is user-editable and arrives over the wire, so commit must not
    // trust it to have excluded these. collectObjectSources drops them for both
    // phases, which is what keeps scan and commit in agreement.
    const root = makeDwarfVolumeTree();
    return commitFolderImport({
      rootPath: root,
      importFits: true,
      objects: [
        {
          folderName: 'CALI_FRAME',
          targetObjectId: 'CALI_FRAME',
          targetFolderName: 'CALI_FRAME',
          sessionMap: { '2024-10-15': '2024-10-15' },
        },
      ],
    }).then(() => {
      expect(fs.existsSync(path.join(LIBRARY_DIR, 'CALI_FRAME'))).toBe(false);
      expect(getLocalSessions('CALI_FRAME')).toEqual([]);
    });
  });

  describe('archive mode at the folder level', () => {
    // classifyImportFile promises archive mode keeps EVERYTHING the device
    // holds. Folder exclusion ran upstream of every file-level setting, so
    // "archive everything" silently still dropped calibration frames and
    // restacks: the product stated something untrue.
    const archiveOf = (folder: string) =>
      path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, folder, 'dark_001.fits');

    it('keeps the excluded folders as files when archive mode is on', async () => {
      const root = makeDwarfVolumeTree();
      await commitFolderImport({
        rootPath: root,
        importFits: true,
        archiveAllFiles: true,
        objects: [{
          folderName: 'M42', targetObjectId: 'ARCHIVEOBJ', targetFolderName: 'ARCHIVEOBJ',
          sessionMap: { '2024-10-15': '2024-10-15' },
        }],
      });

      for (const folder of ['CALI_FRAME', 'DWARF_DARK', 'RESTACKED', 'STARTRAILS']) {
        expect(fs.existsSync(archiveOf(folder))).toBe(true);
      }
    });

    it('does not turn archived folders into library objects', async () => {
      // The whole trade: completeness is a claim about bytes on disk, not about
      // the object model. Object-hood is what would drag in enrichment retries,
      // trail detection and inflated counts on data that is not an observation.
      const root = makeDwarfVolumeTree();
      await commitFolderImport({
        rootPath: root,
        importFits: true,
        archiveAllFiles: true,
        objects: [{
          folderName: 'M42', targetObjectId: 'ARCHIVEOBJ', targetFolderName: 'ARCHIVEOBJ',
          sessionMap: { '2024-10-15': '2024-10-15' },
        }],
      });

      for (const folder of ['CALI_FRAME', 'DWARF_DARK', 'RESTACKED', 'STARTRAILS']) {
        expect(fs.existsSync(path.join(LIBRARY_DIR, folder))).toBe(false);
        expect(getLocalSessions(folder)).toEqual([]);
      }
    });

    it('archives nothing when archive mode is off', async () => {
      const root = makeDwarfVolumeTree();
      await commitFolderImport({
        rootPath: root,
        importFits: true,
        objects: [{
          folderName: 'M42', targetObjectId: 'ARCHIVEOBJ', targetFolderName: 'ARCHIVEOBJ',
          sessionMap: { '2024-10-15': '2024-10-15' },
        }],
      });
      expect(fs.existsSync(path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME))).toBe(false);
    });

    it('does not duplicate the archive when the same folder is imported twice', async () => {
      const root = makeDwarfVolumeTree();
      const plan = {
        rootPath: root,
        importFits: true,
        archiveAllFiles: true,
        objects: [{
          folderName: 'M42', targetObjectId: 'ARCHIVEOBJ', targetFolderName: 'ARCHIVEOBJ',
          sessionMap: { '2024-10-15': '2024-10-15' },
        }],
      };
      await commitFolderImport(plan);
      await commitFolderImport(plan);

      const dir = path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'CALI_FRAME');
      expect(fs.readdirSync(dir)).toEqual(['dark_001.fits']);
    });

    it('stops reporting the folders as skipped once archive mode is on', () => {
      // Saying "6 folders that hold no observations will not be imported" while
      // about to copy all six of them tells the user the opposite of the truth.
      const root = makeDwarfVolumeTree();
      const result = scanImportFolder(root, { ...settings, archiveAllFiles: true });

      expect(result.skipped.find(s => s.reason === 'non-observation-folder')).toBeUndefined();
      // Still named, so the wizard can say they are being archived instead.
      expect(result.excludedFolders).toContain('CALI_FRAME');
    });

    it('lists the archive as a plain directory listing', async () => {
      const root = makeDwarfVolumeTree();
      await commitFolderImport({
        rootPath: root,
        importFits: true,
        archiveAllFiles: true,
        objects: [{
          folderName: 'M42', targetObjectId: 'ARCHIVEOBJ', targetFolderName: 'ARCHIVEOBJ',
          sessionMap: { '2024-10-15': '2024-10-15' },
        }],
      });

      const folders = listArchivedFolders();
      expect(folders.map(f => f.name)).toEqual([
        'CALI_FRAME', 'DWARF_DARK', 'Normal_Photos', 'Panoramas', 'RESTACKED', 'STARTRAILS',
      ]);
      const cali = folders.find(f => f.name === 'CALI_FRAME')!;
      expect(cali.fileCount).toBe(1);
      expect(cali.bytes).toBeGreaterThan(0);
      // The path is what lets the user point Siril or PixInsight at the frames.
      expect(cali.path).toBe(path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'CALI_FRAME'));
    });
  });

  it('scans into objects and derived sessions without copying anything', () => {
    const root = makeSourceTree();
    const result = scanImportFolder(root, settings);

    expect(result.objects.map(o => o.folderName).sort()).toEqual(['M42', 'NGC7000']);
    const m42 = result.objects.find(o => o.folderName === 'M42')!;
    // The JPG (20240115-220000) and the FITS (DATE-OBS 2024-01-16T01:00:00) are
    // one continuous session that crosses local midnight: the FITS capture at
    // 01:00 rolls back to the observing night of 2024-01-15, merging with the
    // JPG instead of showing as two split sessions.
    expect(m42.sessions.map(s => s.date)).toEqual(['2024-01-15']);
    expect(m42.sessions[0].fileCount).toBe(2);
    expect(m42.catalogMatch?.objectId).toBe('M42');

    const ngc = result.objects.find(o => o.folderName === 'NGC7000')!;
    expect(ngc.sessions.map(s => s.date)).toEqual(['2023-09-10']);
    expect(ngc.sessions[0].source).toBe('folder');

    // Dry run: nothing written to the library.
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M42'))).toBe(false);
  });

  it('merges the _sub companion when the object folder splits to a single target', () => {
    // The stacked files all parse to the same target as their own folder, which
    // sends the folder down the per-target split path. That path used to skip
    // the _sub merge entirely, so every sub-frame was silently dropped.
    const root = tmpDir('sub-split-');
    fs.mkdirSync(path.join(root, 'M 27'));
    fs.writeFileSync(
      path.join(root, 'M 27', 'Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:16' }),
    );
    fs.mkdirSync(path.join(root, 'M 27_sub'));
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(root, 'M 27_sub', `Light_M 27_10.0s_IRCUT_20250930-21382${i}.fit`),
        fitsBuffer({ 'DATE-OBS': `2025-09-30T21:38:2${i}` }),
      );
    }

    const result = scanImportFolder(root, { ...settings, importSubFrames: true });

    expect(result.objects.map(o => o.folderName)).toEqual(['M 27']);
    const m27 = result.objects.find(o => o.folderName === 'M 27')!;
    // 1 stacked + 3 sub-frames, not the 1 stacked the split path used to return.
    expect(m27.sessions.reduce((n, s) => n + s.fileCount, 0)).toBe(4);
  });

  it('leaves the _sub companion out when sub-frames are disabled', () => {
    const root = tmpDir('sub-split-off-');
    fs.mkdirSync(path.join(root, 'M 27'));
    fs.writeFileSync(
      path.join(root, 'M 27', 'Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:16' }),
    );
    fs.mkdirSync(path.join(root, 'M 27_sub'));
    fs.writeFileSync(
      path.join(root, 'M 27_sub', 'Light_M 27_10.0s_IRCUT_20250930-213820.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:20' }),
    );

    const result = scanImportFolder(root, { ...settings, importSubFrames: false });

    const m27 = result.objects.find(o => o.folderName === 'M 27')!;
    expect(m27.sessions.reduce((n, s) => n + s.fileCount, 0)).toBe(1);
  });

  it('routes each sub-frame to its own target when one _sub serves several', () => {
    const root = tmpDir('sub-multi-');
    fs.mkdirSync(path.join(root, 'Night1'));
    for (const t of ['M 27', 'M 31']) {
      fs.writeFileSync(
        path.join(root, 'Night1', `Stacked_30_${t}_10.0s_IRCUT_20250930-213816.fit`),
        fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:16' }),
      );
    }
    fs.mkdirSync(path.join(root, 'Night1_sub'));
    for (const t of ['M 27', 'M 31']) {
      fs.writeFileSync(
        path.join(root, 'Night1_sub', `Light_${t}_10.0s_IRCUT_20250930-213820.fit`),
        fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:20' }),
      );
    }

    const result = scanImportFolder(root, { ...settings, importSubFrames: true });

    expect(result.objects.map(o => o.folderName).sort()).toEqual(['M 27', 'M 31']);
    for (const o of result.objects) {
      // Each object gets its own stacked frame plus its own sub-frame, never
      // the other target's.
      expect(o.sessions.reduce((n, s) => n + s.fileCount, 0)).toBe(2);
    }
  });

  it('keeps nested session folders when every file names one target', () => {
    // A single top-level target used to force the folder down the split path,
    // which pinned it to top-level files only and dropped nested sessions.
    const root = tmpDir('nested-');
    fs.mkdirSync(path.join(root, 'M 27'));
    fs.writeFileSync(
      path.join(root, 'M 27', 'Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:16' }),
    );
    fs.mkdirSync(path.join(root, 'M 27', '2025-10-01'));
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(root, 'M 27', '2025-10-01', `Light_M 27_10.0s_IRCUT_20251001-21382${i}.fit`),
        fitsBuffer({ 'DATE-OBS': `2025-10-01T21:38:2${i}` }),
      );
    }

    const result = scanImportFolder(root, { ...settings, importSubFrames: true });

    const m27 = result.objects.find(o => o.folderName === 'M 27')!;
    expect(m27.sessions.reduce((n, s) => n + s.fileCount, 0)).toBe(4);
  });

  it('imports a _sub folder that has no sibling object folder', () => {
    // Picking only the sub-frames folder is a normal thing to do. It used to
    // scan as zero objects, because _sub dirs were reachable only as the
    // companion of an object folder that here does not exist.
    const root = tmpDir('orphan-sub-');
    fs.mkdirSync(path.join(root, 'M 27_sub'));
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(root, 'M 27_sub', `Light_M 27_10.0s_IRCUT_20250930-21382${i}.fit`),
        fitsBuffer({ 'DATE-OBS': `2025-09-30T21:38:2${i}` }),
      );
    }

    const result = scanImportFolder(root, { ...settings, importSubFrames: true });

    expect(result.objects.map(o => o.folderName)).toEqual(['M 27']);
    expect(result.totals.files).toBe(3);
  });

  it('renames a folder to its parsed target without losing the _sub companion', () => {
    const root = tmpDir('rename-');
    fs.mkdirSync(path.join(root, 'session1'));
    fs.writeFileSync(
      path.join(root, 'session1', 'Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:16' }),
    );
    fs.mkdirSync(path.join(root, 'session1_sub'));
    fs.writeFileSync(
      path.join(root, 'session1_sub', 'Light_M 27_10.0s_IRCUT_20250930-213820.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:20' }),
    );

    const result = scanImportFolder(root, { ...settings, importSubFrames: true });

    expect(result.objects.map(o => o.folderName)).toEqual(['M 27']);
    expect(result.totals.files).toBe(2);
  });

  it('reports skipped files and why, instead of silently shrinking the count', () => {
    const root = tmpDir('skips-');
    fs.mkdirSync(path.join(root, 'M 27'));
    fs.writeFileSync(
      path.join(root, 'M 27', 'Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:16' }),
    );
    // Junk the user never thinks of as their files must not be reported.
    fs.writeFileSync(path.join(root, 'M 27', '.DS_Store'), 'junk');
    fs.mkdirSync(path.join(root, 'M 27_sub'));
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(
        path.join(root, 'M 27_sub', `Light_M 27_10.0s_IRCUT_20250930-21382${i}.fit`),
        fitsBuffer({ 'DATE-OBS': `2025-09-30T21:38:2${i}` }),
      );
    }

    const off = scanImportFolder(root, { ...settings, importSubFrames: false });
    expect(off.totals.files).toBe(1);
    expect(off.skipped).toEqual([
      {
        reason: 'sub-frames-disabled',
        label: expect.stringContaining('Include subframes'),
        count: 4,
        // Sized, so the review screen can say how much turning it on would add.
        bytes: expect.any(Number),
      },
    ]);
    expect(off.skipped[0].bytes).toBeGreaterThan(0);

    // With sub-frames on there is nothing left to explain.
    const on = scanImportFolder(root, { ...settings, importSubFrames: true });
    expect(on.totals.files).toBe(5);
    expect(on.skipped).toEqual([]);
  });

  it('treats everything in a _sub folder as a sub-frame, whatever it is named', () => {
    // The directory outranks the filename: a Stacked_* file sitting in a _sub
    // folder is still a sub-frame, so "Include subframes" governs it.
    const root = tmpDir('sub-authority-');
    fs.mkdirSync(path.join(root, 'M 27'));
    fs.writeFileSync(
      path.join(root, 'M 27', 'Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:16' }),
    );
    fs.mkdirSync(path.join(root, 'M 27_sub'));
    fs.writeFileSync(
      path.join(root, 'M 27_sub', 'Stacked_30_M 27_10.0s_IRCUT_20250930-213821.fit'),
      fitsBuffer({ 'DATE-OBS': '2025-09-30T21:38:21' }),
    );

    const off = scanImportFolder(root, { ...settings, importSubFrames: false });
    expect(off.totals.files).toBe(1);
    expect(off.skipped.map(s => s.reason)).toEqual(['sub-frames-disabled']);

    const on = scanImportFolder(root, { ...settings, importSubFrames: true });
    expect(on.totals.files).toBe(2);
  });

  it('catalogs Seestar solar_photo and lunar_photo folders as solar system objects', () => {
    const root = tmpDir('solar-lunar-');
    fs.mkdirSync(path.join(root, 'solar_photo'));
    fs.writeFileSync(
      path.join(root, 'solar_photo', 'Stacked_12_solar_photo_1.0ms_SOLAR_20260520-120000.jpg'),
      'jpg',
    );
    fs.mkdirSync(path.join(root, 'lunar_photo'));
    fs.writeFileSync(
      path.join(root, 'lunar_photo', 'Stacked_20_lunar_photo_5ms_IRCUT_20260521-210000.jpg'),
      'jpg',
    );

    const result = scanImportFolder(root, settings);

    const solar = result.objects.find(o => o.folderName === 'solar_photo');
    const lunar = result.objects.find(o => o.folderName === 'lunar_photo');
    expect(solar?.catalogMatch?.name).toBe('The Sun');
    expect(solar?.catalogMatch?.type).toBe('Star');
    expect(solar?.sessions.map(s => s.date)).toEqual(['2026-05-20']);
    expect(lunar?.catalogMatch?.name).toBe('The Moon');
    expect(lunar?.catalogMatch?.type).toBe('Natural Satellite');
    expect(lunar?.sessions.map(s => s.date)).toEqual(['2026-05-21']);
  });

  it('splits a Planetary_photo-style container folder into per-target objects', () => {
    const root = tmpDir('planetary-');
    fs.mkdirSync(path.join(root, 'Planetary_photo'));
    const files = [
      '2026-03-31-194930-Jupiter.jpg',
      '2026-03-31-194930-Jupiter_thn.jpg',
      '2026-05-25-212058-Venus.jpg',
      '2026-05-25-212346-Jupiter.jpg',
    ];
    for (const f of files) fs.writeFileSync(path.join(root, 'Planetary_photo', f), 'jpg');

    const result = scanImportFolder(root, settings);

    const names = result.objects.map(o => o.folderName).sort();
    expect(names).toEqual(['Jupiter', 'Venus']);

    const jupiter = result.objects.find(o => o.folderName === 'Jupiter')!;
    expect(jupiter.sessions.map(s => s.date).sort()).toEqual(['2026-03-31', '2026-05-25']);

    const venus = result.objects.find(o => o.folderName === 'Venus')!;
    expect(venus.sessions.map(s => s.date)).toEqual(['2026-05-25']);
  });

  it('commits a plan: copies files without renaming .fit/.jpg, records dated sessions', async () => {
    const root = makeSourceTree();
    await commitFolderImport({
      rootPath: root,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': '2024-01-16' },
        },
        {
          folderName: 'NGC7000',
          targetObjectId: 'NGC7000',
          targetFolderName: 'NGC7000',
          sessionMap: { '2023-09-10': '2023-09-10' },
        },
      ],
    });

    const m42Dir = path.join(LIBRARY_DIR, 'M42');
    const m42Files = objectFileNames(m42Dir);
    // JPG keeps its original name — no timestamp rename for .jpg files.
    expect(m42Files).toContain('Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg');
    // light_001.fits is imported (importFits defaults to true — see the
    // appSettings schema default in db.ts), but its DATE-OBS (01:00) rolls
    // back to the observing night of the 22:00 JPG, so it merges into the
    // same '2024-01-15' session rather than adding a second one. NGC7000
    // below proves the FITS import itself happened, since it has no other
    // file to merge with.

    const sessions = getLocalSessions('M42').map(s => s.date).sort();
    expect(sessions).toEqual(['2024-01-15']);
    expect(objectFileNames(m42Dir)).toContain('light_001.fits');

    // NGC7000 uses only a .fits file with no DATE-OBS card, so its session
    // date comes from the source's date-named directory instead.
    const ngcSessions = getLocalSessions('NGC7000').map(s => s.date);
    expect(ngcSessions).toEqual(['2023-09-10']);
  });

  // ── Upload staging cleanup ────────────────────────────────────────────────
  // A wizard upload is written to DATA_DIR/import-tmp in full before the import
  // starts, so without releasing each staged file as it lands, a large import
  // needs free space for two complete copies of itself. That is what filled a
  // user's system drive with 125 GB of leftovers.

  /** A source tree staged under import-tmp, as an upload would leave it. */
  function makeStagedTree(): { root: string; files: string[] } {
    const stagingRoot = path.join(TEST_DATA_DIR, 'import-tmp', '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(stagingRoot, 'M42'), { recursive: true });
    const files = [
      'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg',
      'Stacked_20_M42_30.0s_IRCUT_20240115-223000.jpg',
    ];
    for (const f of files) fs.writeFileSync(path.join(stagingRoot, 'M42', f), 'jpg');
    return { root: stagingRoot, files };
  }

  const m42StagedPlan = (root: string) => ({
    rootPath: root,
    objects: [{
      folderName: 'M42',
      targetObjectId: 'M42',
      targetFolderName: 'M42',
      sessionMap: { '2024-01-15': '2024-01-15' },
    }],
  });

  it('deletes each staged upload file once it has landed in the library', async () => {
    const { root, files } = makeStagedTree();

    await commitFolderImport(m42StagedPlan(root));

    // Imported...
    const imported = objectFileNames(path.join(LIBRARY_DIR, 'M42'));
    for (const f of files) expect(imported).toContain(f);
    // ...and the staging directory is gone, not merely emptied.
    expect(fs.existsSync(root)).toBe(false);
  });

  it('never touches the source of an in-place import', async () => {
    // The mirror image of the test above: a folder the user pointed us at is
    // not ours to delete, and the same code path handles both.
    const root = makeSourceTree();
    const before = objectFileNames(path.join(root, 'M42'));

    await commitFolderImport({
      rootPath: root,
      objects: [{
        folderName: 'M42',
        targetObjectId: 'M42',
        targetFolderName: 'M42',
        sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': '2024-01-16' },
      }],
    });

    expect(fs.existsSync(root)).toBe(true);
    expect(objectFileNames(path.join(root, 'M42'))).toEqual(before);
  });

  it('refuses to start when the library volume cannot hold the import', async () => {
    // Preflight rather than ENOSPC partway through: the free-space check runs
    // after the pre-walk and before the first copy. Simulated by claiming the
    // volume has no room, which is what a nearly-full disk reports.
    const { root } = makeStagedTree();
    const realStatfs = fs.statfsSync;
    const spy = vi.spyOn(fs, 'statfsSync').mockImplementation(((p: string) => {
      const real = realStatfs(p);
      return { ...real, bsize: 1, blocks: 1000, bfree: 0, bavail: 0 };
    }) as typeof fs.statfsSync);

    try {
      await commitFolderImport(m42StagedPlan(root));
    } finally {
      spy.mockRestore();
    }

    expect(getImportStatus().error).toContain('Not enough free space');
    // Nothing was copied...
    expect(objectFileNames(path.join(LIBRARY_DIR, 'M42'))).toEqual([]);
    // ...and the staged upload is released rather than left occupying the disk
    // that just proved too full. The error says so, since it means the user has
    // to upload again after freeing space.
    expect(fs.existsSync(root)).toBe(false);
    expect(getImportStatus().error).toContain('uploaded copy has been discarded');
  });

  it('merges two derived sessions when mapped to the same final date', async () => {
    const root = makeSourceTree();
    await commitFolderImport({
      rootPath: root,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          // Both nights collapsed onto one date.
          sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': '2024-01-15' },
        },
      ],
    });
    const sessions = getLocalSessions('M42').map(s => s.date);
    expect(sessions).toEqual(['2024-01-15']);
  });

  it('automatically merges an 11pm-1am session across local midnight, importFits enabled', async () => {
    // The exact bug this is fixing: a session that runs from before to after
    // local midnight must land as ONE session, not two, with no manual merge
    // required. makeSourceTree's M42 is precisely this — a JPG at 22:00 and an
    // undated FITS whose DATE-OBS is 01:00 the following UTC/local day.
    const root = makeSourceTree();
    await commitFolderImport({
      rootPath: root,
      importFits: true,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          // No override: sessionMap keys must already be the observing-night
          // bucket ('2024-01-15'), matching what scanImportFolder produced.
          sessionMap: { '2024-01-15': '2024-01-15' },
        },
      ],
    });

    const m42Dir = path.join(LIBRARY_DIR, 'M42');
    const m42Files = objectFileNames(m42Dir);
    expect(m42Files).toContain('Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg');
    // The FITS keeps its own name. It used to be rewritten to
    // `light_001_20240116-010000.fits` so that re-parsing it would re-derive
    // the right night; the libraryFiles row carries the capture instant now, so
    // the name no longer has to encode anything.
    expect(m42Files).toContain('light_001.fits');

    const sessions = getLocalSessions('M42');
    expect(sessions.map(s => s.date)).toEqual(['2024-01-15']);
    expect(sessions[0].fileCount).toBe(2);

    // The invariant the old rename existed to protect still holds: a 01:00
    // capture lands on the previous night, and a re-read cannot drift it. It is
    // now enforced by the stored capture instant rather than by the filename.
    const row = getLibraryFilesForObject('M42').find(r => r.fileName === 'light_001.fits')!;
    expect(row.captureDate).toBe('2024-01-16');
    expect(sessionDateForRow(row)).toBe('2024-01-15');
    expect(sessionDateForRow(row)).toBe(sessionDateForRow(row)); // idempotent
  });

  it('reconciles a stale pre-fix librarySessions row left over from a split midnight session', async () => {
    // Simulate what a pre-fix import would have left behind: two librarySessions
    // rows (one per raw calendar date) for a session that actually crossed local
    // midnight, with weather/telescope attribution stamped onto the *later* date.
    const root = tmpDir('reconcile-');
    fs.mkdirSync(path.join(root, 'M42'));
    fs.writeFileSync(
      path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg'),
      'jpg',
    );
    await commitFolderImport({
      rootPath: root,
      objects: [{
        folderName: 'M42',
        targetObjectId: 'M42',
        targetFolderName: 'M42',
        sessionMap: { '2024-01-15': '2024-01-15' },
      }],
    });
    expect(getLocalSessions('M42').map(s => s.date)).toEqual(['2024-01-15']);

    // Drop in a second file that raw-parses to 2024-01-16 but whose true time
    // (01:00) rolls back to the same observing night as the file above.
    fs.writeFileSync(
      path.join(LIBRARY_DIR, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20240116-010000.jpg'),
      'jpg2',
    );
    // Hand-write the stale row a pre-fix import would have produced for that
    // raw date, carrying weather + telescope attribution.
    stmts.addSessionStamped.run('M42', '2024-01-16', 'stale-telescope-id');
    // NULL weatherLat/weatherLon: a pre-fix row predates those columns.
    stmts.setSessionWeather.run(-5, 20, 60, 10, -8, 15, 5, null, null, 'M42', '2024-01-16');

    const sessions = getLocalSessions('M42');
    // The stale row is merged forward, not left as a second (phantom) session.
    expect(sessions.map(s => s.date)).toEqual(['2024-01-15']);
    expect(sessions[0].weather).toEqual({
      temperature: -5, cloudCover: 20, humidity: 60, windSpeed: 10,
      dewPoint: -8, visibility: 15, precipProb: 5,
    });
    expect(sessions[0].telescopeId).toBe('stale-telescope-id');

    // Idempotent: calling again after the stale row is gone doesn't error or
    // change anything further.
    expect(getLocalSessions('M42').map(s => s.date)).toEqual(['2024-01-15']);
  });

  it('splits by calendar date instead of merging when the Settings toggle is off', async () => {
    // Targets a dedicated object id (not the shared 'M42' other tests in this
    // file reuse) since beforeEach only wipes library files, not DB rows —
    // reusing 'M42' here would leak a second persisted session date into
    // neighboring tests that assume grouping is always on.
    updateSettingsData({ groupObservingNights: false });
    try {
      const root = makeSourceTree();
      await commitFolderImport({
        rootPath: root,
        importFits: true,
        objects: [{
          folderName: 'M42',
          targetObjectId: 'M42TOGGLETEST',
          targetFolderName: 'M42TOGGLETEST',
          // With grouping off, the derived buckets are the raw calendar
          // dates again — no observing-night rollover to collapse them.
          sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': '2024-01-16' },
        }],
      });

      const m42Files = objectFileNames(path.join(LIBRARY_DIR, 'M42TOGGLETEST'));
      expect(m42Files).toContain('Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg');
      // Unrenamed, as everywhere else now.
      expect(m42Files).toContain('light_001.fits');

      const sessions = getLocalSessions('M42TOGGLETEST').map(s => s.date).sort();
      expect(sessions).toEqual(['2024-01-15', '2024-01-16']);
      // The point of this test: with grouping off the 01:00 capture stays on
      // its own raw calendar date instead of rolling back. That now comes from
      // deriving the night off the stored instant, which is exactly why the
      // instant is stored raw rather than pre-rolled.
      const row = getLibraryFilesForObject('M42TOGGLETEST')
        .find(r => r.fileName === 'light_001.fits')!;
      expect(sessionDateForRow(row)).toBe('2024-01-16');
    } finally {
      updateSettingsData({ groupObservingNights: true });
    }
  });

  it('drops files whose session is mapped to null', async () => {
    const root = makeSourceTree();
    await commitFolderImport({
      rootPath: root,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          sessionMap: { '2024-01-15': '2024-01-15', '2024-01-16': null },
        },
      ],
    });
    const sessions = getLocalSessions('M42').map(s => s.date);
    expect(sessions).toEqual(['2024-01-15']);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M42', 'light_001_20240116-010000.fits'))).toBe(false);
  });

  it('imports loose Dwarf RAW TELE FITS as subframes when subframes are included', async () => {
    const root = tmpDir('dwarf-raw-');
    const rawName = 'NGC 1647_15s60_Astro_20260318-201554115_26C.fits';
    fs.writeFileSync(path.join(root, rawName), fitsBuffer({ OBJECT: 'NGC 1647' }));

    const scanned = scanImportFolder(root, {
      importSubFrames: true,
      importFits: false,
      importJpg: true,
    });
    expect(scanned.objects).toHaveLength(1);
    expect(scanned.objects[0].fileCount).toBe(1);
    expect(scanned.objects[0].sessions.map(s => s.date)).toEqual(['2026-03-18']);

    await commitFolderImport({
      rootPath: root,
      importSubFrames: true,
      objects: [
        {
          folderName: 'NGC 1647',
          targetObjectId: 'NGC1647',
          targetFolderName: 'NGC1647',
          sessionMap: { '2026-03-18': '2026-03-18' },
        },
      ],
    });

    const files = objectFileNames(path.join(LIBRARY_DIR, 'NGC1647'));
    expect(files).toContain(rawName);

    const [session] = getLocalSessions('NGC1647');
    expect(session.date).toBe('2026-03-18');
    expect(session.subFrameCount).toBe(1);
  });

  it('commitFolderImport: second import from differently-named alias folder merges into existing library dir', async () => {
    // Reproduces: user imports "C63" folder (350 files, 2 nights), then imports
    // "NGC7293" folder (20 files, 1 night). C63 and NGC7293 are both names for
    // the Helix Nebula; resolveCanonicalId maps both to "NGC7293".
    // Expected: all files visible under NGC7293, library dir is NOT duplicated.

    // Import 1: "C63" folder with 2 FITS files across 2 dates. Plain numbered
    // filenames (no embedded target name) so collectObjectSources uses the
    // directory name "C63" as the source folderName, instead of splitting by
    // an extracted target.
    const src1 = tmpDir('helix-c63-');
    fs.mkdirSync(path.join(src1, 'C63'));
    fs.writeFileSync(
      path.join(src1, 'C63', 'light_001.fits'),
      fitsBuffer({ 'DATE-OBS': '2026-06-21T12:00:00' }),
    );
    fs.writeFileSync(
      path.join(src1, 'C63', 'light_002.fits'),
      fitsBuffer({ 'DATE-OBS': '2026-06-22T12:00:00' }),
    );

    await commitFolderImport({
      rootPath: src1,
      importFits: true,
      objects: [
        {
          folderName: 'C63',
          targetObjectId: 'C63',
          targetFolderName: 'C63',
          sessionMap: { '2026-06-21': '2026-06-21', '2026-06-22': '2026-06-22' },
        },
      ],
    });

    // Confirm 2 sessions after first import.
    const sessionsAfter1 = getLocalSessions('NGC7293');
    expect(sessionsAfter1.map(s => s.date).sort()).toEqual(['2026-06-21', '2026-06-22']);
    const totalAfter1 = sessionsAfter1.reduce((n, s) => n + s.fileCount, 0);
    expect(totalAfter1).toBe(2);

    // Import 2: "NGC7293" folder with 1 additional file (same canonical object).
    const src2 = tmpDir('helix-ngc7293-');
    fs.mkdirSync(path.join(src2, 'NGC7293'));
    fs.writeFileSync(
      path.join(src2, 'NGC7293', 'light_003.fits'),
      fitsBuffer({ 'DATE-OBS': '2026-06-22T20:00:00' }),
    );

    await commitFolderImport({
      rootPath: src2,
      importFits: true,
      objects: [
        {
          folderName: 'NGC7293',
          targetObjectId: 'NGC7293',
          targetFolderName: 'NGC7293',
          sessionMap: { '2026-06-22': '2026-06-22' },
        },
      ],
    });

    // All 3 files should be visible; no second library dir should be created.
    const sessionsAfter2 = getLocalSessions('NGC7293');
    const totalAfter2 = sessionsAfter2.reduce((n, s) => n + s.fileCount, 0);
    expect(totalAfter2).toBe(3);
    expect(sessionsAfter2.map(s => s.date).sort()).toEqual(['2026-06-21', '2026-06-22']);

    // Only one library directory should exist for this object (C63, the first-import name).
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C63'))).toBe(true);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'NGC7293'))).toBe(false);
  });

  it('runImport: telescope sync from alias-named device folder reuses the existing library dir', async () => {
    // Reproduces the user-reported bug via the actual path it happens on: the
    // folder wizard creates a literal "C63" library dir, then a later
    // telescope sync (runImport, e.g. scheduled auto-import or "Sync Now")
    // discovers the same object under its device folder name "NGC7293".
    // runImport previously always wrote to safeObjectDir(canonicalId) — i.e.
    // "NGC7293" — ignoring the existing "C63" folderName, which orphaned the
    // first import's files and showed two split (and one empty) observations.

    // Import 1 via the folder wizard: literal "C63" library dir.
    const src1 = tmpDir('helix-wizard-c63-');
    fs.mkdirSync(path.join(src1, 'C63'));
    fs.writeFileSync(
      path.join(src1, 'C63', 'light_001.fits'),
      fitsBuffer({ 'DATE-OBS': '2026-06-21T12:00:00' }),
    );
    fs.writeFileSync(
      path.join(src1, 'C63', 'light_002.fits'),
      fitsBuffer({ 'DATE-OBS': '2026-06-22T12:00:00' }),
    );
    await commitFolderImport({
      rootPath: src1,
      importFits: true,
      objects: [
        {
          folderName: 'C63',
          targetObjectId: 'C63',
          targetFolderName: 'C63',
          sessionMap: { '2026-06-21': '2026-06-21', '2026-06-22': '2026-06-22' },
        },
      ],
    });
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'C63'))).toBe(true);

    // Import 2 via a telescope sync: device exposes the object under folder
    // "NGC7293" (kind 'other' -> walker basePath '', so the device folder
    // sits directly at localPath/NGC7293).
    const deviceRoot = tmpDir('helix-device-');
    fs.mkdirSync(path.join(deviceRoot, 'NGC7293'));
    fs.writeFileSync(
      path.join(deviceRoot, 'NGC7293', 'Stacked_10_NGC7293_30.0s_IRCUT_20260622-200000.jpg'),
      'jpg3',
    );
    const profile = createProfile({
      name: 'Test SeeStar (local)',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });
    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    // All 3 files should be visible across 2 sessions; no second library dir.
    const sessionsAfter2 = getLocalSessions('NGC7293');
    const totalAfter2 = sessionsAfter2.reduce((n, s) => n + s.fileCount, 0);
    expect(totalAfter2).toBe(3);
    expect(sessionsAfter2.map(s => s.date).sort()).toEqual(['2026-06-21', '2026-06-22']);

    const libEntries = fs.readdirSync(LIBRARY_DIR);
    const helixDirs = libEntries.filter(d => d === 'C63' || d === 'NGC7293');
    expect(helixDirs).toHaveLength(1);
    expect(helixDirs[0]).toBe('C63');
  });

  it('commitFolderImport: only stamps sessions this run actually created, not pre-existing untagged ones', async () => {
    // Decision: wizard telescope attribution must only stamp sessions this
    // import actually created. A pre-existing untagged session (e.g. from an
    // earlier import with no telescope selected) must stay untagged so users
    // can still tag observations under an object independently of import.

    // Import 1: no telescope selected — session stays untagged.
    const src1 = tmpDir('attrib-untagged-');
    fs.mkdirSync(path.join(src1, 'M42'));
    fs.writeFileSync(
      path.join(src1, 'M42', 'light_001.fits'),
      fitsBuffer({ 'DATE-OBS': '2026-06-21T12:00:00' }),
    );
    await commitFolderImport({
      rootPath: src1,
      importFits: true,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          sessionMap: { '2026-06-21': '2026-06-21' },
        },
      ],
    });
    expect(stmts.getSession.get('M42', '2026-06-21')?.telescopeId).toBeNull();

    // Import 2: a new session date, this time with a telescope selected.
    const profile = createProfile({ name: 'Test SeeStar', kind: 'other' });
    const src2 = tmpDir('attrib-tagged-');
    fs.mkdirSync(path.join(src2, 'M42'));
    fs.writeFileSync(
      path.join(src2, 'M42', 'light_002.fits'),
      fitsBuffer({ 'DATE-OBS': '2026-06-22T12:00:00' }),
    );
    await commitFolderImport({
      rootPath: src2,
      importFits: true,
      telescopeId: profile.id,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          sessionMap: { '2026-06-22': '2026-06-22' },
        },
      ],
    });

    // The old session (imported before any telescope was selected) stays
    // untagged; only the newly-created session is stamped.
    expect(stmts.getSession.get('M42', '2026-06-21')?.telescopeId).toBeNull();
    expect(stmts.getSession.get('M42', '2026-06-22')?.telescopeId).toBe(profile.id);
    // First-to-import-wins is still COALESCE-style: the object itself gets
    // claimed by the first telescope that stamps any of its sessions.
    expect(stmts.getObject.get('M42')?.primaryTelescopeId).toBe(profile.id);
  });
});
