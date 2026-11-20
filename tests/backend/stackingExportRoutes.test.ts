import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-stacking-export-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { setFrameReview } from '../../server/lib/frameAnalysis/service';
import { readLightSettings, rigFromHeader, isPrecalibrated } from '../../server/lib/library/stackingExport';
import { updateSettingsData } from '../../server/lib/telescopes';

const N1 = '2026-09-05';
const N2 = '2026-09-07';
const N3 = '2026-09-10';
const N4 = '2026-09-12';

const card = (k: string, v: string) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80);
const str = (k: string, v: string) => `${k.padEnd(8)}= '${v}'`.padEnd(80);

/** A header-only FITS file with the given cards (the plan never reads pixels). */
function fitsFile(cards: string[]): Buffer {
  let header = [card('SIMPLE', 'T'), card('BITPIX', '16'), ...cards, 'END'.padEnd(80)].join('');
  header = header.padEnd(Math.ceil(header.length / 2880) * 2880);
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.alloc(2880)]);
}

const ASI585 = [card('NAXIS', '2'), card('NAXIS1', '3840'), card('NAXIS2', '2160'), card('XPIXSZ', '2.9'), str('INSTRUME', 'ZWO ASI585MC'), str('TELESCOP', 'Askar 91F')];
const PL9000 = [card('NAXIS', '2'), card('NAXIS1', '3056'), card('NAXIS2', '3056'), card('XPIXSZ', '12'), str('INSTRUME', 'FLI ProLine PL9000'), str('TELESCOP', 'Planewave CDK24')];

/** An M16 light: the remote CCD (pre-calibrated or not) or the user's own ASI585. */
function addM16Light(night: string, name: string, rig: string[], extra: string[] = []) {
  const dir = path.join(LIBRARY_DIR, 'M16');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), fitsFile([
    ...rig, card('EXPTIME', '600'), card('GAIN', '0'), card('XBINNING', '1'), card('CCD-TEMP', '-10'),
    str('FILTER', 'SII'), str('IMAGETYP', 'Light'), ...extra,
  ]));
  recordLibraryFile({ objectId: 'M16', folderName: 'M16', fileName: name, role: 'sub', captureDate: night, captureTime: '223000' });
}

/** A tiny but valid 16-bit FITS light with the acquisition keywords. */
function light(filter: string, temp = -10): Buffer {
  const card = (k: string, v: string) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80);
  let header = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', '8'), card('NAXIS2', '8'),
    card('EXPTIME', '180'), card('GAIN', '200'), card('XBINNING', '1'), card('CCD-TEMP', String(temp)),
    `${'FILTER'.padEnd(8)}= '${filter}'`.padEnd(80), `${'IMAGETYP'.padEnd(8)}= 'Light'`.padEnd(80), 'END'.padEnd(80),
  ].join('');
  header = header.padEnd(Math.ceil(header.length / 2880) * 2880);
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.alloc(2880)]);
}

function addLight(night: string, name: string, filter: string) {
  const dir = path.join(LIBRARY_DIR, 'NGC6888');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), light(filter));
  recordLibraryFile({ objectId: 'NGC6888', folderName: 'NGC6888', fileName: name, role: 'sub', captureDate: night, captureTime: '223000' });
}

/** Calibration frames in the archive, ASIAIR-named, like a synced library. */
function addCal(folder: string, names: string[]) {
  const dir = path.join(LIBRARY_DIR, '_archive', '_unscoped', folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), Buffer.alloc(2880));
}

