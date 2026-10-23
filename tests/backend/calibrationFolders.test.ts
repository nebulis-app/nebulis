import { describe, it, expect } from 'vitest';
import {
  calibrationTypeForFolderName,
  calibrationTypeLabel,
  dwarfCameraFromRelPath,
  dwarfDarkSessionFolderInfo,
  isCalibrationFolderName,
  parseCalibrationFilename,
  CALIBRATION_FOLDER_NAMES,
} from '../../server/lib/library/calibrationFolders';

describe('calibrationTypeForFolderName', () => {
  it('recognizes singular and plural bias/dark/flat folder names, case-insensitively', () => {
    expect(calibrationTypeForFolderName('Bias')).toBe('bias');
    expect(calibrationTypeForFolderName('bias')).toBe('bias');
    expect(calibrationTypeForFolderName('Biases')).toBe('bias');
    expect(calibrationTypeForFolderName('Dark')).toBe('dark');
    expect(calibrationTypeForFolderName('Darks')).toBe('dark');
    expect(calibrationTypeForFolderName('DARKS')).toBe('dark');
    expect(calibrationTypeForFolderName('Flat')).toBe('flat');
    expect(calibrationTypeForFolderName('Flats')).toBe('flat');
  });

  it('recognizes every flat-dark folder name variant', () => {
    for (const name of [
      'FlatDark', 'FlatDarks', 'Flat_Dark', 'Flat_Darks', 'Flat-Dark', 'Flat-Darks',
      'DarkFlat', 'DarkFlats', 'Dark_Flat', 'Dark_Flats', 'Dark-Flat', 'Dark-Flats',
    ]) {
      expect(calibrationTypeForFolderName(name)).toBe('flatDark');
    }
  });

  it('treats Dwarf\'s DWARF_DARK as a dark folder and CALI_FRAME as mixed', () => {
    expect(calibrationTypeForFolderName('DWARF_DARK')).toBe('dark');
    expect(calibrationTypeForFolderName('CALI_FRAME')).toBe('mixed');
    expect(calibrationTypeForFolderName('cali_frame')).toBe('mixed');
  });

  it('returns null for ordinary object folders, including ones that merely contain the word', () => {
    expect(calibrationTypeForFolderName('M31')).toBeNull();
    expect(calibrationTypeForFolderName('Dark Nebulae Targets')).toBeNull();
    expect(calibrationTypeForFolderName('Darkness')).toBeNull();
  });

  it('isCalibrationFolderName agrees with calibrationTypeForFolderName', () => {
    expect(isCalibrationFolderName('Darks')).toBe(true);
    expect(isCalibrationFolderName('M31')).toBe(false);
  });

  it('CALIBRATION_FOLDER_NAMES covers every name the function recognizes', () => {
    for (const name of ['bias', 'darks', 'flats', 'flatdark', 'dwarf_dark', 'cali_frame']) {
      expect(CALIBRATION_FOLDER_NAMES).toContain(name);
    }
  });
});

describe('calibrationTypeLabel', () => {
  it('gives each type a human-facing label', () => {
    expect(calibrationTypeLabel('bias')).toBe('Bias');
    expect(calibrationTypeLabel('dark')).toBe('Darks');
    expect(calibrationTypeLabel('flat')).toBe('Flats');
    expect(calibrationTypeLabel('flatDark')).toBe('Flat darks');
    expect(calibrationTypeLabel('mixed')).toBe('Calibration (mixed)');
  });
});

