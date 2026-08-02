import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-capture-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  parseCaptureInfo,
  saveCaptureInfo,
  ingestCaptureInfoFile,
  getCaptureInfoForObject,
  getCaptureInfoForSession,
  summarizeSessionCapture,
  isCaptureInfoSidecar,
  deleteCaptureInfoForSession,
  type CaptureInfoRow,
} from '../../server/lib/library/captureInfo';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';

/** A verbatim sidecar from a real Dwarf 3 library. */
const REAL_SIDECAR = JSON.stringify({
  DEC: 57.487057326572625,
  RA: 21.65051251668246,
  binning: '1*1',
  exp: '60',
  format: 'FITS',
  gain: 60,
  ir: 'Duo-Band',
  maxTemp: 37,
  minTemp: 31,
  shotsStacked: 209,
  shotsTaken: 215,
  shotsToTake: 300,
  target: 'IC 1396',
});

beforeEach(() => {
  db.prepare('DELETE FROM captureInfo').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
});

describe('isCaptureInfoSidecar', () => {
  it('recognizes shotsInfo.json regardless of case', () => {
    expect(isCaptureInfoSidecar('shotsInfo.json')).toBe(true);
    expect(isCaptureInfoSidecar('SHOTSINFO.JSON')).toBe(true);
  });

  it('does not claim other sidecars it cannot parse', () => {
    expect(isCaptureInfoSidecar('notes.txt')).toBe(false);
    expect(isCaptureInfoSidecar('shotsInfo.txt')).toBe(false);
  });
});

describe('parseCaptureInfo', () => {
  it('reads every field a real Dwarf sidecar carries', () => {
    const parsed = parseCaptureInfo(REAL_SIDECAR)!;
    expect(parsed).toEqual({
      // `exp` arrives as a string; stored as a number.
      exposureSec: 60,
      gain: 60,
      filter: 'Duo-Band',
      binning: '1*1',
      framesStacked: 209,
      framesTaken: 215,
      framesPlanned: 300,
      minTempC: 31,
      maxTempC: 37,
      // RA is HOURS as the device writes it (21.65h = 21h39m for IC 1396).
      raHours: 21.65051251668246,
      decDeg: 57.487057326572625,
      target: 'IC 1396',
    });
  });

  it('reports frame counts Nebulis previously could not know at all', () => {
    // "209 kept of 215 taken, out of 300 planned" is not derivable from
    // filenames or FITS headers. It only exists in the sidecar.
    const parsed = parseCaptureInfo(REAL_SIDECAR)!;
    expect(parsed.framesStacked).toBe(209);
    expect(parsed.framesTaken).toBe(215);
    expect(parsed.framesPlanned).toBe(300);
  });

  it('tolerates a numeric exp and a string gain, since firmware may vary', () => {
    const parsed = parseCaptureInfo('{"exp":15,"gain":"60"}')!;
    expect(parsed.exposureSec).toBe(15);
    expect(parsed.gain).toBe(60);
  });

  it('keeps the readable fields when others are malformed', () => {
    const parsed = parseCaptureInfo('{"exp":"60","gain":"not-a-number","ir":""}')!;
    expect(parsed.exposureSec).toBe(60);
    expect(parsed.gain).toBeNull();
    expect(parsed.filter).toBeNull();
  });

  it('returns null for input that is not a JSON object', () => {
    expect(parseCaptureInfo('not json')).toBeNull();
    expect(parseCaptureInfo('[1,2,3]')).toBeNull();
    expect(parseCaptureInfo('"a string"')).toBeNull();
    expect(parseCaptureInfo('null')).toBeNull();
  });

  it('returns null when nothing recognizable is present', () => {
    // An object of unrelated keys must not create an all-null row.
    expect(parseCaptureInfo('{}')).toBeNull();
    expect(parseCaptureInfo('{"unrelated":1}')).toBeNull();
  });
});

