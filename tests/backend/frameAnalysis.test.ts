import { describe, it, expect } from 'vitest';
import { measureFrame, measureSyntheticGrid } from '../../server/lib/frameAnalysis/measure';
import { rankFrames, verdictFor, referenceFor, isFrameKept } from '../../server/lib/frameAnalysis/ranking';

/** Deterministic noise so the suite is stable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface FieldOptions {
  stars?: number;
  seed?: number;
  /** Gaussian sigmas along x and y: unequal values make every star a short streak. */
  sigmaX?: number;
  sigmaY?: number;
  /** A straight bright line across the frame. */
  streak?: boolean;
}

function field(w: number, h: number, o: FieldOptions = {}): Float32Array {
  const rand = rng(o.seed ?? 1);
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = 1000 + (rand() + rand() + rand() - 1.5) * 12;
  const sx = o.sigmaX ?? 1.6, sy = o.sigmaY ?? 1.6;
  const n = o.stars ?? 120;
  for (let k = 0; k < n; k++) {
    const cx = 20 + rand() * (w - 40), cy = 20 + rand() * (h - 40);
    const amp = 300 + rand() * 4000;
    for (let y = Math.floor(cy - 8); y <= Math.ceil(cy + 8); y++) {
      for (let x = Math.floor(cx - 8); x <= Math.ceil(cx + 8); x++) {
        const dx = x - cx, dy = y - cy;
        data[y * w + x] += amp * Math.exp(-(dx * dx) / (2 * sx * sx) - (dy * dy) / (2 * sy * sy));
      }
    }
  }
  if (o.streak) {
    for (let x = 0; x < w; x++) {
      const y = Math.round(h * 0.2 + x * 0.5);
      for (let d = -1; d <= 1; d++) if (y + d >= 0 && y + d < h) data[(y + d) * w + x] += 90;
    }
  }
  return data;
}

const W = 480, H = 320;

describe('frame measurement', () => {
  it('finds the stars of a clean frame and calls them round', () => {
    const m = measureSyntheticGrid(field(W, H), W, H);
    expect(m.starCount).toBeGreaterThan(80);
    expect(m.elongation).toBeLessThan(1.25);
    expect(m.fwhm).toBeGreaterThan(2.5);
    expect(m.fwhm).toBeLessThan(5);
    expect(m.streak).toBeNull();
  });

  it('reports stretched stars as elongated', () => {
    const m = measureSyntheticGrid(field(W, H, { sigmaX: 3.4, sigmaY: 1.4 }), W, H);
    expect(m.elongation).toBeGreaterThan(1.8);
  });

  it('finds a straight streak', () => {
    const m = measureSyntheticGrid(field(W, H, { streak: true, seed: 5 }), W, H);
    expect(m.streak).not.toBeNull();
  });

  it('counts far fewer stars through cloud', () => {
    const clear = measureSyntheticGrid(field(W, H, { stars: 120 }), W, H);
    const cloudy = measureSyntheticGrid(field(W, H, { stars: 15, seed: 9 }), W, H);
    expect(cloudy.starCount).toBeLessThan(clear.starCount * 0.4);
  });
});

