import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { aduStep, measureFrame } from '../../server/lib/frameAnalysis/measure';
import { magnitudesBrighter, skyFromDark, storedUnitsPerAdu } from '../../server/lib/frameAnalysis/skyBackground';
import { darkLevelFor } from '../../server/lib/frameAnalysis/darkLevel';
import { nightSky } from '../../server/lib/frameAnalysis/service';

/**
 * Synthetic raw frames from a 12-bit colour camera stored in 16 bits, like the ASI585MC: each stored value is the
 * camera's own ADU times 16. The camera reads `offsetAdu` with the shutter closed, and the sky adds its electrons at
 * EGAIN electrons per camera ADU. A few stars sit on top, and the noise is the sky's own.
 */
const EGAIN = 3.57;
const STEP = 16;
const OFFSET_ADU = 15; // the camera's own units; stored as 15 × 16 = 240
const W = 320, H = 240;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function card(key: string, value: string | number): string {
  const v = typeof value === 'number' ? String(value).padStart(20) : `'${value.padEnd(8)}'`;
  return `${key.padEnd(8)}= ${v}`.padEnd(80);
}

/** A 16-bit FITS with the given header cards and a background of `skyElectronsPerSecond` over `exposure` seconds. */
function frame(opts: { skyElectronsPerSecond: number; exposure: number; seed?: number; stars?: boolean; type?: string; offset?: number }): Buffer {
  const random = rng(opts.seed ?? 1);
  const cards = [
    `SIMPLE  = ${'T'.padStart(20)}`.padEnd(80), card('BITPIX', 16), card('NAXIS', 2), card('NAXIS1', W), card('NAXIS2', H),
    card('BZERO', 32768), card('BSCALE', 1), card('EXPTIME', opts.exposure), card('EGAIN', EGAIN), card('GAIN', 100),
    card('OFFSET', opts.offset ?? 15), card('CCD-TEMP', -8), card('INSTRUME', 'ZWO ASI585MC Air'), card('IMAGETYP', opts.type ?? 'Light'),
    card('XBINNING', 1), card('XPIXSZ', 2.9), card('FOCALLEN', 609),
    'END'.padEnd(80),
  ];
  let header = cards.join('');
  header = header.padEnd(Math.ceil(header.length / 2880) * 2880, ' ');
  const data = Buffer.alloc(Math.ceil((W * H * 2) / 2880) * 2880);
  const skyAdu = (opts.skyElectronsPerSecond * opts.exposure) / EGAIN; // camera ADU
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let adu = OFFSET_ADU + skyAdu + (random() - 0.5) * 2 * Math.sqrt(Math.max(1, skyAdu));
      if (opts.stars !== false && x % 40 === 20 && y % 40 === 20) adu += 800;
      const stored = Math.max(0, Math.min(4095, Math.round(adu))) * STEP;
      data.writeInt16BE(stored - 32768, (y * W + x) * 2);
    }
  }
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-sky-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
function write(name: string, buf: Buffer): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buf);
  return p;
}

describe('the ADU step', () => {
  it('is the lowest bit any value sets', () => {
    const values = [240, 1600, 3232, 65520];
    expect(aduStep(i => values[i], 0, 1, values.length)).toBe(16);
    expect(aduStep(i => [12, 400, 1004][i], 0, 1, 3)).toBe(4);
    expect(aduStep(i => [12, 401][i], 0, 1, 2)).toBe(1);
    expect(aduStep(() => 0, 0, 1, 5)).toBeNull();
  });

  it('is read from a real-shaped 12-bit frame', () => {
    const m = measureFrame(frame({ skyElectronsPerSecond: 1, exposure: 150 }));
    expect(m.sensor).toMatchObject({ aduStep: 16, electronsPerAdu: EGAIN, exposureSec: 150, gain: 100, offset: 15, temperatureC: -8, binning: 1 });
  });
});

