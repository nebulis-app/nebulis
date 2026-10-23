import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors dwarfArchiveScoping.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-calibrationscan-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import { getArchiveDir } from '../../server/lib/library/archiveFolders';
import { listCalibrationLibrary, findCalibrationBundle, calibrationBundleName, deleteCalibrationBundle } from '../../server/lib/library/calibrationScan';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function writeFrame(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'frame-bytes');
}

describe('a preview picture beside its raw frame', () => {
  it('is the same image as the frame, so it is not counted twice (SeeStar darklibrary)', () => {
    const lib = path.join(getArchiveDir(null), 'darklibrary');
    writeFrame(lib, 'MasterDark_5_30.0s_26.0C_20261014-192837.fit');
    writeFrame(lib, 'MasterDark_5_30.0s_26.0C_20261014-192837.jpg');
    writeFrame(lib, 'MasterDark_5_30.0s_26.0C_20261014-192837_thn.jpg');
    // A picture with no raw frame of its own is a frame in its own right.
    writeFrame(lib, 'Lonely_dark_note.jpg');

    try {
      const group = listCalibrationLibrary().find(g => g.folderName === 'darklibrary')!;
      expect(group.type).toBe('dark');
      expect(group.fileCount).toBe(2);
      const names = group.subfolders.flatMap(sub => sub.files.map(f => f.name)).sort();
      expect(names).toEqual(['Lonely_dark_note.jpg', 'MasterDark_5_30.0s_26.0C_20261014-192837.fit']);
      const master = group.subfolders.flatMap(sub => sub.files).find(f => f.name.endsWith('.fit'))!;
      expect(master.info).toMatchObject({ exposureSec: 30, sensorTempC: 26 });
    } finally {
      // The archive is shared by the tests below, which assert exactly which groups exist.
      fs.rmSync(lib, { recursive: true, force: true });
    }
  });

  it('previewNamesOf matches by stem within a folder, case-insensitively, and only for pictures', async () => {
    const { previewNamesOf } = await import('../../server/lib/library/calibrationScan');
    expect([...previewNamesOf(['a.fit', 'a.jpg', 'A.PNG', 'b.jpg', 'c.fits', 'c.fits.txt'])].sort()).toEqual(['A.PNG', 'a.jpg']);
  });
});