describe('FITS decode', () => {
  function fits(w: number, h: number, pixels: Int16Array, extra: Record<string, string | number> = {}): Buffer {
    const cards = [
      'SIMPLE  =                    T',
      'BITPIX  =                   16',
      'NAXIS   =                    2',
      `NAXIS1  = ${String(w).padStart(20)}`,
      `NAXIS2  = ${String(h).padStart(20)}`,
      'BZERO   =                32768',
      'BSCALE  =                    1',
      ...Object.entries(extra).map(([k, v]) => `${k.padEnd(8)}= ${typeof v === 'string' ? `'${v}'`.padEnd(20) : String(v).padStart(20)}`),
      'END',
    ].map(c => c.padEnd(80));
    const header = Buffer.from(cards.join('').padEnd(Math.ceil((cards.length * 80) / 2880) * 2880), 'ascii');
    const data = Buffer.alloc(Math.ceil(pixels.length * 2 / 2880) * 2880);
    for (let i = 0; i < pixels.length; i++) data.writeInt16BE(pixels[i], i * 2);
    return Buffer.concat([header, data]);
  }

  function toInt16(data: Float32Array): Int16Array {
    // BZERO 32768: stored = value - 32768.
    return Int16Array.from(data, v => Math.round(v) - 32768);
  }

  it('measures a 16-bit unsigned file the same as the in-memory grid', () => {
    const grid = field(W, H);
    const fromFile = measureFrame(fits(W, H, toInt16(grid)));
    expect(fromFile.width).toBe(W);
    expect(fromFile.starCount).toBeGreaterThan(80);
    expect(fromFile.background).toBeGreaterThan(900);
    expect(fromFile.background).toBeLessThan(1100);
  });

  it('bins a Bayer mosaic to half size', () => {
    const m = measureFrame(fits(W, H, toInt16(field(W, H)), { BAYERPAT: 'RGGB' }));
    expect(m.width).toBe(W / 2);
    expect(m.height).toBe(H / 2);
  });

  it('refuses a file whose pixel data is cut short', () => {
    const full = fits(W, H, toInt16(field(W, H)));
    expect(() => measureFrame(full.subarray(0, full.length - 20000))).toThrow(/shorter|incomplete/i);
  });

  it('refuses a picture too small to mean anything', () => {
    const tiny = new Int16Array(8 * 8).fill(-32000);
    expect(() => measureFrame(fits(8, 8, tiny))).toThrow(/too small/i);
  });

  it('reads pointing from the header', () => {
    const m = measureFrame(fits(W, H, toInt16(field(W, H)), { RA: 83.8, DEC: -5.4 }));
    expect(m.ra).toBeCloseTo(83.8);
    expect(m.dec).toBeCloseTo(-5.4);
  });
});

describe('frame ranking', () => {
  const night = (counts: number[]) => counts.map((starCount, i) => ({
    width: 960, height: 540, starCount, fwhm: 3, elongation: 1.1, orientation: null, background: 1000, noise: 10,
    gradient: 0.02, peakSNR: 40, streak: null, saturatedFraction: 0, ra: null, dec: null, id: i,
  }));

  it('marks a frame with far fewer stars than the night as clouds', () => {
    const frames = night([100, 98, 102, 101, 99, 100, 40]);
    const { verdicts } = rankFrames(frames);
    const last = verdicts[verdicts.length - 1];
    expect(last.flags).toContain('clouds');
    expect(last.grade).toBe('bad');
    expect(verdicts[0].flags).toEqual([]);
    expect(verdicts[0].grade).toBe('good');
  });

  it('does not call a thin set cloudy: too few frames to compare', () => {
    const { verdicts } = rankFrames(night([100, 100, 40]));
    expect(verdicts[2].flags).not.toContain('clouds');
  });

  it('flags a plainly trailed frame as bad and a slight smear as only fair', () => {
    const ref = referenceFor(night([100, 100, 100, 100, 100, 100]));
    const base = night([100])[0];
    const plain = verdictFor({ ...base, elongation: 2.4, orientation: 35 }, ref);
    expect(plain.flags).toContain('trails');
    expect(plain.grade).toBe('bad');
    const slight = verdictFor({ ...base, elongation: 1.5 }, ref);
    expect(slight.flags).toContain('trails');
    expect(slight.grade).not.toBe('bad');
  });

  it('flags a streak without making the frame bad', () => {
    const ref = referenceFor(night([100, 100, 100, 100, 100, 100]));
    const v = verdictFor({ ...night([100])[0], streak: { angle: 27, strength: 0.6 } }, ref);
    expect(v.flags).toEqual(['streak']);
    expect(v.reasons[0]).toEqual({ flag: 'streak', angle: 27 });
    expect(v.grade).toBe('fair');
  });

  it('judges a mosaic frame against its own neighbours, not the whole night', () => {
    // Two fields a long way apart: a dusty one with few stars, a rich one with many.
    const dusty = night([30, 31, 29, 30, 32, 30]).map(m => ({ ...m, ra: 10, dec: 20 }));
    const rich = night([200, 198, 202, 201, 199, 200]).map(m => ({ ...m, ra: 150, dec: 20 }));
    const { verdicts } = rankFrames([...dusty, ...rich]);
    expect(verdicts.every(v => !v.flags.includes('clouds'))).toBe(true);
  });
});

