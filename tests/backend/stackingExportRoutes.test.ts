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
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { setFrameReview } from '../../server/lib/frameAnalysis/service';
import { readLightSettings } from '../../server/lib/library/stackingExport';
import { updateSettingsData } from '../../server/lib/telescopes';

const N1 = '2026-09-05';
const N2 = '2026-09-07';

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

async function exportZip(body: unknown): Promise<string[]> {
  const start = await post('/objects/NGC6888/stacking-export', body);
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

describe('sub-frame download (shares the ZIP job)', () => {
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