/** Entry names from a ZIP's central directory. */
function zipNames(buf: Buffer): string[] {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extra + comment;
  }
  return names.sort();
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true });
  stmts.upsertObject.run('NGC6888', 'NGC6888', 0, new Date().toISOString(), 0, null, 'NGC6888', 'Crescent', null, null, null, null, null, null, null);
  for (let i = 1; i <= 3; i++) addLight(N1, `Light_NGC6888_180.0s_Bin1_H_gain200_20260905-22${i}000_-10.0C_000${i}.fit`, 'H');
  for (let i = 1; i <= 2; i++) addLight(N1, `Light_NGC6888_180.0s_Bin1_O_gain200_20260905-23${i}000_-10.0C_000${i}.fit`, 'O');
  for (let i = 1; i <= 2; i++) addLight(N2, `Light_NGC6888_180.0s_Bin1_H_gain200_20260907-22${i}000_-10.0C_000${i}.fit`, 'H');
  // The user rejects one frame; nothing is measured, so every other frame counts as kept.
  setFrameReview('NGC6888/Light_NGC6888_180.0s_Bin1_H_gain200_20260905-223000_-10.0C_0003.fit', 'reject');

  addCal('Darks', [1, 2].map(i => `Dark_180.0s_Bin1_gain200_20260801-10000${i}_-10.2C_000${i}.fit`));
  addCal('Darks', [`Dark_180.0s_Bin1_gain200_20260801-100009_0.0C_0001.fit`]);
  addCal('Bias', [`Bias_0.001s_Bin1_gain200_20260801-110000_-10.0C_0001.fit`]);
  addCal('Flats', [1, 2].map(i => `Flat_1.5s_Bin1_H_gain200_20260906-06000${i}_-10.0C_000${i}.fit`));
  addCal('FlatDarks', [`FlatDark_1.5s_Bin1_gain200_20260906-061000_-10.0C_0001.fit`]);

  // M16: remote CCD lights next to the user's own ASI585 ones, and calibration from the ASI585 only.
  stmts.upsertObject.run('M16', 'M16', 0, new Date().toISOString(), 0, null, 'M16', 'Eagle', null, null, null, null, null, null, null);
  for (let i = 1; i <= 2; i++) addM16Light(N3, `Light_M16_600.0s_Bin1_SII_gain0_20260910-22${i}000_-10.0C_000${i}.fit`, PL9000);
  addM16Light(N3, 'Light_M16_600.0s_Bin1_SII_gain0_20260910-230000_-10.0C_0001.fit', ASI585);
  for (let i = 1; i <= 2; i++) addM16Light(N4, `Light_M16_600.0s_Bin1_SII_gain0_20260912-22${i}000_-10.0C_000${i}.fit`, PL9000, [str('PROC', 'True')]);
  const calDir = path.join(LIBRARY_DIR, '_archive', '_unscoped');
  const addHeaderCal = (folder: string, name: string, cards: string[]) => {
    fs.mkdirSync(path.join(calDir, folder), { recursive: true });
    fs.writeFileSync(path.join(calDir, folder, name), fitsFile(cards));
  };
  addHeaderCal('Darks', 'Dark_600.0s_Bin1_gain0_20260801-120000_-10.0C_0001.fit', ASI585);
  addHeaderCal('Bias', 'Bias_0.001s_Bin1_gain0_20260801-120000_-10.0C_0001.fit', ASI585);
  addHeaderCal('Flats', 'Flat_0.5s_Bin1_SII_gain0_20260911-060000_-10.0C_0001.fit', ASI585);

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 't'; req.userId = 'u'; req.userRole = 'viewer'; next(); });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const post = (url: string, body: unknown) =>
  fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('readLightSettings', () => {
  it('reads the acquisition keywords from the header', () => {
    const file = path.join(LIBRARY_DIR, 'NGC6888', 'Light_NGC6888_180.0s_Bin1_O_gain200_20260905-231000_-10.0C_0001.fit');
    expect(readLightSettings(file, path.basename(file))).toEqual({ filter: 'O', exposureSec: 180, gain: 200, binning: 1, sensorTempC: -10 });
  });

  it('falls back to the ASIAIR filename when there is no header', () => {
    expect(readLightSettings('/nonexistent', 'Light_M 31_120.0s_Bin2_L_gain100_20260905-220000_-5.5C_0001.fit'))
      .toEqual({ filter: 'L', exposureSec: 120, gain: 100, binning: 2, sensorTempC: -5.5 });
  });
});