describe('measuring worker lookup', () => {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const osMod = require('node:os') as typeof import('node:os');
  const pathMod = require('node:path') as typeof import('node:path');

  it('uses the .ts worker beside the source, then the bundled .cjs, and unpacks a packaged one to the data folder', async () => {
    const { resolveWorkerFile } = await import('../../server/lib/frameAnalysis/measureOffThread');
    const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'nebulis-worker-'));
    try {
      // Running from source: the TypeScript worker sits beside the module.
      const src = pathMod.join(root, 'src'); fsMod.mkdirSync(src);
      fsMod.writeFileSync(pathMod.join(src, 'measureWorker.ts'), '// worker');
      expect(resolveWorkerFile(src, root)).toBe(pathMod.join(src, 'measureWorker.ts'));

      // A bundle in a real folder: the built worker sits beside it, and wins over a stray .ts.
      const bundle = pathMod.join(root, 'bundle'); fsMod.mkdirSync(bundle);
      fsMod.writeFileSync(pathMod.join(bundle, 'measureWorker.cjs'), '// built');
      expect(resolveWorkerFile(bundle, root)).toBe(pathMod.join(bundle, 'measureWorker.cjs'));

      // A packaged executable: the worker is an asset in the snapshot and is written to the data folder.
      const snap = pathMod.join(root, 'snapshot', 'server');
      fsMod.mkdirSync(pathMod.join(snap, 'assets', 'frame-worker'), { recursive: true });
      fsMod.writeFileSync(pathMod.join(snap, 'assets', 'frame-worker', 'measureWorker.worker'), '// packaged');
      const unpacked = resolveWorkerFile(snap, root);
      expect(unpacked).toMatch(/frame-worker-[0-9a-f]{12}\.cjs$/);
      expect(unpacked && fsMod.readFileSync(unpacked, 'utf8')).toBe('// packaged');
      expect(unpacked && unpacked.startsWith(pathMod.join(root, 'cache'))).toBe(true);

      // Nothing anywhere: no worker, so the caller measures in this thread.
      const empty = pathMod.join(root, 'empty'); fsMod.mkdirSync(empty);
      expect(resolveWorkerFile(empty, root)).toBeNull();
    } finally {
      fsMod.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('measuring off the main thread', () => {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const fixture = pathMod.join(__dirname, '..', 'fixtures', 'frame-analysis', 'clean.fits');

  it('returns the same measurement as measuring in this thread, and survives a worker that cannot start', async () => {
    const { measureOffThread, resetMeasureWorker } = await import('../../server/lib/frameAnalysis/measureOffThread');
    resetMeasureWorker();
    const direct = measureFrame(fsMod.readFileSync(fixture));
    // Under vitest the worker's TypeScript cannot be loaded, which is exactly the "worker cannot run here" case:
    // the job must still be answered, in this thread, with the same numbers.
    const viaWorkerOrFallback = await measureOffThread(fixture);
    expect(viaWorkerOrFallback).toEqual(direct);
    // And again: after giving up on the worker, it keeps answering.
    expect(await measureOffThread(fixture)).toEqual(direct);
    resetMeasureWorker();
  });

  it('reports an unreadable file as unreadable', async () => {
    const { measureOffThread, resetMeasureWorker } = await import('../../server/lib/frameAnalysis/measureOffThread');
    resetMeasureWorker();
    await expect(measureOffThread(pathMod.join(__dirname, 'does-not-exist.fits'))).rejects.toThrow();
    resetMeasureWorker();
  });
});

describe('isFrameKept', () => {
  const verdict = (grade: 'good' | 'fair' | 'bad') => ({ score: 50, grade, flags: [], reasons: [] });
  it('follows the grade: only a bad frame is out', () => {
    expect(isFrameKept(null, verdict('good'))).toBe(true);
    expect(isFrameKept(null, verdict('fair'))).toBe(true);
    expect(isFrameKept(null, verdict('bad'))).toBe(false);
  });
  it('keeps a frame that has not been measured', () => {
    expect(isFrameKept(null, null)).toBe(true);
  });
  it("lets the user's call win either way", () => {
    expect(isFrameKept('keep', verdict('bad'))).toBe(true);
    expect(isFrameKept('reject', verdict('good'))).toBe(false);
    expect(isFrameKept('reject', null)).toBe(false);
  });
});
