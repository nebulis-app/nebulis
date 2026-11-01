/**
 * What the sub-frame shows beyond its stars: how far the photographed object stands out of the sky, and round
 * shadows on the picture (dust, or dew or frost near the sensor).
 *
 * Both work on a coarse copy of the grid, the median of each 8 by 8 block: a star a few pixels across does not move
 * a block's median, so what is left is the sky and what lies on it.
 */
import type { Grid } from './measure.js';

/** Side of a block, in grid pixels. */
export const BLOCK = 8;

export interface Blocks {
  values: Float32Array;
  nx: number;
  ny: number;
  /** Smooth sky under the blocks, wider than any spot (a running median over 31 by 31 blocks). */
  large: Float32Array;
  /** The darker side of the same window (its 20th percentile). Over plain sky it sits just under `large`; where the
   *  window holds nebulosity, filaments with dark gaps between them, it sits far under it. */
  low: Float32Array;
  /** Spread of the blocks around that smooth sky, from the median absolute deviation. */
  noise: number;
}

/** A TAN plate solution read from the header, for the analysed grid (which may be binned from the file). */
export interface GridWcs {
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  /** CD1_1, CD1_2, CD2_1, CD2_2, degrees per file pixel. */
  cd: [number, number, number, number];
  /** File pixels per grid pixel. */
  bin: number;
}

/** Where the object is on the sky and how big, from the catalogue. */
export interface TargetSpec {
  ra: number;
  dec: number;
  /** Half the major axis. */
  radiusArcmin: number;
}

export interface FrameTarget {
  /** Centre and radius searched, in grid pixels. */
  x: number;
  y: number;
  radius: number;
  /** How much brighter the object's brighter parts are than the sky around it, in the grid's units. */
  signal: number;
  /** That over the spread of the sky blocks: how plainly the object shows in this frame. */
  snr: number;
}

export interface FrameSpot {
  /** Centre and width, in grid pixels. */
  x: number;
  y: number;
  diameter: number;
  /** How much darker than the sky around it, in units of the blocks' spread. */
  depth: number;
}

function sortedMedian(values: Float32Array | number[], from = 0, to = values.length): number {
  const s = Float32Array.from(Array.prototype.slice.call(values, from, to) as number[]).sort();
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[n >> 1] : (s[(n >> 1) - 1] + s[n >> 1]) / 2;
}

function quantile(values: number[], q: number): number {
  const s = Float64Array.from(values).sort();
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** The block medians of the grid and the smooth sky under them. */
export function blockMedians(g: Grid): Blocks {
  const nx = Math.floor(g.width / BLOCK), ny = Math.floor(g.height / BLOCK);
  const values = new Float32Array(nx * ny);
  const scratch = new Float32Array(BLOCK * BLOCK);
  for (let by = 0; by < ny; by++) {
    for (let bx = 0; bx < nx; bx++) {
      let n = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
        const row = y * g.width;
        for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) scratch[n++] = g.data[row + x];
      }
      scratch.sort();
      values[by * nx + bx] = (scratch[(n >> 1) - 1] + scratch[n >> 1]) / 2;
    }
  }

  // Running median and 20th percentile over 31 by 31 blocks, taken every fourth block and filled in between: even a
  // large shadow (a dew ring 15 blocks across) covers too little of a window this wide to sway it.
  const half = 15, step = 4;
  const gx = Math.ceil(nx / step) + 1, gy = Math.ceil(ny / step) + 1;
  const coarse = new Float32Array(gx * gy);
  const coarseLow = new Float32Array(gx * gy);
  const win: number[] = [];
  for (let cy = 0; cy < gy; cy++) {
    for (let cx = 0; cx < gx; cx++) {
      const x0 = Math.min(cx * step, nx - 1), y0 = Math.min(cy * step, ny - 1);
      win.length = 0;
      for (let y = Math.max(0, y0 - half); y <= Math.min(ny - 1, y0 + half); y++) {
        for (let x = Math.max(0, x0 - half); x <= Math.min(nx - 1, x0 + half); x++) win.push(values[y * nx + x]);
      }
      const sorted = Float32Array.from(win).sort();
      coarse[cy * gx + cx] = sortedMedian(sorted);
      coarseLow[cy * gx + cx] = sorted[Math.floor((sorted.length - 1) * 0.2)];
    }
  }
  const large = new Float32Array(nx * ny);
  const low = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const fy = y / step, y0 = Math.min(Math.floor(fy), gy - 1), y1 = Math.min(y0 + 1, gy - 1), ty = fy - y0;
    for (let x = 0; x < nx; x++) {
      const fx = x / step, x0 = Math.min(Math.floor(fx), gx - 1), x1 = Math.min(x0 + 1, gx - 1), tx = fx - x0;
      const top = coarse[y0 * gx + x0] * (1 - tx) + coarse[y0 * gx + x1] * tx;
      const bottom = coarse[y1 * gx + x0] * (1 - tx) + coarse[y1 * gx + x1] * tx;
      large[y * nx + x] = top * (1 - ty) + bottom * ty;
      const lowTop = coarseLow[y0 * gx + x0] * (1 - tx) + coarseLow[y0 * gx + x1] * tx;
      const lowBottom = coarseLow[y1 * gx + x0] * (1 - tx) + coarseLow[y1 * gx + x1] * tx;
      low[y * nx + x] = lowTop * (1 - ty) + lowBottom * ty;
    }
  }

  const resid = new Float32Array(nx * ny);
  for (let i = 0; i < resid.length; i++) resid[i] = values[i] - large[i];
  const mid = sortedMedian(resid);
  const dev = resid.map(r => Math.abs(r - mid));
  const noise = Math.max(sortedMedian(dev) * 1.4826, 1e-3);
  return { values, nx, ny, large, low, noise };
}