describe('rig and calibration state from the header', () => {
  it('reads the camera, telescope, sensor and pixel size', () => {
    expect(rigFromHeader({ INSTRUME: 'FLI ProLine PL9000', TELESCOP: 'CDK24', NAXIS1: 1528, NAXIS2: 1528, XBINNING: 2, XPIXSZ: 24 }))
      .toEqual({ camera: 'FLI ProLine PL9000', telescope: 'CDK24', sensorPx: [3056, 3056], pixelUm: 12 });
    expect(rigFromHeader({ EXPTIME: 60 })).toBeNull();
  });

  it('spots lights a pipeline already calibrated', () => {
    expect(isPrecalibrated({ PROC: 'True' })).toBe(true);
    expect(isPrecalibrated({ PROC: true })).toBe(true);
    expect(isPrecalibrated({ CALSTAT: 'BDF' })).toBe(true);
    expect(isPrecalibrated({ PROC: 'False' })).toBe(false);
    expect(isPrecalibrated({})).toBe(false);
  });
});

describe('stacking export plan', () => {
  it('groups lights per night and filter, applies Keep, and matches calibration', async () => {
    const res = await post('/objects/NGC6888/stacking-export/plan', { dates: [N2, N1] });
    expect(res.status).toBe(200);
    const plan = (await res.json()).data;
    expect(plan.nights).toEqual([N1, N2]);
    expect(plan.groups.map((g: { night: string; filter: string; frames: number; kept: number }) => [g.night, g.filter, g.frames, g.kept]))
      .toEqual([[N1, 'H', 3, 2], [N1, 'O', 2, 2], [N2, 'H', 2, 2]]);
    expect(plan.totals).toMatchObject({ lights: 6, excluded: 1 });
    // Nothing has been analyzed yet, so the dialog can offer to measure both nights.
    expect(plan.unmeasuredByNight).toEqual({ [N1]: 5, [N2]: 2 });

    const [h1, o1, h2] = plan.groups;
    expect(h1.dark).toMatchObject({ type: 'dark', fileCount: 2, deltaTempC: 0.2 });
    expect(h1.flat).toMatchObject({ type: 'flat', filter: 'H', deltaDays: 0, source: 'matched' });
    expect(h1.flatDark).toMatchObject({ type: 'flatDark', exposureSec: 1.5 });
    expect(h1.bias).toMatchObject({ type: 'bias' });
    expect(h1.issues).toEqual([]);
    // No O flats anywhere.
    expect(o1.flat).toBeNull();
    expect(o1.issues).toEqual([{ code: 'no_flat', severity: 'error', params: { filter: 'O' } }]);
    // The H flats were shot after night 1; for night 2 they are a day off.
    expect(h2.issues).toEqual([expect.objectContaining({ code: 'flat_other_night', severity: 'warning' })]);
  });

  it('matches calibration to the lights\' own camera only', async () => {
    const plan = (await (await post('/objects/M16/stacking-export/plan', { dates: [N3] })).json()).data;
    const byCamera = Object.fromEntries(plan.groups.map((g: { camera: string }) => [g.camera, g]));
    expect(Object.keys(byCamera).sort()).toEqual(['FLI ProLine PL9000', 'ZWO ASI585MC']);

    const remote = byCamera['FLI ProLine PL9000'];
    expect(remote).toMatchObject({ frames: 2, precalibrated: false, dark: null, flat: null, bias: null });
    expect(remote.issues).toEqual([
      { code: 'no_dark', severity: 'error' },
      { code: 'no_flat', severity: 'error', params: { filter: 'SII' } },
    ]);

    const own = byCamera['ZWO ASI585MC'];
    expect(own.dark).toMatchObject({ exposureSec: 600, gain: 0 });
    expect(own.flat).toMatchObject({ filter: 'SII' });
    expect(own.bias).toMatchObject({ gain: 0 });
    expect(plan.totals.errors).toBe(2);
  });

  it('leaves calibration out for lights already calibrated', async () => {
    const fromHeader = (await (await post('/objects/M16/stacking-export/plan', { dates: [N4] })).json()).data;
    expect(fromHeader.groups).toEqual([expect.objectContaining({ precalibrated: true, dark: null, flat: null, flatDark: null, bias: null, issues: [] })]);
    expect(fromHeader.totals).toMatchObject({ calibrationFrames: 0, errors: 0 });

    const asked = (await (await post('/objects/M16/stacking-export/plan', { dates: [N3], precalibrated: true })).json()).data;
    expect(asked.precalibrated).toBe(true);
    expect(asked.groups.every((g: { precalibrated: boolean; issues: unknown[] }) => g.precalibrated && g.issues.length === 0)).toBe(true);
    expect(asked.totals).toMatchObject({ lights: 3, calibrationFrames: 0, errors: 0 });
  });

  it('can include the subs that are not kept', async () => {
    const plan = (await (await post('/objects/NGC6888/stacking-export/plan', { dates: [N1], includeNotKept: true })).json()).data;
    expect(plan.totals).toMatchObject({ lights: 5, excluded: 0 });
  });

  it('validates the request', async () => {
    expect((await post('/objects/NGC6888/stacking-export/plan', { dates: [] })).status).toBe(422);
    expect((await post('/objects/NGC6888/stacking-export/plan', { dates: ['5 Sept'] })).status).toBe(422);
    expect((await post('/objects/nope/stacking-export/plan', { dates: [N1] })).status).toBe(404);
  });
});