describe('storage', () => {
  const base = {
    objectId: 'IC1396',
    sessionDate: '2026-07-05',
    sourceRelPath: 'IC1396/S1/shotsInfo.json',
  };

  it('keys on the session folder so two runs on one night both survive', () => {
    // The real case this exists for: C 5 shot at 60s/gain 60 and again at
    // 120s/gain 40 on the same evening. A night-keyed row loses one.
    saveCaptureInfo({ ...base, ...parseCaptureInfo(REAL_SIDECAR)!, sessionFolder: 'RUN_A' });
    saveCaptureInfo({
      ...base, ...parseCaptureInfo(REAL_SIDECAR)!, sessionFolder: 'RUN_B',
      exposureSec: 120, gain: 40, framesStacked: 20,
    });

    const rows = getCaptureInfoForSession('IC1396', '2026-07-05');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.exposureSec).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([60, 120]);
  });

  it('updates in place on re-import, so growing frame counts move forward', () => {
    saveCaptureInfo({ ...base, ...parseCaptureInfo(REAL_SIDECAR)!, sessionFolder: 'RUN_A' });
    saveCaptureInfo({
      ...base, ...parseCaptureInfo(REAL_SIDECAR)!, sessionFolder: 'RUN_A', framesStacked: 260,
    });
    const rows = getCaptureInfoForObject('IC1396');
    expect(rows).toHaveLength(1);
    expect(rows[0].framesStacked).toBe(260);
  });

  it('keys flat sidecars by stored path so different sessions do not collide', () => {
    const relA = 'IC1396/DWARF_IC1396_2026-07-05_22-00-00_shotsInfo.json';
    const relB = 'IC1396/DWARF_IC1396_2026-07-06_22-00-00_shotsInfo.json';
    fs.mkdirSync(path.join(LIBRARY_DIR, 'IC1396'), { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, relA), REAL_SIDECAR);
    fs.writeFileSync(path.join(LIBRARY_DIR, relB), JSON.stringify({
      ...JSON.parse(REAL_SIDECAR),
      exp: '120',
      gain: 40,
      shotsStacked: 20,
    }));

    expect(ingestCaptureInfoFile('IC1396', relA, '', '2026-07-05')).toBe(true);
    expect(ingestCaptureInfoFile('IC1396', relB, '', '2026-07-06')).toBe(true);

    const rows = getCaptureInfoForObject('IC1396');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.exposureSec).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([60, 120]);
    expect(rows.every(r => r.sessionFolder.startsWith('flat:'))).toBe(true);
  });

  it('drops a night\'s rows when that session is deleted', () => {
    saveCaptureInfo({ ...base, ...parseCaptureInfo(REAL_SIDECAR)!, sessionFolder: 'RUN_A' });
    deleteCaptureInfoForSession('IC1396', '2026-07-05');
    expect(getCaptureInfoForObject('IC1396')).toEqual([]);
  });
});

describe('summarizeSessionCapture', () => {
  const row = (over: Partial<CaptureInfoRow>): CaptureInfoRow => ({
    id: 0, objectId: 'IC1396', sessionFolder: 'S', sessionDate: '2026-07-05',
    exposureSec: 60, gain: 60, filter: 'Duo-Band', binning: '1*1',
    framesStacked: 100, framesTaken: 110, framesPlanned: 300,
    minTempC: 30, maxTempC: 35, raHours: 21.65, decDeg: 57.48,
    target: 'IC 1396', sourceRelPath: null, updatedAt: '', ...over,
  });

  it('returns null when there is nothing recorded', () => {
    expect(summarizeSessionCapture([])).toBeNull();
  });

  it('sums integration per run rather than assuming one exposure', () => {
    // 60s x 100 + 120s x 20 = 8400s. Computing from a single exposure value
    // would be wrong for a night with two runs.
    const summary = summarizeSessionCapture([
      row({}),
      row({ sessionFolder: 'S2', exposureSec: 120, framesStacked: 20 }),
    ])!;
    expect(summary.integrationSec).toBe(60 * 100 + 120 * 20);
    expect(summary.runs).toBe(2);
    expect(summary.framesStacked).toBe(120);
  });

  it('reports exposure and gain only when every run agrees', () => {
    const same = summarizeSessionCapture([row({}), row({ sessionFolder: 'S2' })])!;
    expect(same.exposureSec).toBe(60);
    expect(same.gain).toBe(60);

    const mixed = summarizeSessionCapture([
      row({}),
      row({ sessionFolder: 'S2', exposureSec: 120, gain: 40 }),
    ])!;
    // null means "mixed", not "unknown" — the UI has to distinguish those.
    expect(mixed.exposureSec).toBeNull();
    expect(mixed.gain).toBeNull();
  });

  it('spans the temperature range across runs', () => {
    const summary = summarizeSessionCapture([
      row({ minTempC: 30, maxTempC: 33 }),
      row({ sessionFolder: 'S2', minTempC: 28, maxTempC: 37 }),
    ])!;
    expect(summary.minTempC).toBe(28);
    expect(summary.maxTempC).toBe(37);
  });

  it('survives runs with missing fields', () => {
    const summary = summarizeSessionCapture([
      row({ exposureSec: null, framesStacked: null }),
      row({ sessionFolder: 'S2' }),
    ])!;
    expect(summary.framesStacked).toBe(100);
    expect(summary.integrationSec).toBe(6000);
  });
});

describe('isolation', () => {
  it('runs against its own data dir', () => {
    expect(process.env.DATA_DIR).toBe(TEST_DATA_DIR);
  });
});