describe('the absolute sky background', () => {
  const sensor = (o: Partial<NonNullable<Parameters<typeof skyFromDark>[0]['sensor']>> = {}) => ({
    exposureSec: 150, electronsPerAdu: 3.57, gain: 100, offset: 15, temperatureC: -8, aduStep: 4, binning: 2, ...o,
  });

  it("scales stored ADU by the camera's converter depth, not by the step seen in the data", () => {
    // The ASI585MC has a 12-bit converter: 16 stored units per ADU, though its data comes in steps of 4.
    expect(storedUnitsPerAdu('ZWO ASI585MC Air', 4)).toBe(16);
    expect(storedUnitsPerAdu('ZWO ASI2600MM Pro', 1)).toBe(1);
    expect(storedUnitsPerAdu('ZWO ASI294MC Pro', 4)).toBe(4);
    expect(storedUnitsPerAdu('Unknown cam', 1)).toBe(1); // every value used: 16-bit data
    expect(storedUnitsPerAdu('Unknown cam', 4)).toBeNull();
    expect(storedUnitsPerAdu(null, null)).toBeNull();
  });

  it('works out ADU and electrons per second from stored ADU, a dark level, EGAIN per camera ADU and the exposure', () => {
    const sky = skyFromDark({ background: 2000, rig: { camera: 'ZWO ASI585MC Air', focal: null, scale: 2 }, sensor: sensor() }, 240, 'Darks_150s')!;
    expect(sky.aduPerSecond).toBeCloseTo((2000 - 240) / 150, 4);
    expect(sky.electronsPerSecond).toBeCloseTo(((2000 - 240) * (3.57 / 16)) / 150, 4);
    // Scale 2"/grid px on a 2×2-binned grid: 1" per sensor pixel, so per arcsec² is the same number.
    expect(sky.electronsPerSecondPerArcsec2).toBeCloseTo(sky.electronsPerSecond!, 4);
    expect(sky).toMatchObject({ darkLevel: 240, darkBundle: 'Darks_150s' });
  });

  it('gives ADU only when the depth or EGAIN is unknown, nothing without an exposure, and never goes below zero', () => {
    const base = { background: 300, rig: { camera: 'Unknown cam', focal: null, scale: null } };
    expect(skyFromDark({ ...base, sensor: sensor({ exposureSec: null }) }, 240, 'x')).toBeNull();
    expect(skyFromDark({ ...base, sensor: sensor() }, 240, 'x')).toMatchObject({ aduPerSecond: 0.4, electronsPerSecond: null });
    expect(skyFromDark({ ...base, rig: { ...base.rig, camera: 'ZWO ASI585MC Air' }, sensor: sensor({ electronsPerAdu: null }) }, 240, 'x')!.electronsPerSecond).toBeNull();
    expect(skyFromDark({ ...base, sensor: sensor() }, 400, 'x')!.aduPerSecond).toBe(0);
  });

  it('recovers the sky put into synthetic frames, within 3 %, and how much brighter a moonlit one is', () => {
    const dark = measureFrame(frame({ skyElectronsPerSecond: 0, exposure: 150, stars: false, type: 'Dark' })).background;
    for (const [eps, seed] of [[0.6, 2], [6, 3]] as const) {
      const m = measureFrame(frame({ skyElectronsPerSecond: eps, exposure: 150, seed }));
      const sky = skyFromDark(m, dark, 'Darks')!;
      expect(Math.abs(sky.electronsPerSecond! - eps) / eps).toBeLessThan(0.03);
    }
    // Ten times the light is 2.5 magnitudes.
    expect(magnitudesBrighter(6, 0.6)).toBeCloseTo(2.5, 2);
    expect(magnitudesBrighter(0, 0.6)).toBeNull();
  });
});

