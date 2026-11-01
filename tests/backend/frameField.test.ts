import { describe, it, expect } from 'vitest';
import { measureFrame, type FrameMetrics } from '../../server/lib/frameAnalysis/measure';
import { rankFrames } from '../../server/lib/frameAnalysis/ranking';

/**
 * The object's contrast, round shadows near the sensor, and comparing a night with the object's other nights.
 * Frames are synthetic FITS with a known sky, stars, object and spots.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

interface Spec {
  seed?: number;
  sky?: number;
  noise?: number;
  /** Peak of the object above the sky, 0 for none. Centred, an ellipse 160 by 50 pixels at 30°. */
  object?: number;
  /** Shadows: centre and radius in file pixels, depth as a fraction of the sky. */
  spots?: { x: number; y: number; r: number; depth: number }[];
  /** Write a plate solution (pointing at RA 30°, Dec 40°, 1.5"/px) or only pointing, focal length and pixel size. */
  solved?: boolean;
}

const W = 960, H = 640;
const RA = 30, DEC = 40;

function frame(o: Spec = {}): Buffer {
  const rand = rng(o.seed ?? 1);
  const gauss = () => { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
  const sky = o.sky ?? 1000, noise = o.noise ?? 10;
  const img = new Float64Array(W * H).fill(sky);
  const starRand = rng(777);
  for (let k = 0; k < 400; k++) {
    const cx = 10 + starRand() * (W - 20), cy = 10 + starRand() * (H - 20), amp = 200 + starRand() * 3000;
    for (let y = Math.floor(cy - 6); y <= Math.ceil(cy + 6); y++) {
      for (let x = Math.floor(cx - 6); x <= Math.ceil(cx + 6); x++) {
        img[y * W + x] += amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 1.5 * 1.5));
      }
    }
  }
  if (o.object) {
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - W / 2, dy = y - H / 2, u = dx * c + dy * s, v = -dx * s + dy * c;
        img[y * W + x] += o.object * Math.exp(-(u * u) / (2 * 80 * 80) - (v * v) / (2 * 25 * 25));
      }
    }
  }
  for (const sp of o.spots ?? []) {
    for (let y = Math.floor(sp.y - sp.r); y <= sp.y + sp.r; y++) {
      for (let x = Math.floor(sp.x - sp.r); x <= sp.x + sp.r; x++) {
        if (Math.hypot(x - sp.x, y - sp.y) <= sp.r) img[y * W + x] *= 1 - sp.depth;
      }
    }
  }
  const scaleDeg = 1.5 / 3600;
  const cards: [string, string][] = [
    ['SIMPLE', 'T'], ['BITPIX', '16'], ['NAXIS', '2'], ['NAXIS1', String(W)], ['NAXIS2', String(H)],
    ['BZERO', '32768'], ['BSCALE', '1'], ['RA', String(RA)], ['DEC', String(DEC)],
    ['INSTRUME', "'Test camera'"], ['FOCALLEN', '400'], ['XPIXSZ', String(1.5 * 400 / 206.265)],
  ];
  if (o.solved !== false) {
    cards.push(['CTYPE1', "'RA---TAN'"], ['CTYPE2', "'DEC--TAN'"], ['CRVAL1', String(RA)], ['CRVAL2', String(DEC)],
      ['CRPIX1', String(W / 2 + 0.5)], ['CRPIX2', String(H / 2 + 0.5)],
      ['CD1_1', String(-scaleDeg)], ['CD1_2', '0'], ['CD2_1', '0'], ['CD2_2', String(scaleDeg)]);
  }
  const header = Buffer.from(
    [...cards.map(([k, v]) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80)), 'END'.padEnd(80)].join('')
      .padEnd(Math.ceil(((cards.length + 1) * 80) / 2880) * 2880), 'ascii');
  const data = Buffer.alloc(Math.ceil((W * H * 2) / 2880) * 2880);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0, Math.min(65535, Math.round(img[i] + gauss() * noise)));
    data.writeInt16BE(v - 32768, i * 2);
  }
  return Buffer.concat([header, data]);
}

const TARGET = { ra: RA, dec: DEC, radiusArcmin: 3 };