describe('parseCalibrationFilename', () => {
  it('parses the ASIAIR-style bias filename shown in the real library (dot decimals)', () => {
    const info = parseCalibrationFilename('Bias_5.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit');
    expect(info).toEqual({
      exposureSec: 5.0,
      binning: 1,
      filterLabel: 'Dark',
      gain: 100,
      cameraAngleDeg: 2,
      sensorTempC: -8.0,
      sequence: 1,
      capturedAt: new Date('2026-08-15T19:32:19').toISOString(),
    });
  });

  it('parses a dark filename with a decimal exposure and negative sensor temp', () => {
    const info = parseCalibrationFilename('Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-7.7C_0001.fit');
    expect(info?.exposureSec).toBe(60.0);
    expect(info?.sensorTempC).toBe(-7.7);
    expect(info?.sequence).toBe(1);
  });

  // ASIAIR calibration frames follow the exact same naming convention as its
  // light frames — telescopeFiles.ts's parseFilename validated this shape
  // against real captured hardware (see tests/backend/telescopeFiles.test.ts).
  // The two quirks confirmed there apply here too: decimal points come out as
  // underscores, and the `_<n>deg_` field is Camera Angle, not a temperature.

  it('parses underscore-as-decimal exposure and temperature, matching real ASIAIR output', () => {
    const info = parseCalibrationFilename('Dark_120_0s_Bin1_None_gain100_20260904-051928_2deg_-8_0C_0207.fit');
    expect(info?.exposureSec).toBe(120.0);
    expect(info?.sensorTempC).toBe(-8.0);
    expect(info?.cameraAngleDeg).toBe(2);
    expect(info?.sequence).toBe(207);
    expect(info?.filterLabel).toBe('None');
  });

  it('converts a millisecond exposure to seconds', () => {
    const info = parseCalibrationFilename('Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit');
    expect(info?.exposureSec).toBe(0.001);
    expect(info?.filterLabel).toBe('S');
    expect(info?.sensorTempC).toBe(-10.5);
  });

  it('parses a minimal filename with no filter, gain, angle, or temperature', () => {
    // Real example straight from telescopeFiles.ts's ASIAIR docs.
    const info = parseCalibrationFilename('Dark_60s_Bin1_20250723-13073265_0018.fit');
    expect(info?.exposureSec).toBe(60);
    expect(info?.binning).toBe(1);
    expect(info?.gain).toBeUndefined();
    expect(info?.filterLabel).toBeUndefined();
    expect(info?.sensorTempC).toBeUndefined();
    expect(info?.cameraAngleDeg).toBeUndefined();
  });

  it('skips an ASI Camera Model token and still finds gain and filter correctly', () => {
    const info = parseCalibrationFilename('Dark_180s_Bin1_R_6200MC_gain100_20111128-080808_180deg_-20C_0001.fit');
    expect(info?.filterLabel).toBe('R');
    expect(info?.gain).toBe(100);
    expect(info?.cameraAngleDeg).toBe(180);
    expect(info?.sensorTempC).toBe(-20);
  });

  it('returns null for a filename that does not match the pattern', () => {
    expect(parseCalibrationFilename('random-file.txt')).toBeNull();
    expect(parseCalibrationFilename('Stacked_150_M42_10.0s_IRCUT_20241015-210530A.fit')).toBeNull();
  });

  // Confirmed against a real Dwarf 3 export
  // (Astronomy/CALI_FRAME/{bias,dark,flat}/cam_{0,1}/...), a completely
  // different convention from ASIAIR's — no timestamp, gain/bin spelled with
  // underscores, and a bare (unsigned) ambient temperature rather than a TEC
  // setpoint.
  it('parses a Dwarf dark filename (exp/gain/bin/temp, plus its own stack count)', () => {
    const info = parseCalibrationFilename('dark_exp_30.000000_gain_60_bin_1_22C_stack_6.fits');
    expect(info).toMatchObject({ exposureSec: 30, gain: 60, binning: 1, sensorTempC: 22, stackCount: 6 });
    expect(info?.camera).toBeUndefined();
  });

  it('parses a Dwarf bias filename with no exposure or temperature', () => {
    const info = parseCalibrationFilename('bias_gain_2_bin_1.fits');
    expect(info).toMatchObject({ gain: 2, binning: 1 });
    expect(info?.exposureSec).toBeUndefined();
    expect(info?.sensorTempC).toBeUndefined();
    expect(info?.stackCount).toBeUndefined();
  });

  it('parses a Dwarf flat filename, folding its IR-cut position into filterLabel', () => {
    const plain = parseCalibrationFilename('flat_gain_2_bin_1.fits');
    expect(plain).toMatchObject({ gain: 2, binning: 1 });
    expect(plain?.filterLabel).toBeUndefined();

    const withIr = parseCalibrationFilename('flat_gain_2_bin_1_ir_1.fits');
    expect(withIr).toMatchObject({ gain: 2, binning: 1, filterLabel: 'IR1' });
  });

  it('handles a Dwarf dark exposure with no fractional part', () => {
    const info = parseCalibrationFilename('dark_exp_120.000000_gain_60_bin_1_29C_stack_1.fits');
    expect(info).toMatchObject({ exposureSec: 120, gain: 60, binning: 1, sensorTempC: 29, stackCount: 1 });
  });

  // Confirmed against a real export where one Dwarf 3 had accumulated both
  // DWARF_DARK (older firmware, raw unstacked subs) and CALI_FRAME (newer
  // firmware, pre-stacked masters) — a third, distinct convention from
  // either of the above, with no `bias_`/`dark_`/`flat_`/`_Bin` prefix at
  // all and no camera/binning token in the filename itself (see
  // `dwarfDarkSessionFolderInfo` for those).
  it('parses a Dwarf DWARF_DARK raw sub-frame filename', () => {
    const info = parseCalibrationFilename('raw_60s_60_0009_20250619-225727031_37C.fits');
    expect(info).toMatchObject({ exposureSec: 60, gain: 60, sequence: 9, sensorTempC: 37 });
    expect(info?.capturedAt).toBe(new Date('2025-06-19T22:57:27').toISOString());
    expect(info?.binning).toBeUndefined();
    expect(info?.camera).toBeUndefined();
  });

  it('parses a Dwarf DWARF_DARK filename with a sub-second timestamp suffix and no leading zero stripped from sequence', () => {
    const info = parseCalibrationFilename('raw_30s_60_0000_20250724-234357539_22C.fits');
    expect(info).toMatchObject({ exposureSec: 30, gain: 60, sequence: 0, sensorTempC: 22 });
  });

  // SeeStar's own dark library (`darklibrary/` at the share root), from a real S50.
  it('parses a SeeStar dark-library master: exposure, sensor temperature and capture time', () => {
    const info = parseCalibrationFilename('MasterDark_5_30.0s_26.0C_20261014-192837.fit');
    expect(info).toMatchObject({ exposureSec: 30, sensorTempC: 26 });
    expect(info?.capturedAt).toBe(new Date('2026-10-14T19:28:37').toISOString());
    // The leading number's meaning is unconfirmed, so it is not read as gain or a stack count.
    expect(info?.gain).toBeUndefined();
    expect(info?.stackCount).toBeUndefined();
    expect(info?.binning).toBeUndefined();
  });

  it('reads the SeeStar master preview the same way, and a negative temperature', () => {
    expect(parseCalibrationFilename('MasterDark_5_30.0s_26.0C_20261014-192837.jpg')).toMatchObject({ exposureSec: 30, sensorTempC: 26 });
    expect(parseCalibrationFilename('MasterDark_3_10s_-2.5C_20260101-010203.fit')).toMatchObject({ exposureSec: 10, sensorTempC: -2.5 });
  });
});