describe('listCalibrationLibrary', () => {
  it('groups the unscoped archive by frame type, with subfolders and parsed filename metadata', () => {
    const unscopedBias = path.join(getArchiveDir(null), 'Bias', 'G100_TECm8');
    writeFrame(unscopedBias, 'Bias_5.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit');
    writeFrame(unscopedBias, 'Bias_5.0s_Bin1_Dark_gain100_20260815-193226_2deg_-8.0C_0002.fit');

    const unscopedDarks = path.join(getArchiveDir(null), 'Darks', 'G100_60s_TECm8');
    writeFrame(unscopedDarks, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-7.7C_0001.fit');

    const groups = listCalibrationLibrary();
    expect(groups.map(g => `${g.folderName}`).sort()).toEqual(['Bias', 'Darks']);

    const bias = groups.find(g => g.folderName === 'Bias')!;
    expect(bias.type).toBe('bias');
    expect(bias.typeLabel).toBe('Bias');
    expect(bias.scope).toBeNull();
    expect(bias.scopeLabel).toBe('Unassigned');
    expect(bias.fileCount).toBe(2);
    expect(bias.subfolders.map(s => s.name)).toEqual(['G100_TECm8']);
    const sub = bias.subfolders[0];
    expect(sub.fileCount).toBe(2);
    expect(sub.files[0].name).toBe('Bias_5.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit');
    expect(sub.files[0].info).toMatchObject({ exposureSec: 5, binning: 1, gain: 100, sequence: 1 });

    const darks = groups.find(g => g.folderName === 'Darks')!;
    expect(darks.type).toBe('dark');
    expect(darks.subfolders.map(s => s.name)).toEqual(['G100_60s_TECm8']);
  });

  it('scopes calibration groups per telescope, and labels an unassigned scope separately', () => {
    const profile = createProfile({ name: 'Backyard Rig', kind: 'other', connectionType: 'local', localPath: '/tmp/does-not-matter' });

    writeFrame(path.join(getArchiveDir(profile.id), 'Flats', 'L_filter'), 'flat_001.fit');
    writeFrame(path.join(getArchiveDir(null), 'Flats', 'L_filter'), 'flat_001.fit');

    const groups = listCalibrationLibrary().filter(g => g.folderName === 'Flats');
    expect(groups).toHaveLength(2);

    const scoped = groups.find(g => g.scope === profile.id)!;
    expect(scoped.scopeLabel).toBe('Backyard Rig');
    expect(scoped.type).toBe('flat');

    const unscoped = groups.find(g => g.scope === null)!;
    expect(unscoped.scopeLabel).toBe('Unassigned');
  });

  // Regression: a live ASIAIR sync archives calibration frames one level
  // deeper than a folder-import wizard run does — under the capture-mode
  // folder that produced them (`Plan/Dark`, `Autorun/Bias`, ...), not flat
  // at the scope root (see asiairWalker.ts's ASIAIR_CALIBRATION_PATHS). A
  // real dark frame captured this way, sitting in the archive, was silently
  // invisible here before this was handled: a plain top-level readdir only
  // ever sees `Plan`/`Autorun`, never `Dark` itself.
  it('finds calibration frames archived under an ASIAIR capture-mode folder (Plan/Dark, Autorun/Bias)', () => {
    const profile = createProfile({ name: 'Elendil', kind: 'asiair', connectionType: 'smb', hostname: '192.168.1.31', shareName: 'EMMC Images' });

    writeFrame(
      path.join(getArchiveDir(profile.id), 'Plan', 'Dark'),
      'Dark_1.0s_Bin1_Dark_gain200_20260908-043143_5deg_-8.0C_0001.fit',
    );
    // ASIAIR writes a JPEG preview alongside the FITS frame — must not show
    // up as a second, unparsed calibration file next to it.
    writeFrame(
      path.join(getArchiveDir(profile.id), 'Plan', 'Dark'),
      'Dark_1.0s_Bin1_Dark_gain200_20260908-043143_5deg_-8.0C_0001_thn.jpg',
    );
    writeFrame(path.join(getArchiveDir(profile.id), 'Autorun', 'Bias'), 'Bias_1.0s_Bin1_Dark_gain200_20260908-043200_5deg_-8.0C_0001.fit');
    // Autorun/Live is a real ASIAIR folder that is never calibration data —
    // must not be mistaken for one just because it sits under a mode folder.
    writeFrame(path.join(getArchiveDir(profile.id), 'Autorun', 'Live', 'NGC 1'), 'stack.fits');

    const groups = listCalibrationLibrary().filter(g => g.scope === profile.id);
    expect(groups.map(g => g.folderName).sort()).toEqual(['Autorun/Bias', 'Plan/Dark']);

    const dark = groups.find(g => g.folderName === 'Plan/Dark')!;
    expect(dark.type).toBe('dark');
    expect(dark.fileCount).toBe(1); // the _thn.jpg preview is excluded
    expect(dark.subfolders).toHaveLength(1);
    expect(dark.subfolders[0].files.map(f => f.name)).toEqual([
      'Dark_1.0s_Bin1_Dark_gain200_20260908-043143_5deg_-8.0C_0001.fit',
    ]);
    expect(dark.subfolders[0].files[0].info).toMatchObject({ exposureSec: 1, gain: 200, sequence: 1 });

    const bias = groups.find(g => g.folderName === 'Autorun/Bias')!;
    expect(bias.type).toBe('bias');
    expect(bias.fileCount).toBe(1);
  });

  // Real-shape fixture from an actual Dwarf 3 export
  // (Astronomy/CALI_FRAME/{bias,dark,flat}/cam_{0,1}/...) — a completely
  // different filename convention from ASIAIR's, parsed by
  // calibrationFolders.ts's Dwarf-specific pattern.
  it("parses a Dwarf 3 CALI_FRAME folder's real-shape filenames, keeping cam_0/cam_1 separate", () => {
    const profile = createProfile({ name: 'Dwarf 3', kind: 'dwarf-3', connectionType: 'local', localPath: '/tmp/dwarf3' });
    const caliDir = path.join(getArchiveDir(profile.id), 'CALI_FRAME');

    writeFrame(path.join(caliDir, 'dark', 'cam_0'), 'dark_exp_30.000000_gain_60_bin_1_22C_stack_6.fits');
    writeFrame(path.join(caliDir, 'dark', 'cam_1'), 'dark_exp_30.000000_gain_60_bin_1_22C_stack_4.fits');
    writeFrame(path.join(caliDir, 'bias', 'cam_0'), 'bias_gain_2_bin_1.fits');
    writeFrame(path.join(caliDir, 'flat', 'cam_0'), 'flat_gain_2_bin_1_ir_1.fits');

    const groups = listCalibrationLibrary().filter(g => g.scope === profile.id);
    expect(groups).toHaveLength(1);
    const mixed = groups[0];
    expect(mixed.type).toBe('mixed');
    expect(mixed.folderName).toBe('CALI_FRAME');

    const darkSub = mixed.subfolders.find(s => s.name === 'dark')!;
    const cam0Dark = darkSub.files.find(f => f.name.includes('cam_0'))!;
    expect(cam0Dark.info).toMatchObject({ exposureSec: 30, gain: 60, binning: 1, sensorTempC: 22, stackCount: 6, camera: 'cam_0' });
    const cam1Dark = darkSub.files.find(f => f.name.includes('cam_1'))!;
    expect(cam1Dark.info).toMatchObject({ exposureSec: 30, gain: 60, binning: 1, sensorTempC: 22, stackCount: 4, camera: 'cam_1' });

    // Same exposure/gain/bin/temp on both cameras — must NOT merge into one
    // settings bundle, since a wide and a tele Dwarf dark come from
    // physically different sensors.
    const darkBundles = mixed.settingsGroups.filter(s => s.exposureSec === 30 && s.gain === 60);
    expect(darkBundles).toHaveLength(2);
    expect(darkBundles.map(s => s.camera).sort()).toEqual(['cam_0', 'cam_1']);
    expect(darkBundles.every(s => s.fileCount === 1)).toBe(true);

    const biasSub = mixed.subfolders.find(s => s.name === 'bias')!;
    expect(biasSub.files[0].info).toMatchObject({ gain: 2, binning: 1, camera: 'cam_0' });
    expect(biasSub.files[0].info?.exposureSec).toBeUndefined();

    const flatSub = mixed.subfolders.find(s => s.name === 'flat')!;
    expect(flatSub.files[0].info).toMatchObject({ gain: 2, binning: 1, filterLabel: 'IR1', camera: 'cam_0' });
  });

  // Real-shape fixture from an actual Dwarf 3 export that had accumulated
  // both DWARF_DARK (an older firmware's raw, unstacked sub-frames in
  // per-session folders) and CALI_FRAME (a newer firmware's pre-stacked
  // masters) for the SAME telescope — two entirely different calibration
  // conventions living side by side in one archive scope.
  it("parses a Dwarf DWARF_DARK folder's real-shape session/file layout, pulling camera and binning from the session folder name", () => {
    const profile = createProfile({ name: 'Dwarf 3 (raw darks)', kind: 'dwarf-3', connectionType: 'local', localPath: '/tmp/dwarf3-raw' });
    const darkDir = path.join(getArchiveDir(profile.id), 'DWARF_DARK');

    const teleSession = path.join(darkDir, 'tele_exp_60_gain_60_bin_1_2025-06-19-22-47-27-957');
    writeFrame(teleSession, 'raw_60s_60_0000_20250619-224827236_34C.fits');
    writeFrame(teleSession, 'raw_60s_60_0009_20250619-225727031_37C.fits');

    const wideSession = path.join(darkDir, 'wide_exp_30_gain_60_bin_1_2025-07-24-23-43-28-522');
    writeFrame(wideSession, 'raw_30s_60_0000_20250724-234357539_22C.fits');

    const groups = listCalibrationLibrary().filter(g => g.scope === profile.id);
    expect(groups).toHaveLength(1);
    const darks = groups[0];
    expect(darks.type).toBe('dark');
    expect(darks.folderName).toBe('DWARF_DARK');

    const teleSub = darks.subfolders.find(s => s.name === 'tele_exp_60_gain_60_bin_1_2025-06-19-22-47-27-957')!;
    expect(teleSub.files.every(f => f.info?.camera === 'tele' && f.info?.binning === 1)).toBe(true);
    expect(teleSub.files.find(f => f.name.includes('0009'))!.info).toMatchObject({
      exposureSec: 60, gain: 60, binning: 1, camera: 'tele', sequence: 9, sensorTempC: 37,
    });

    const wideSub = darks.subfolders.find(s => s.name === 'wide_exp_30_gain_60_bin_1_2025-07-24-23-43-28-522')!;
    expect(wideSub.files[0].info).toMatchObject({ exposureSec: 30, gain: 60, binning: 1, camera: 'wide', sensorTempC: 22 });

    // tele and wide must never merge into the same bundle, however close
    // their other settings — camera is part of the bucket key. (The two
    // "tele" frames land in separate bundles of their own here since their
    // temperatures, 34C and 37C, are outside the 1-degree TEC tolerance.)
    expect(new Set(darks.settingsGroups.map(s => s.camera))).toEqual(new Set(['tele', 'wide']));
    expect(darks.settingsGroups.every(s => new Set(s.files.map(f => f.info?.camera)).size === 1)).toBe(true);
  });

  it('ignores non-calibration folders that happen to live in the archive root', () => {
    writeFrame(path.join(getArchiveDir(null), 'RESTACKED'), 'stack.fits');
    const groups = listCalibrationLibrary();
    expect(groups.some(g => g.folderName === 'RESTACKED')).toBe(false);
  });

  it('returns an empty list when nothing has been archived yet', () => {
    // Fresh scope with no archive directory at all.
    const profile = createProfile({ name: 'Never Synced', kind: 'other', connectionType: 'local', localPath: '/tmp/never' });
    const groups = listCalibrationLibrary().filter(g => g.scope === profile.id);
    expect(groups).toEqual([]);
  });

  it('leaves the library root untouched — this reads the archive only', () => {
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'Bias'))).toBe(false);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'Darks'))).toBe(false);
  });

  describe('settingsGroups', () => {
    // Each test gets its own freshly-created telescope profile, so its
    // archive scope starts empty rather than accumulating frames earlier
    // tests in this file already wrote into the shared unscoped bucket.
    function freshScope(name: string): string {
      return createProfile({ name, kind: 'other', connectionType: 'local', localPath: `/tmp/${name}` }).id;
    }

    it('buckets frames by exposure/binning/gain/TEC regardless of which subfolder they sit in', () => {
      const scope = freshScope('settings-groups-bucketing');
      // Two different subfolders, same actual capture settings — a real
      // calibration workflow wants these bundled together regardless of the
      // folder-naming convention (or lack of one) the source used.
      const root = path.join(getArchiveDir(scope), 'Darks');
      writeFrame(path.join(root, 'session1'), 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
      writeFrame(path.join(root, 'session2'), 'Dark_60.0s_Bin1_Dark_gain100_20260815-191008_2deg_-8.0C_0001.fit');
      // A different exposure must land in its own bundle.
      writeFrame(path.join(root, 'session1'), 'Dark_120.0s_Bin1_Dark_gain100_20260814-191500_2deg_-8.0C_0001.fit');
      // Unparseable name — still counted, in its own "unknown settings" bundle.
      writeFrame(path.join(root, 'session1'), 'weird-manual-name.fit');

      const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
      expect(darks.settingsGroups).toHaveLength(3);

      const sixty = darks.settingsGroups.find(s => s.exposureSec === 60)!;
      expect(sixty).toMatchObject({ exposureSec: 60, binning: 1, gain: 100, sensorTempC: -8, fileCount: 2 });
      expect(sixty.files.map(f => path.basename(f.name)).sort()).toEqual([
        'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit',
        'Dark_60.0s_Bin1_Dark_gain100_20260815-191008_2deg_-8.0C_0001.fit',
      ]);

      const oneTwenty = darks.settingsGroups.find(s => s.exposureSec === 120)!;
      expect(oneTwenty.fileCount).toBe(1);

      const unknown = darks.settingsGroups.find(s => s.exposureSec === null)!;
      expect(unknown.fileCount).toBe(1);
      expect(unknown.binning).toBeNull();

      // Ascending by exposure, unknown-settings bundle sorts last.
      expect(darks.settingsGroups.map(s => s.exposureSec)).toEqual([60, 120, null]);
    });

    it('exposes an absolute path per file, for pointing a stacking app at it directly', () => {
      const scope = freshScope('settings-groups-abspath');
      writeFrame(path.join(getArchiveDir(scope), 'Bias'), 'Bias_1.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit');
      const bias = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Bias')!;
      const file = bias.settingsGroups[0].files[0];
      expect(file.path).toBe(path.join(getArchiveDir(scope), 'Bias', file.name));
      expect(fs.existsSync(file.path)).toBe(true);
    });

    // A cooled camera's TEC holds *near* its setpoint, not exactly on it —
    // real captures drift by a few tenths of a degree run to run. Without
    // tolerance, these would fragment into several near-duplicate
    // one-or-two-frame bundles instead of the one set they actually are.
    describe('TEC temperature tolerance', () => {
      it('merges frames within 1 degree of each other into one bundle, with the cluster average as the representative temperature', () => {
        const scope = freshScope('tec-tolerance-merge');
        const root = path.join(getArchiveDir(scope), 'Darks');
        // Same real-world spread seen in an actual archived dark set.
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-7.8C_0001.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191108_2deg_-8.0C_0002.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191208_2deg_-8.1C_0003.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191308_2deg_-7.9C_0004.fit');

        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        expect(darks.settingsGroups).toHaveLength(1);
        const set = darks.settingsGroups[0];
        expect(set.fileCount).toBe(4);
        // Mean of -7.8, -8.0, -8.1, -7.9 = -7.95, rounded to one decimal
        // place (JS rounds .5 toward +Infinity, so -7.95 → -7.9).
        expect(set.sensorTempC).toBe(-7.9);
      });

      it('does not merge frames more than 1 degree apart — two genuinely different TEC setpoints stay separate bundles', () => {
        const scope = freshScope('tec-tolerance-no-merge');
        const root = path.join(getArchiveDir(scope), 'Darks');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191108_2deg_-9.5C_0002.fit');

        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        expect(darks.settingsGroups).toHaveLength(2);
        expect(darks.settingsGroups.map(s => s.sensorTempC).sort((a, b) => a! - b!)).toEqual([-9.5, -8]);
        for (const set of darks.settingsGroups) expect(set.fileCount).toBe(1);
      });

      it('merges a gap of exactly 1 degree (the boundary is inclusive)', () => {
        const scope = freshScope('tec-tolerance-boundary');
        const root = path.join(getArchiveDir(scope), 'Darks');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191108_2deg_-9.0C_0002.fit');

        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        expect(darks.settingsGroups).toHaveLength(1);
        expect(darks.settingsGroups[0].fileCount).toBe(2);
      });

      it('a chain of 1-degree steps clusters as one bundle end to end, and a further outlier starts a new one', () => {
        const scope = freshScope('tec-tolerance-chain');
        const root = path.join(getArchiveDir(scope), 'Darks');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-6.0C_0001.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191108_2deg_-7.0C_0002.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191208_2deg_-8.0C_0003.fit');
        // 2 degrees from the previous reading (-8.0), but the chain as a
        // whole spans 4 degrees from the first (-6.0) — outside any single
        // frame's own tolerance of any other, so it must not join.
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191308_2deg_-10.0C_0004.fit');

        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        expect(darks.settingsGroups).toHaveLength(2);
        const chained = darks.settingsGroups.find(s => s.fileCount === 3)!;
        expect(chained.sensorTempC).toBe(-7); // mean of -6, -7, -8
        const outlier = darks.settingsGroups.find(s => s.fileCount === 1)!;
        expect(outlier.sensorTempC).toBe(-10);
      });

      it('does not apply the same tolerance to exposure, binning, or gain — those must match exactly', () => {
        const scope = freshScope('tec-tolerance-other-fields-exact');
        const root = path.join(getArchiveDir(scope), 'Darks');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
        writeFrame(root, 'Dark_61.0s_Bin1_Dark_gain100_20260814-191108_2deg_-8.0C_0002.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain101_20260814-191208_2deg_-8.0C_0003.fit');

        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        // Three distinct exposure/gain combinations, all at the same TEC — no
        // cross-merging on anything but temperature.
        expect(darks.settingsGroups).toHaveLength(3);
        for (const set of darks.settingsGroups) expect(set.fileCount).toBe(1);
      });

      it('files with no recognizable temperature at all are never pulled into a temperature cluster', () => {
        const scope = freshScope('tec-tolerance-unknown-untouched');
        const root = path.join(getArchiveDir(scope), 'Darks');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
        writeFrame(root, 'Dark_60s_Bin1_20250723-13073265_0018.fit'); // no temperature field at all

        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        expect(darks.settingsGroups).toHaveLength(2);
        expect(darks.settingsGroups.map(s => s.sensorTempC)).toEqual([-8, null]);
      });

      it('the resulting key still resolves through findCalibrationBundle after clustering', () => {
        const scope = freshScope('tec-tolerance-findbundle');
        const root = path.join(getArchiveDir(scope), 'Darks');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-7.8C_0001.fit');
        writeFrame(root, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191108_2deg_-8.2C_0002.fit');

        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        const set = darks.settingsGroups[0];
        const found = findCalibrationBundle(scope, 'Darks', set.key);
        expect(found).not.toBeNull();
        expect(found!.set.fileCount).toBe(2);
      });
    });
  });

  describe('calibrationBundleName + findCalibrationBundle', () => {
    function freshScope(name: string): string {
      return createProfile({ name, kind: 'other', connectionType: 'local', localPath: `/tmp/${name}` }).id;
    }

    it('builds a descriptive, filename-safe bundle name from a settings group', () => {
      const scope = freshScope('bundle-name-flats');
      writeFrame(path.join(getArchiveDir(scope), 'Flats'), 'Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit');
      const flats = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Flats')!;
      const set = flats.settingsGroups[0];
      expect(calibrationBundleName(flats, set)).toBe('Flats_0.001s_Bin1_gain100_-10.5C');
    });

    it('names an unknown-settings bundle without the raw sentinel token leaking into it', () => {
      const scope = freshScope('bundle-name-unknown');
      writeFrame(path.join(getArchiveDir(scope), 'Bias'), 'unparseable.fit');
      const bias = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Bias')!;
      const set = bias.settingsGroups[0];
      expect(calibrationBundleName(bias, set)).toBe('Bias_unk_Binunk_unk_unk');
    });

    it("includes the camera token, and the bundle's own resolved frame type rather than the group's generic label", () => {
      const scope = freshScope('bundle-name-dwarf-camera');
      writeFrame(path.join(getArchiveDir(scope), 'CALI_FRAME', 'bias', 'cam_0'), 'bias_gain_2_bin_1.fits');
      const mixed = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'CALI_FRAME')!;
      expect(mixed.typeLabel).toBe('Calibration (mixed)');
      const set = mixed.settingsGroups[0];
      expect(set.frameType).toBe('bias');
      expect(calibrationBundleName(mixed, set)).toBe('Bias_cam0_unk_Bin1_gain2_unk');
    });

    it('finds the exact bundle a (scope, folderName, key) selector points at', () => {
      const scope = freshScope('find-bundle');
      writeFrame(path.join(getArchiveDir(scope), 'Darks'), 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
      const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
      const set = darks.settingsGroups[0];

      const found = findCalibrationBundle(scope, 'Darks', set.key);
      expect(found).not.toBeNull();
      expect(found!.set.fileCount).toBe(1);
      expect(found!.set.files[0].name).toContain('Dark_60.0s_Bin1_Dark_gain100');
    });

    it('returns null for a folder, scope, or key that does not exist', () => {
      const scope = freshScope('find-bundle-misses');
      expect(findCalibrationBundle(scope, 'DoesNotExist', 'whatever')).toBeNull();
      expect(findCalibrationBundle('no-such-telescope-id', 'Darks', 'whatever')).toBeNull();
      writeFrame(path.join(getArchiveDir(scope), 'Darks'), 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
      expect(findCalibrationBundle(scope, 'Darks', 'not-a-real-key')).toBeNull();
    });
  });

  describe('calibration expiry (bias/dark only)', () => {
    function freshScope(name: string): string {
      return createProfile({ name, kind: 'other', connectionType: 'local', localPath: `/tmp/${name}` }).id;
    }

    /** Builds a real recognized filename whose embedded timestamp is
     *  `date` — lets a test control "captured at" precisely without
     *  depending on when the suite happens to run. */
    function darkFilenameAt(date: Date, seq = 1): string {
      const y = date.getFullYear();
      const mo = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      const ss = String(date.getSeconds()).padStart(2, '0');
      const seqStr = String(seq).padStart(4, '0');
      return `Dark_60.0s_Bin1_Dark_gain100_${y}${mo}${d}-${hh}${mm}${ss}_2deg_-8.0C_${seqStr}.fit`;
    }

    function daysAgo(n: number): Date {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d;
    }

    it('flags a dark bundle older than the default 180-day window as expired', () => {
      const scope = freshScope('expiry-old-dark');
      writeFrame(path.join(getArchiveDir(scope), 'Darks'), darkFilenameAt(daysAgo(200)));
      const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
      expect(darks.settingsGroups[0].isExpired).toBe(true);
    });

    it('does not flag a recent dark bundle', () => {
      const scope = freshScope('expiry-fresh-dark');
      writeFrame(path.join(getArchiveDir(scope), 'Darks'), darkFilenameAt(daysAgo(30)));
      const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
      expect(darks.settingsGroups[0].isExpired).toBe(false);
    });

    it('never flags flats/flat-darks as expired, however old', () => {
      const scope = freshScope('expiry-old-flat');
      const oldName = darkFilenameAt(daysAgo(720)).replace('Dark_', 'Flat_');
      writeFrame(path.join(getArchiveDir(scope), 'Flats'), oldName);
      const flats = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Flats')!;
      expect(flats.settingsGroups[0].capturedAt).not.toBeNull(); // it does know the age...
      expect(flats.settingsGroups[0].isExpired).toBe(false); // ...it just never matters for this type
    });

    it('does not assume expired when the capture date is unknown (falls back to file mtime, which is "now" for a freshly-written file)', () => {
      const scope = freshScope('expiry-unknown-date');
      const dir = path.join(getArchiveDir(scope), 'Bias');
      writeFrame(dir, 'unparseable-manual-name.fit');
      const bias = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Bias')!;
      expect(bias.settingsGroups[0].isExpired).toBe(false);
    });

    it('flags an unparseable file as expired once its own file mtime is old (the fallback still ages out)', () => {
      const scope = freshScope('expiry-unknown-date-old-mtime');
      const dir = path.join(getArchiveDir(scope), 'Bias');
      writeFrame(dir, 'unparseable-manual-name.fit');
      const oldMtime = daysAgo(240);
      fs.utimesSync(path.join(dir, 'unparseable-manual-name.fit'), oldMtime, oldMtime);

      const bias = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Bias')!;
      expect(bias.settingsGroups[0].isExpired).toBe(true);
    });

    it('honors a configured expiry window shorter than the 180-day default', async () => {
      const { updateSettingsData } = await import('../../server/lib/telescopes');
      updateSettingsData({ calibrationExpiryDays: 10 });
      try {
        const scope = freshScope('expiry-configured-short');
        writeFrame(path.join(getArchiveDir(scope), 'Darks'), darkFilenameAt(daysAgo(20)));
        const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
        expect(darks.settingsGroups[0].isExpired).toBe(true);
      } finally {
        // Restore the default so later tests in this file aren't affected.
        updateSettingsData({ calibrationExpiryDays: 180 });
      }
    });

    describe('within a mixed (CALI_FRAME) group', () => {
      it("checks a mixed group's own dark/bias bundles for expiry, resolved from their subfolder, not skipped just because the group is 'mixed'", () => {
        const scope = freshScope('expiry-mixed-dark');
        const dir = path.join(getArchiveDir(scope), 'CALI_FRAME', 'dark', 'cam_0');
        writeFrame(dir, 'dark_exp_30.000000_gain_60_bin_1_22C_stack_6.fits');
        const oldMtime = daysAgo(240);
        fs.utimesSync(path.join(dir, 'dark_exp_30.000000_gain_60_bin_1_22C_stack_6.fits'), oldMtime, oldMtime);

        const mixed = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'CALI_FRAME')!;
        const darkSet = mixed.settingsGroups.find(s => s.frameType === 'dark')!;
        expect(darkSet.isExpired).toBe(true); // Dwarf master filenames carry no timestamp — mtime fallback ages it out
      });

      it("never flags a mixed group's own flat bundle as expired, same as a standalone Flats group", () => {
        const scope = freshScope('expiry-mixed-flat');
        const dir = path.join(getArchiveDir(scope), 'CALI_FRAME', 'flat', 'cam_0');
        writeFrame(dir, 'flat_gain_2_bin_1_ir_1.fits');
        const oldMtime = daysAgo(720);
        fs.utimesSync(path.join(dir, 'flat_gain_2_bin_1_ir_1.fits'), oldMtime, oldMtime);

        const mixed = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'CALI_FRAME')!;
        const flatSet = mixed.settingsGroups.find(s => s.frameType === 'flat')!;
        expect(flatSet.isExpired).toBe(false);
      });

      // Real bug this closes: Dwarf's bias_gain_2_bin_1.fits and
      // flat_gain_2_bin_1.fits (same camera) carry neither an exposure nor a
      // temperature, so without frameType in the bucket key they parsed to
      // an identical settings key and silently merged into one bundle.
      it('does not merge a bias and a flat frame sharing every other setting into one bundle', () => {
        const scope = freshScope('mixed-bias-flat-no-merge');
        writeFrame(path.join(getArchiveDir(scope), 'CALI_FRAME', 'bias', 'cam_1'), 'bias_gain_2_bin_1.fits');
        writeFrame(path.join(getArchiveDir(scope), 'CALI_FRAME', 'flat', 'cam_1'), 'flat_gain_2_bin_1.fits');

        const mixed = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'CALI_FRAME')!;
        const bundles = mixed.settingsGroups.filter(s => s.camera === 'cam_1' && s.gain === 2 && s.binning === 1);
        expect(bundles).toHaveLength(2);
        expect(bundles.map(s => s.frameType).sort()).toEqual(['bias', 'flat']);
        expect(bundles.every(s => s.fileCount === 1)).toBe(true);
      });
    });
  });

  describe('deleteCalibrationBundle', () => {
    function freshScope(name: string): string {
      return createProfile({ name, kind: 'other', connectionType: 'local', localPath: `/tmp/${name}` }).id;
    }

    it('deletes every file in the bundle and reports the count', () => {
      const scope = freshScope('delete-bundle-basic');
      const dir = path.join(getArchiveDir(scope), 'Darks', 'G100_TECm8');
      writeFrame(dir, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
      writeFrame(dir, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191108_2deg_-8.0C_0002.fit');

      const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
      const set = darks.settingsGroups[0];
      expect(set.fileCount).toBe(2);

      const result = deleteCalibrationBundle(scope, 'Darks', set.key);
      expect(result).toEqual({ deleted: 2, failed: 0 });

      const after = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks');
      expect(after).toBeUndefined();
    });

    it('prunes a now-empty per-setting subfolder, but never the type folder itself', () => {
      const scope = freshScope('delete-bundle-prune');
      const typeDir = path.join(getArchiveDir(scope), 'Darks');
      const settingDir = path.join(typeDir, 'G100_TECm8');
      writeFrame(settingDir, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');

      const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
      deleteCalibrationBundle(scope, 'Darks', darks.settingsGroups[0].key);

      expect(fs.existsSync(settingDir)).toBe(false);
      expect(fs.existsSync(typeDir)).toBe(true);
    });

    it('does not prune a subfolder that still holds a different bundle\'s files', () => {
      const scope = freshScope('delete-bundle-shared-folder');
      const settingDir = path.join(getArchiveDir(scope), 'Darks', 'mixed_settings');
      writeFrame(settingDir, 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
      writeFrame(settingDir, 'Dark_120.0s_Bin1_Dark_gain100_20260814-191500_2deg_-8.0C_0001.fit');

      const darks = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === 'Darks')!;
      const sixty = darks.settingsGroups.find(s => s.exposureSec === 60)!;
      deleteCalibrationBundle(scope, 'Darks', sixty.key);

      expect(fs.existsSync(settingDir)).toBe(true);
      expect(fs.readdirSync(settingDir)).toEqual(['Dark_120.0s_Bin1_Dark_gain100_20260814-191500_2deg_-8.0C_0001.fit']);
    });

    it('returns null for a bundle that does not exist', () => {
      const scope = freshScope('delete-bundle-missing');
      expect(deleteCalibrationBundle(scope, 'Darks', 'no-such-key')).toBeNull();
    });
  });
});
