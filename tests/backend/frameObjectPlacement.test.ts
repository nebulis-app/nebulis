import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import db from '../../server/lib/db';
import { measureFrame, type FileWcs } from '../../server/lib/frameAnalysis/measure';
import { borrowedWcsFor, POINTING_TOLERANCE_DEG, TIME_WINDOW_MS } from '../../server/lib/frameAnalysis/pointingWcs';
import type { TargetSpec } from '../../server/lib/frameAnalysis/field';

/**
 * A mosaic panel: the telescope points at (150°, +40°), 2"/px, north up, and the object (a diffuse glow 3' in radius)
 * sits 160 px east of the centre, so a frame without a plate solution cannot take it to be at the centre.
 */
const W = 640, H = 480;
const SCALE_DEG = 2 / 3600;
const POINT = { ra: 150, dec: 40 };
const WCS: FileWcs = { crval1: POINT.ra, crval2: POINT.dec, crpix1: W / 2 + 0.5, crpix2: H / 2 + 0.5, cd: [-SCALE_DEG, 0, 0, SCALE_DEG] };
const OBJECT_PX = { x: 160, y: 240 };
// Sky position of that pixel (tangent plane; exact enough this close to the centre).
const TARGET: TargetSpec = {
  ra: POINT.ra + ((OBJECT_PX.x + 1 - WCS.crpix1) * WCS.cd[0]) / Math.cos(POINT.dec * Math.PI / 180),
  dec: POINT.dec + (OBJECT_PX.y + 1 - WCS.crpix2) * SCALE_DEG,
  radiusArcmin: 3,
};

function card(key: string, value: string | number): string {
  const v = typeof value === 'number' ? String(value).padStart(20) : `'${value.padEnd(8)}'`;
  return `${key.padEnd(8)}= ${v}`.padEnd(80);
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** The same field every time; only the header changes. */
function frame(opts: { wcs?: FileWcs | null; ra?: number; dec?: number; at?: string; side?: string; seed?: number } = {}): Buffer {
  const random = rng(opts.seed ?? 7);
  const cards = [
    `SIMPLE  = ${'T'.padStart(20)}`.padEnd(80), card('BITPIX', 16), card('NAXIS', 2), card('NAXIS1', W), card('NAXIS2', H),
    card('BZERO', 32768), card('EXPTIME', 120), card('INSTRUME', 'Test Cam'), card('FOCALLEN', 300), card('XPIXSZ', 2.9),
    card('RA', opts.ra ?? POINT.ra), card('DEC', opts.dec ?? POINT.dec), card('DATE-OBS', opts.at ?? '2026-10-13T22:00:00'),
    card('PIERSIDE', opts.side ?? 'WEST'),
  ];
  const w = opts.wcs === undefined ? null : opts.wcs;
  if (w) {
    cards.push(card('CTYPE1', 'RA---TAN'), card('CTYPE2', 'DEC--TAN'), card('CRVAL1', w.crval1), card('CRVAL2', w.crval2),
      card('CRPIX1', w.crpix1), card('CRPIX2', w.crpix2), card('CD1_1', w.cd[0]), card('CD1_2', w.cd[1]), card('CD2_1', w.cd[2]), card('CD2_2', w.cd[3]));
  }
  cards.push('END'.padEnd(80));
  let header = cards.join('');
  header = header.padEnd(Math.ceil(header.length / 2880) * 2880, ' ');
  const data = Buffer.alloc(Math.ceil((W * H * 2) / 2880) * 2880);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 1000 + (random() - 0.5) * 40;
      const r = Math.hypot(x - OBJECT_PX.x, y - OBJECT_PX.y);
      if (r < 90) v += 120 * Math.exp(-((r / 60) ** 2));
      if (x % 53 === 11 && y % 47 === 13) v += 3000; // a few stars
      data.writeInt16BE(Math.round(v) - 32768, (y * W + x) * 2);
    }
  }
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-placement-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const write = (buf: Buffer) => {
  const p = path.join(tmp, `frame_${n++}.fit`);
  fs.writeFileSync(p, buf);
  return p;
};