/**
 * Round shadows over plain sky: dust on a filter or window (the flats take those out) or dew or frost near the
 * sensor (they do not, as it comes and goes). A shadow dims the sky itself, so a block counts only when it is darker
 * than the smooth sky by three times the blocks' spread and also darker than the darker side of its surroundings.
 * Where the surroundings are structured (nebulosity, whose dark gaps between filaments are no shadow) nothing is
 * looked for: the window's median stands well above its 20th percentile there, while over plain sky the two are a
 * spread apart. Long dark shapes, shapes on the frame's edge (vignetting) and shapes too big or too small for a
 * shadow of something near the sensor are left out; a shadow can be oval (a droplet seen at an angle, a tilted
 * window), so up to 3 to 1 is kept.
 */
export function findSpots(b: Blocks): FrameSpot[] {
  const { nx, ny, values, large, low, noise } = b;
  const dark = new Uint8Array(nx * ny);
  for (let i = 0; i < dark.length; i++) {
    const structured = large[i] - low[i] > 2.5 * noise;
    if (!structured && values[i] - large[i] < -3 * noise && values[i] < low[i] - 2 * noise) dark[i] = 1;
  }
  const seen = new Uint8Array(nx * ny);
  const spots: FrameSpot[] = [];
  const stack: number[] = [];
  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || seen[start]) continue;
    let minX = nx, maxX = 0, minY = ny, maxY = 0, area = 0, sx = 0, sy = 0, deepest = 0;
    stack.length = 0; stack.push(start); seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % nx, y = (i - x) / nx;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      deepest = Math.min(deepest, values[i] - large[i]);
      const next = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1];
      for (const j of next) if (j >= 0 && dark[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    // A shadow of something near the sensor is at least 4 blocks (32 grid pixels) across: even dew a millimetre from
    // the sensor throws a ring that wide at f/7. Smaller dark patches are the field's own structure.
    if (area < 6 || w < 2 || h < 2 || Math.max(w, h) < 4 || w > 24 || h > 24) continue;
    if (Math.max(w, h) / Math.min(w, h) > 3 || area / (w * h) < 0.3) continue;
    if (minX <= 0 || minY <= 0 || maxX >= nx - 1 || maxY >= ny - 1) continue;
    spots.push({
      x: (sx / area + 0.5) * BLOCK,
      y: (sy / area + 0.5) * BLOCK,
      diameter: Math.max(w, h) * BLOCK,
      depth: Math.round((-deepest / noise) * 10) / 10,
    });
  }
  return spots.sort((a, b2) => b2.depth - a.depth).slice(0, 20);
}