describe('the night summary', () => {
  const sky = (eps: number) => ({ aduPerSecond: eps * 4, electronsPerSecond: eps, electronsPerSecondPerArcsec2: eps / 2, darkLevel: 240, darkBundle: 'D' });

  it('compares tonight with the darkest other night of the same set, by medians', () => {
    const others = [
      ...[0.5, 0.6, 0.55].map(e => ({ night: '2026-09-12', metrics: { sky: sky(e) } })),
      ...[2, 2.2, 2.1].map(e => ({ night: '2026-09-24', metrics: { sky: sky(e) } })),
      { night: '2026-09-30', metrics: { sky: null } },
    ];
    const s = nightSky([sky(5), sky(5.5), sky(6)], others)!;
    expect(s).toMatchObject({ aduPerSecond: 22, electronsPerSecond: 5.5, electronsPerSecondPerArcsec2: 2.75, frames: 3, darkest: { night: '2026-09-12', aduPerSecond: 2.2 } });
    expect(s.magnitudesBrighter).toBeCloseTo(2.5, 2);
  });

  it('says tonight is the darkest when no other night is darker, and nothing without values', () => {
    expect(nightSky([sky(0.4)], [{ night: '2026-09-12', metrics: { sky: sky(0.6) } }])!.magnitudesBrighter).toBe(0);
    expect(nightSky([sky(0.4)], [])!.darkest).toBeNull();
    expect(nightSky([], [])).toBeNull();
  });
});

describe('the matching dark', () => {
  const lightPath = write('Light_NGC 891_150.0s_Bin1_None_gain100_20260924-051013_6deg_-8.0C_0079.fit', frame({ skyElectronsPerSecond: 2, exposure: 150 }));
  const darkPath = write('Dark_150.0s_Bin1_Dark_gain100_20260814-213622_2deg_-8.0C_0009.fit', frame({ skyElectronsPerSecond: 0, exposure: 150, stars: false, type: 'Dark' }));
  const otherOffset = write('Dark_150.0s_Bin1_Dark_gain100_offset30_-8.0C_0001.fit', frame({ skyElectronsPerSecond: 0, exposure: 150, stars: false, type: 'Dark', offset: 30 }));
  const rig = { camera: 'ZWO ASI585MC Air', telescope: null, sensorPx: [W, H] as [number, number], pixelUm: 2.9 };
  const candidate = (name: string, file: string, type: 'dark' | 'bias' = 'dark', exposureSec: number | null = 150) => ({
    type, scope: null, folderName: 'cal', key: name, name, exposureSec, gain: 100, binning: 1, sensorTempC: -8, filter: null,
    capturedAt: null, isExpired: false, fileCount: 1, bytes: 1, rig,
    files: [{ name: path.basename(file), size: 1, modifiedAt: '2026-08-14T00:00:00.000Z', path: file }],
  }) as never;
  let measured = 0;
  const measure = async (abs: string) => { measured++; return measureFrame(fs.readFileSync(abs)).background; };

  it('is the dark the stacking export would pick, measured once and kept', async () => {
    const lightName = path.basename(lightPath);
    const first = await darkLevelFor(lightPath, lightName, measure, [candidate('Darks_150s', darkPath)]);
    expect(first?.bundle).toBe('Darks_150s');
    expect(first!.level).toBeCloseTo(OFFSET_ADU * STEP, -1);
    await darkLevelFor(lightPath, lightName, measure, [candidate('Darks_150s', darkPath)]);
    expect(measured).toBe(1);
  });

  it('falls back to a bias, and refuses a dark shot at another offset', async () => {
    const lightName = path.basename(lightPath);
    expect((await darkLevelFor(lightPath, lightName, measure, [candidate('Bias', darkPath, 'bias', 0.001)]))?.bundle).toBe('Bias');
    expect(await darkLevelFor(lightPath, lightName, measure, [candidate('Darks_offset30', otherOffset)])).toBeNull();
    expect(await darkLevelFor(lightPath, lightName, measure, [])).toBeNull();
  });
});