beforeEach(() => {
  db.prepare('DELETE FROM framePointingWcs').run();
});

describe('placing the object in a frame with no plate solution', () => {
  it('cannot find an off-centre object without a solution', () => {
    expect(measureFrame(frame(), TARGET).target).toBeNull();
  });

  it("gets the same Object value from a neighbour's solution as from its own", async () => {
    const reference = measureFrame(frame({ wcs: WCS }), TARGET);
    expect(reference.wcsSource).toBe('header');
    expect(reference.target).not.toBeNull();
    expect(reference.target!.x).toBeCloseTo(OBJECT_PX.x, -1);

    // The solved frame leaves its solution for the night; an unsolved frame of the same field borrows it.
    expect(await borrowedWcsFor(write(frame({ wcs: WCS })), TARGET, null)).toBeNull();
    const lent = await borrowedWcsFor(write(frame({ at: '2026-10-13T22:40:00', seed: 8 })), TARGET, null);
    expect(lent).toEqual(WCS);
    const panel = measureFrame(frame({ seed: 8 }), TARGET, lent);
    expect(panel.wcsSource).toBe('borrowed');
    expect(panel.target).toMatchObject({ x: reference.target!.x, y: reference.target!.y, radius: reference.target!.radius });
    expect(Math.abs(panel.target!.snr - reference.target!.snr) / reference.target!.snr).toBeLessThan(0.1);
  });

  it('lends nothing across a meridian flip, a long gap, another field or another camera size', async () => {
    await borrowedWcsFor(write(frame({ wcs: WCS })), TARGET, null);
    expect(await borrowedWcsFor(write(frame({ side: 'EAST' })), TARGET, null)).toBeNull();
    const later = new Date(Date.parse('2026-10-13T22:00:00Z') + TIME_WINDOW_MS + 60_000).toISOString().slice(0, 19);
    expect(await borrowedWcsFor(write(frame({ at: later })), TARGET, null)).toBeNull();
    expect(await borrowedWcsFor(write(frame({ ra: POINT.ra + 3 * POINTING_TOLERANCE_DEG })), TARGET, null)).toBeNull();
    // Within the tolerance (a dither) it is the same field.
    expect(await borrowedWcsFor(write(frame({ ra: POINT.ra + POINTING_TOLERANCE_DEG / 4 })), TARGET, null)).toEqual(WCS);
  });

  it('solves one frame of a field nothing else places, keeps the answer, and does not try again after a failure', async () => {
    let solves = 0;
    const solver = async () => { solves++; return WCS; };
    expect(await borrowedWcsFor(write(frame()), TARGET, solver)).toEqual(WCS);
    expect(await borrowedWcsFor(write(frame({ at: '2026-10-13T22:10:00', seed: 9 })), TARGET, solver)).toEqual(WCS);
    expect(solves).toBe(1);

    db.prepare('DELETE FROM framePointingWcs').run();
    let failures = 0;
    const failing = async () => { failures++; return null; };
    expect(await borrowedWcsFor(write(frame()), TARGET, failing)).toBeNull();
    expect(await borrowedWcsFor(write(frame({ at: '2026-10-13T22:20:00' })), TARGET, failing)).toBeNull();
    expect(failures).toBe(1);
  });

  it('does not solve a frame pointed at the object, nor one with nothing to look for', async () => {
    let solves = 0;
    const solver = async () => { solves++; return WCS; };
    const centred: TargetSpec = { ra: POINT.ra, dec: POINT.dec, radiusArcmin: 3 };
    expect(await borrowedWcsFor(write(frame()), centred, solver)).toBeNull();
    expect(await borrowedWcsFor(write(frame()), null, solver)).toBeNull();
    expect(solves).toBe(0);
  });

  it('changes nothing for a frame that has its own solution', () => {
    const other: FileWcs = { ...WCS, crval1: WCS.crval1 + 0.2 };
    const own = measureFrame(frame({ wcs: WCS }), TARGET);
    expect(measureFrame(frame({ wcs: WCS }), TARGET, other)).toEqual(own);
  });
});