async function exportZip(body: unknown, objectId = 'NGC6888'): Promise<string[]> {
  const start = await post(`/objects/${objectId}/stacking-export`, body);
  expect(start.status).toBe(200);
  const { jobId } = (await start.json()).data;
  let status: { status: string; token?: string } = { status: 'running' };
  for (let i = 0; i < 100 && status.status === 'running'; i++) {
    await new Promise(r => setTimeout(r, 30));
    status = (await (await fetch(`${baseUrl}/download/status/${jobId}`)).json()).data;
  }
  expect(status.status).toBe('done');
  const zip = Buffer.from(await (await fetch(`${baseUrl}/download/tmp/${status.token}`)).arrayBuffer());
  return zipNames(zip);
}

describe('stacking export ZIP', () => {
  it('lays one night out for WBPP with its calibration, README and manifest', async () => {
    const names = await exportZip({ dates: [N1], layout: 'wbpp' });
    const root = `NGC6888_${N1}_wbpp`;
    expect(names).toEqual([
      `${root}/Bias/Bias_0.001s_Bin1_gain200_-10C/Bias_0.001s_Bin1_gain200_20260801-110000_-10.0C_0001.fit`,
      `${root}/Darks/Darks_180s_Bin1_gain200_-10.2C/Dark_180.0s_Bin1_gain200_20260801-100001_-10.2C_0001.fit`,
      `${root}/Darks/Darks_180s_Bin1_gain200_-10.2C/Dark_180.0s_Bin1_gain200_20260801-100002_-10.2C_0002.fit`,
      `${root}/FlatDarks/NIGHT_${N1}/FILTER_H/FlatDark_1.5s_Bin1_gain200_20260906-061000_-10.0C_0001.fit`,
      `${root}/Flats/NIGHT_${N1}/FILTER_H/Flat_1.5s_Bin1_H_gain200_20260906-060001_-10.0C_0001.fit`,
      `${root}/Flats/NIGHT_${N1}/FILTER_H/Flat_1.5s_Bin1_H_gain200_20260906-060002_-10.0C_0002.fit`,
      `${root}/Lights/NIGHT_${N1}/FILTER_H/Light_NGC6888_180.0s_Bin1_H_gain200_20260905-221000_-10.0C_0001.fit`,
      `${root}/Lights/NIGHT_${N1}/FILTER_H/Light_NGC6888_180.0s_Bin1_H_gain200_20260905-222000_-10.0C_0002.fit`,
      `${root}/Lights/NIGHT_${N1}/FILTER_O/Light_NGC6888_180.0s_Bin1_O_gain200_20260905-231000_-10.0C_0001.fit`,
      `${root}/Lights/NIGHT_${N1}/FILTER_O/Light_NGC6888_180.0s_Bin1_O_gain200_20260905-232000_-10.0C_0002.fit`,
      `${root}/README.txt`,
      `${root}/manifest.json`,
      `${root}/not-kept.txt`,
    ].sort());
  });

  it('gives Siril one folder per night and filter with lights, darks, flats and biases', async () => {
    const names = await exportZip({ dates: [N1, N2], layout: 'siril' });
    const root = 'NGC6888_2-nights_siril';
    const folders = [...new Set(names.filter(n => n.split('/').length === 4).map(n => n.split('/').slice(1, 3).join('/')))].sort();
    expect(folders).toEqual([
      `${N1}_H/biases`, `${N1}_H/darks`, `${N1}_H/flats`, `${N1}_H/lights`,
      `${N1}_O/biases`, `${N1}_O/darks`, `${N1}_O/lights`,
      `${N2}_H/biases`, `${N2}_H/darks`, `${N2}_H/flats`, `${N2}_H/lights`,
    ]);
    // Flat darks stand in for bias in biases/ when there are any.
    expect(names).toContain(`${root}/${N1}_H/biases/FlatDark_1.5s_Bin1_gain200_20260906-061000_-10.0C_0001.fit`);
    expect(names).toContain(`${root}/${N1}_O/biases/Bias_0.001s_Bin1_gain200_20260801-110000_-10.0C_0001.fit`);
  });
});

