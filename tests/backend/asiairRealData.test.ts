import { describe, it, expect, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-asiair-real-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { parseFilename } from '../../server/lib/telescopeFiles';
import { parseCalibrationFilename } from '../../server/lib/library/calibrationFolders';
import { parseFitsHeader } from '../../server/lib/fitsParser';
import { readLightSettings, rigFromHeader } from '../../server/lib/library/stackingExport';
import { deriveFromFits } from '../../server/lib/library/dateDerivation';
import { matchGroup, pickDark, pickFlat, type CalCandidate, type LightGroupInput } from '../../server/lib/stackingMatch';
import { ASIAIR_FRAMES, writeAsiairFits, type AsiairFrame } from './helpers/asiairFixtures';

/**
 * Import and calibration matching against headers a real ASIAIR wrote (rig and
 * findings in tests/fixtures/asiair/README.md). The other ASIAIR tests use names
 * and stub file contents; these hold the code to what the device actually writes.
 */

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

const dir = path.join(TEST_DATA_DIR, 'frames');
const headerOf = (frame: AsiairFrame) =>
  parseFitsHeader(fs.readFileSync(writeAsiairFits(dir, frame))).values;
const settingsOf = (frame: AsiairFrame) => {
  const abs = writeAsiairFits(dir, frame);
  return readLightSettings(abs, path.basename(abs));
};

describe('ASIAIR file names, as the device writes them', () => {
  it('reads a light with gain and temperature in its name', () => {
    expect(parseFilename(`${ASIAIR_FRAMES.lightH}.fit`)).toMatchObject({
      type: 'sub', target: 'NGC 6888', exposure: '180.0s', filter: 'H', date: '2026-09-12', subIndex: 108,
    });
    expect(parseFilename(`${ASIAIR_FRAMES.lightNone}.fit`)).toMatchObject({
      type: 'sub', target: 'NGC 891', exposure: '150.0s', filter: 'None', subIndex: 79,
    });
  });

  it('reads the older form with neither gain nor temperature, and a camera angle past 180°', () => {
    expect(parseFilename(`${ASIAIR_FRAMES.lightNoGainInName}.fit`)).toMatchObject({
      type: 'sub', target: 'SH2-131', exposure: '180.0s', filter: 'H', date: '2026-08-08', subIndex: 91,
    });
    // Before the night's meridian flip the rotator stood at 184°.
    expect(parseFilename('Light_SH2-131_180.0s_Bin1_H_20260807-223833_184deg_0001.fit')).toMatchObject({
      type: 'sub', target: 'SH2-131', filter: 'H', date: '2026-08-07', subIndex: 1,
    });
  });

  it('reads calibration names: a flat in milliseconds, and darks and bias on the blank slot', () => {
    expect(parseCalibrationFilename(`${ASIAIR_FRAMES.flat}.fit`)).toMatchObject({
      exposureSec: 0.08, binning: 1, gain: 100, filterLabel: 'None', cameraAngleDeg: 4, sensorTempC: -8, sequence: 94,
    });
    expect(parseCalibrationFilename(`${ASIAIR_FRAMES.dark}.fit`)).toMatchObject({
      exposureSec: 120, binning: 1, gain: 100, filterLabel: 'Dark', cameraAngleDeg: 2, sensorTempC: -8, sequence: 9,
    });
    expect(parseCalibrationFilename(`${ASIAIR_FRAMES.bias}.fit`)).toMatchObject({
      exposureSec: 5, gain: 100, filterLabel: 'Dark', cameraAngleDeg: 2,
    });
  });
});

describe('ASIAIR headers', () => {
  it('give each light its filter, exposure, gain, binning and temperature', () => {
    expect(settingsOf('lightH')).toEqual({ filter: 'H', exposureSec: 180, gain: 200, binning: 1, sensorTempC: -8 });
    expect(settingsOf('lightNone')).toEqual({ filter: 'None', exposureSec: 150, gain: 100, binning: 1, sensorTempC: -8 });
  });

  it('fill in what the older names leave out', () => {
    // No gain or temperature in the name; the header has both.
    const s = settingsOf('lightNoGainInName');
    expect(s.gain).toBe(200);
    expect(s.sensorTempC).toBeCloseTo(-9.9, 1);
  });

  it('read underscore decimals from the name when the header lacks exposure and temperature', () => {
    const abs = writeAsiairFits(dir, 'lightH', {
      name: 'Light_NGC 6888_120_0s_Bin1_H_gain200_20260912-041308_3deg_-8_0C_0108',
      drop: ['EXPTIME', 'EXPOSURE', 'CCD-TEMP'],
    });
    const s = readLightSettings(abs, path.basename(abs));
    // These used to read 0 s (so no exposure) and 0 °C.
    expect(s.exposureSec).toBe(120);
    expect(s.sensorTempC).toBe(-8);
  });

  it('name the camera, and the mount as the telescope', () => {
    expect(rigFromHeader(headerOf('lightH'))).toMatchObject({ camera: 'ZWO ASI585MC Air', telescope: 'ZWO AM3N' });
    expect(rigFromHeader(headerOf('flat'))).toMatchObject({ camera: 'ZWO ASI585MC Air', telescope: 'ZWO AM3N' });
  });

  it('date a light in local time: DATE-OBS is UTC, the name is local', () => {
    const abs = writeAsiairFits(dir, 'lightH');
    // 02:10 UTC on 12 September is 04:10 in Paris (summer time); the name says 04:13, when the frame was saved.
    expect(deriveFromFits(abs, 'Europe/Paris')).toMatchObject({ date: '2026-09-12', source: 'fits', time: '041006' });
  });
});

describe('Calibration matching with ASIAIR headers', () => {
  const calibration = (frame: AsiairFrame, type: CalCandidate['type']): CalCandidate => {
    const info = parseCalibrationFilename(`${ASIAIR_FRAMES[frame]}.fit`)!;
    return {
      type, scope: null, folderName: 'Askar 91F', key: frame, name: ASIAIR_FRAMES[frame],
      exposureSec: info.exposureSec ?? null, gain: info.gain ?? null, binning: info.binning ?? null,
      sensorTempC: info.sensorTempC ?? null, filter: type === 'flat' ? info.filterLabel ?? null : null,
      capturedAt: info.capturedAt ?? null, isExpired: false, fileCount: 20, bytes: 0,
      rig: rigFromHeader(headerOf(frame)),
    };
  };
  const group = (frame: AsiairFrame, night: string): LightGroupInput => {
    const s = settingsOf(frame);
    return {
      night, filter: s.filter, exposureSec: s.exposureSec, gain: s.gain, binning: s.binning, sensorTempC: s.sensorTempC,
      scope: null, rig: rigFromHeader(headerOf(frame)),
    };
  };

  const flat = calibration('flat', 'flat');
  const dark120 = calibration('dark', 'dark');
  const bias = calibration('bias', 'bias');

  it('pairs broadband lights with the broadband (None) flats', () => {
    const { pick } = pickFlat(group('lightNone', '2026-11-07'), [flat], [], 1);
    expect(pick?.candidate.key).toBe('flat');
  });

  it('gives dual-band lights no flat from broadband flats', () => {
    // A flat through no filter does not correct a dual-band frame: the light is flagged instead.
    const { pick, issues } = pickFlat(group('lightH', '2026-09-11'), [flat], [], 1);
    expect(pick).toBeNull();
    expect(issues.map(i => i.code)).toContain('no_flat');
  });

  it('pairs darks by exposure and gain, and bias by gain, across the same camera', () => {
    // A 120 s dark at gain 100 suits neither the 150 s nor the 180 s lights.
    expect(pickDark(group('lightNone', '2026-09-23'), [dark120]).pick).toBeNull();
    const lights120 = { ...group('lightNone', '2026-09-23'), exposureSec: 120 };
    expect(pickDark(lights120, [dark120]).pick?.candidate.key).toBe('dark');
    expect(matchGroup(group('lightNone', '2026-09-23'), [bias], [], 1).bias?.candidate.key).toBe('bias');
    // Gain 200 lights get no gain-100 bias.
    expect(matchGroup(group('lightH', '2026-09-11'), [bias], [], 1).bias).toBeNull();
  });
});
