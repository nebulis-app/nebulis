/**
 * Writes the shared frame-analysis fixtures: a few small synthetic FITS files and `expected.json`, the metrics
 * the server's analyzer reads from them.
 *
 * The macOS app has its own port of the analyzer (NebulisDesktop/Services/Imaging/FrameAnalyzer.swift). The two
 * agree only if something checks them against the same files, so these files are copied byte for byte into the
 * Mac project, and both test suites assert against `expected.json`. `expected.json` records each file's sha256 so
 * a copy that drifts is caught as a different file, not as a mysterious number.
 *
 * Run after any change to server/lib/frameAnalysis/measure.ts that is meant to change a measurement, and bump
 * FRAME_METRICS_VERSION in the same change:
 *
 *   npx tsx scripts/gen-frame-analysis-fixtures.ts
 *
 * then copy tests/fixtures/frame-analysis/ over nebulis-apple/NebulisDesktop/Tests/Fixtures/FrameAnalysis/.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FRAME_METRICS_VERSION, measureFrame, type FrameMetrics } from '../server/lib/frameAnalysis/measure.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'frame-analysis');

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Spec {
  name: string;
  w: number;
  h: number;
  seed: number;
  stars: number;
  sigmaX?: number;
  sigmaY?: number;
  streak?: boolean;
  bayer?: string;
  ra?: number;
  dec?: number;
}

const SPECS: Spec[] = [
  { name: 'clean.fits', w: 320, h: 240, seed: 11, stars: 70 },
  { name: 'trailed.fits', w: 320, h: 240, seed: 12, stars: 70, sigmaX: 3.4, sigmaY: 1.4 },
  { name: 'streak.fits', w: 320, h: 240, seed: 13, stars: 70, streak: true },
  { name: 'sparse.fits', w: 320, h: 240, seed: 14, stars: 9 },
  { name: 'bayer-pointed.fits', w: 400, h: 300, seed: 15, stars: 90, bayer: 'RGGB', ra: 83.82, dec: -5.39 },
];

function pixels(spec: Spec): Int16Array {
  const { w, h } = spec;
  const rand = rng(spec.seed);
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = 1000 + (rand() + rand() + rand() - 1.5) * 12;
  const sx = spec.sigmaX ?? 1.6, sy = spec.sigmaY ?? 1.6;
  for (let k = 0; k < spec.stars; k++) {
    const cx = 20 + rand() * (w - 40), cy = 20 + rand() * (h - 40);
    const amp = 300 + rand() * 4000;
    for (let y = Math.floor(cy - 8); y <= Math.ceil(cy + 8); y++) {
      for (let x = Math.floor(cx - 8); x <= Math.ceil(cx + 8); x++) {
        const dx = x - cx, dy = y - cy;
        data[y * w + x] += amp * Math.exp(-(dx * dx) / (2 * sx * sx) - (dy * dy) / (2 * sy * sy));
      }
    }
  }
  if (spec.streak) {
    for (let x = 0; x < w; x++) {
      const y = Math.round(h * 0.2 + x * 0.5);
      for (let d = -1; d <= 1; d++) if (y + d >= 0 && y + d < h) data[(y + d) * w + x] += 90;
    }
  }
  // Unsigned 16-bit: stored = value - 32768 with BZERO = 32768.
  return Int16Array.from(data, v => Math.round(v) - 32768);
}

function fits(spec: Spec): Buffer {
  const cards: string[] = [
    'SIMPLE  =                    T',
    'BITPIX  =                   16',
    'NAXIS   =                    2',
    `NAXIS1  = ${String(spec.w).padStart(20)}`,
    `NAXIS2  = ${String(spec.h).padStart(20)}`,
    'BZERO   =                32768',
    'BSCALE  =                    1',
  ];
  if (spec.bayer) cards.push(`BAYERPAT= '${spec.bayer}'`.padEnd(30));
  if (spec.ra !== undefined) cards.push(`RA      = ${String(spec.ra).padStart(20)}`);
  if (spec.dec !== undefined) cards.push(`DEC     = ${String(spec.dec).padStart(20)}`);
  cards.push('END');
  const header = Buffer.from(cards.map(c => c.padEnd(80)).join('').padEnd(Math.ceil((cards.length * 80) / 2880) * 2880), 'ascii');
  const px = pixels(spec);
  const data = Buffer.alloc(Math.ceil((px.length * 2) / 2880) * 2880);
  for (let i = 0; i < px.length; i++) data.writeInt16BE(px[i], i * 2);
  return Buffer.concat([header, data]);
}

const files: Record<string, { sha256: string; metrics: FrameMetrics }> = {};
fs.mkdirSync(OUT, { recursive: true });
for (const spec of SPECS) {
  const buf = fits(spec);
  fs.writeFileSync(path.join(OUT, spec.name), buf);
  files[spec.name] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), metrics: measureFrame(buf) };
}
fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify({ version: FRAME_METRICS_VERSION, files }, null, 2) + '\n');
console.log(`wrote ${SPECS.length} fixtures and expected.json (analyzer version ${FRAME_METRICS_VERSION})`);