describe('stacking export ZIP of pre-calibrated lights', () => {
  it('holds the lights and no calibration frames', async () => {
    const names = await exportZip({ dates: [N4], layout: 'wbpp' }, 'M16');
    const root = `M16_${N4}_wbpp`;
    expect(names).toEqual([
      `${root}/Lights/NIGHT_${N4}/FILTER_SII/Light_M16_600.0s_Bin1_SII_gain0_20260912-221000_-10.0C_0001.fit`,
      `${root}/Lights/NIGHT_${N4}/FILTER_SII/Light_M16_600.0s_Bin1_SII_gain0_20260912-222000_-10.0C_0002.fit`,
      `${root}/README.txt`,
      `${root}/manifest.json`,
    ]);
  });
});

describe('sub-frame download (shares the ZIP job)', () => {
  it('fails only the job, not the server, when the temp folder cannot be written', async () => {
    // A Writable with no 'error' listener used to turn this into an uncaught exception that ends the process.
    // Vitest reports an uncaught exception as a failure, so surviving to the assertions is part of the check.
    const tmp = vi.spyOn(os, 'tmpdir').mockReturnValue(path.join(TEST_DATA_DIR, 'missing-tmp-dir'));
    try {
      const start = await post('/download/objects/NGC6888/subframes', { dates: [N2] });
      expect(start.status).toBe(200);
      const { jobId } = (await start.json()).data;
      let status: { status: string; error?: string } = { status: 'running' };
      for (let i = 0; i < 100 && status.status === 'running'; i++) {
        await new Promise(r => setTimeout(r, 30));
        status = (await (await fetch(`${baseUrl}/download/status/${jobId}`)).json()).data;
      }
      expect(status.status).toBe('error');
      expect(status.error).toBeTruthy();
    } finally {
      tmp.mockRestore();
    }
  });

  it('leaves out a rejected frame when keptOnly is set', async () => {
    const run = async (body: Record<string, unknown>) => {
      const start = await post('/download/objects/NGC6888/subframes', { dates: [N1], filters: ['H'], ...body });
      expect(start.status).toBe(200);
      return (await start.json()).data.filesTotal as number;
    };
    expect(await run({})).toBe(3);
    expect(await run({ keptOnly: true })).toBe(2);
  });

  it('still zips a night\'s subs, flattened for Siril', async () => {
    const start = await post('/download/objects/NGC6888/subframes', { dates: [N2], sirilLayout: true });
    expect(start.status).toBe(200);
    const { jobId, filesTotal } = (await start.json()).data;
    expect(filesTotal).toBe(2);
    let status: { status: string; token?: string } = { status: 'running' };
    for (let i = 0; i < 100 && status.status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 30));
      status = (await (await fetch(`${baseUrl}/download/status/${jobId}`)).json()).data;
    }
    const zip = Buffer.from(await (await fetch(`${baseUrl}/download/tmp/${status.token}`)).arrayBuffer());
    expect(zipNames(zip)).toEqual([
      'NGC6888/lights/Light_NGC6888_180.0s_Bin1_H_gain200_20260907-221000_-10.0C_0001.fit',
      'NGC6888/lights/Light_NGC6888_180.0s_Bin1_H_gain200_20260907-222000_-10.0C_0002.fit',
    ]);
  });
});