describe('dwarfDarkSessionFolderInfo', () => {
  it('reads camera and binning from a real DWARF_DARK session folder name', () => {
    expect(dwarfDarkSessionFolderInfo('tele_exp_60_gain_60_bin_1_2025-06-19-22-47-27-957')).toEqual({ camera: 'tele', binning: 1 });
    expect(dwarfDarkSessionFolderInfo('wide_exp_30_gain_60_bin_1_2025-07-24-23-43-28-522')).toEqual({ camera: 'wide', binning: 1 });
  });

  it('returns null for a CALI_FRAME type-folder name, which has no exp/gain/bin shape', () => {
    expect(dwarfDarkSessionFolderInfo('dark')).toBeNull();
    expect(dwarfDarkSessionFolderInfo('bias')).toBeNull();
  });

  it('returns null for an ordinary folder name', () => {
    expect(dwarfDarkSessionFolderInfo('G100_TECm8')).toBeNull();
  });
});

describe('dwarfCameraFromRelPath', () => {
  it('reads the cam_N token from a Dwarf calibration file\'s relative path', () => {
    expect(dwarfCameraFromRelPath('cam_0/dark_exp_30.000000_gain_60_bin_1_22C_stack_6.fits')).toBe('cam_0');
    expect(dwarfCameraFromRelPath('cam_1/bias_gain_2_bin_1.fits')).toBe('cam_1');
  });

  it('is case-insensitive but normalizes to lowercase', () => {
    expect(dwarfCameraFromRelPath('CAM_0/bias_gain_2_bin_1.fits')).toBe('cam_0');
  });

  it('returns undefined for a file with no cam_N parent folder', () => {
    expect(dwarfCameraFromRelPath('bias_gain_2_bin_1.fits')).toBeUndefined();
    expect(dwarfCameraFromRelPath('G100_TECm8/Bias_5.0s_Bin1_..._0001.fit')).toBeUndefined();
  });

  it('only looks at the immediate parent folder, not any ancestor', () => {
    expect(dwarfCameraFromRelPath('cam_0/2026-08-15/frame.fit')).toBeUndefined();
  });
});