describe('the photographed object', () => {
  it('reads how plainly it shows, in proportion to its brightness, whatever its orientation', () => {
    const bright = measureFrame(frame({ object: 60 }), TARGET).target;
    const faint = measureFrame(frame({ object: 20 }), TARGET).target;
    const none = measureFrame(frame({ object: 0 }), TARGET).target;
    expect(bright).not.toBeNull();
    expect(Math.abs(bright!.x - W / 2)).toBeLessThan(2);
    expect(Math.abs(bright!.y - H / 2)).toBeLessThan(2);
    expect(bright!.snr).toBeGreaterThan(faint!.snr * 2.4);
    expect(bright!.snr).toBeLessThan(faint!.snr * 3.6);
    expect(Math.abs(none!.snr)).toBeLessThan(faint!.snr * 0.3);
  });

  it('falls as the sky noise rises, as under the Moon', () => {
    const dark = measureFrame(frame({ object: 40, noise: 10 }), TARGET).target!;
    const moon = measureFrame(frame({ object: 40, noise: 30, sky: 5000 }), TARGET).target!;
    expect(moon.snr).toBeLessThan(dark.snr * 0.5);
  });

  it('places the object from pointing, focal length and pixel size when the frame is not plate-solved', () => {
    const m = measureFrame(frame({ object: 60, solved: false }), TARGET);
    expect(m.rig).toEqual({ camera: 'Test camera', focal: 400, scale: 1.5 });
    expect(m.target).not.toBeNull();
    expect(m.target!.snr).toBeGreaterThan(5);
    // Pointed a degree away, with no solution to say where the object falls: not measured.
    expect(measureFrame(frame({ object: 60, solved: false }), { ...TARGET, dec: DEC + 1 }).target).toBeNull();
  });

  it('is not measured without a place for the object', () => {
    expect(measureFrame(frame({ object: 60 })).target).toBeNull();
  });
});

describe('round shadows near the sensor', () => {
  it('finds a shadow a few percent deep, and nothing on a clean frame', () => {
    const spots = measureFrame(frame({ spots: [{ x: 250, y: 200, r: 30, depth: 0.04 }] })).spots;
    expect(spots.length).toBe(1);
    expect(Math.abs(spots[0].x - 250)).toBeLessThan(12);
    expect(Math.abs(spots[0].y - 200)).toBeLessThan(12);
    expect(spots[0].diameter).toBeGreaterThanOrEqual(40);
    expect(measureFrame(frame()).spots).toEqual([]);
  });
});

describe('comparing with the object\'s other nights', () => {
  const metrics = (o: Spec, n: number, seed0: number): FrameMetrics[] =>
    Array.from({ length: n }, (_, i) => measureFrame(frame({ ...o, seed: seed0 + i }), TARGET));

  it('scores a night that is poor all through below the good nights, and says why', () => {
    const good = metrics({ object: 40 }, 10, 100);
    const moon = metrics({ object: 40, noise: 30, sky: 5000 }, 6, 200);
    const alone = rankFrames(moon).verdicts;
    expect(Math.min(...alone.map(v => v.score))).toBeGreaterThan(80);
    const { verdicts, reference } = rankFrames(moon, good);
    expect(reference!.otherFrames).toBe(10);
    for (const v of verdicts) {
      expect(v.score).toBeLessThan(50);
      expect(v.flags).toContain('faint');
      const reason = v.reasons.find(r => r.flag === 'faint');
      expect(reason).toMatchObject({ brighterSky: true });
      expect(reason && reason.flag === 'faint' ? reason.targetPercent : null).toBeLessThan(50);
    }
  });

  it('reports a shadow other nights do not have, and leaves dust that is always there alone', () => {
    const dust = { x: 700, y: 450, r: 28, depth: 0.04 };
    const dew = { x: 250, y: 200, r: 30, depth: 0.04 };
    const history = metrics({ object: 40, spots: [dust] }, 10, 300);
    const night = metrics({ object: 40, spots: [dust, dew] }, 3, 400);
    const { verdicts } = rankFrames(night, history);
    for (const v of verdicts) {
      expect(v.flags).toContain('spots');
      expect(v.reasons.find(r => r.flag === 'spots')).toEqual({ flag: 'spots', count: 1, otherNights: true });
    }
    const clean = rankFrames(metrics({ object: 40, spots: [dust] }, 3, 500), history).verdicts;
    for (const v of clean) expect(v.flags).not.toContain('spots');
  });
});