/** Grid pixel of a sky position, or null when it is behind the projection. */
export function skyToGrid(w: GridWcs, raDeg: number, decDeg: number): { x: number; y: number } | null {
  const rad = Math.PI / 180;
  const a = raDeg * rad, d = decDeg * rad, a0 = w.crval1 * rad, d0 = w.crval2 * rad;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (!(cosc > 0)) return null;
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc / rad;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / rad;
  const [c11, c12, c21, c22] = w.cd;
  const det = c11 * c22 - c12 * c21;
  const dx = (c22 * xi - c12 * eta) / det, dy = (-c21 * xi + c11 * eta) / det;
  // FITS pixels count from 1; a binned grid pixel covers `bin` file pixels.
  const fx = w.crpix1 + dx - 1, fy = w.crpix2 + dy - 1;
  return { x: (fx - (w.bin - 1) / 2) / w.bin, y: (fy - (w.bin - 1) / 2) / w.bin };
}

/** Arcseconds per grid pixel. */
export function gridScaleArcsec(w: GridWcs): number {
  const [c11, c12, c21, c22] = w.cd;
  return Math.sqrt(Math.abs(c11 * c22 - c12 * c21)) * 3600 * w.bin;
}

/** Arcseconds between two sky positions, degrees in. */
function separationArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180;
  const s = Math.sin((dec2 - dec1) * r / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin((ra2 - ra1) * r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) * 180 / Math.PI * 3600;
}

/**
 * Where the object is on the grid, and the scale. With a plate solution in the header it is placed exactly. Without
 * one (smart telescopes and most capture programs that do not solve) the header's pointing and the scale from focal
 * length and pixel size still do, as long as the frame was pointed at the object: the object is then taken to be at
 * the centre when it is within a fifth of its radius of the pointing (the sensor's rotation is unknown, so a larger
 * offset cannot be placed).
 */
function placeTarget(g: Grid, spec: TargetSpec): { at: { x: number; y: number }; scale: number } | null {
  if (g.wcs) {
    const at = skyToGrid(g.wcs, spec.ra, spec.dec);
    const scale = gridScaleArcsec(g.wcs);
    return at && scale > 0 ? { at, scale } : null;
  }
  const scale = g.rig.scale;
  if (scale === null || !(scale > 0) || g.ra === null || g.dec === null) return null;
  const offset = separationArcsec(g.ra, g.dec, spec.ra, spec.dec);
  if (offset > Math.max(spec.radiusArcmin * 60 * 0.2, 4 * scale * BLOCK)) return null;
  return { at: { x: g.width / 2, y: g.height / 2 }, scale };
}

/**
 * How plainly the object shows: the brighter part of the blocks within its catalogue radius (the 85th percentile,
 * so an edge-on galaxy or a nebula that fills only part of the circle still counts, and no orientation is needed)
 * against the sky in a ring around it, over the spread of the sky blocks. When the object is larger than the frame
 * and no ring fits, the darkest blocks of the frame stand in for the sky.
 */
export function measureTarget(g: Grid, b: Blocks, spec: TargetSpec): FrameTarget | null {
  const placed = placeTarget(g, spec);
  if (!placed) return null;
  const { at, scale } = placed;
  const radius = Math.max(2 * BLOCK, (spec.radiusArcmin * 60) / scale);
  if (at.x < -radius * 0.5 || at.y < -radius * 0.5 || at.x > g.width + radius * 0.5 || at.y > g.height + radius * 0.5) return null;

  const inner: number[] = [], ring: number[] = [], outside: number[] = [];
  for (let by = 0; by < b.ny; by++) {
    for (let bx = 0; bx < b.nx; bx++) {
      const d = Math.hypot((bx + 0.5) * BLOCK - at.x, (by + 0.5) * BLOCK - at.y);
      const v = b.values[by * b.nx + bx];
      if (d <= radius) inner.push(v);
      else {
        outside.push(v);
        if (d >= radius * 1.5 && d <= radius * 2.2) ring.push(v);
      }
    }
  }
  if (inner.length < 6) return null;
  let sky: number, spread: number;
  if (ring.length >= 30) {
    sky = sortedMedian(ring);
    const mad = sortedMedian(ring.map(v => Math.abs(v - sky)));
    spread = Math.max(mad * 1.4826, b.noise);
  } else if (outside.length >= 30) {
    sky = quantile(outside, 0.1);
    spread = b.noise;
  } else {
    sky = quantile(inner, 0.05);
    spread = b.noise;
  }
  const signal = quantile(inner, 0.85) - sky;
  return {
    x: Math.round(at.x), y: Math.round(at.y), radius: Math.round(radius),
    signal: Math.round(signal * 100) / 100,
    snr: Math.round((signal / spread) * 100) / 100,
  };
}
