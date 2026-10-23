/**
 * Layout for the Mosaic view of the Library and Gallery: every tile on one gap-free rectangle, sized by how much it
 * matters. A port of the desktop app's ClusterScore + ClusterPacker, so the web wall and the Mac wall agree.
 *
 * Pure: no DOM, no React, so it can be unit-tested and run for a few thousand tiles.
 */

/** Weights for how much an object has been worked on. Processed images come first, but a huge raw project can still
 *  outgrow one snapshot. */
const PROCESSED_PRESENCE = 2.5;
const PROCESSED_LOG = 1.5;
const STACK_LOG = 1.0;
const SUB_LOG = 0.35;
/** Subs are counted in blocks of this many, so 10 frames barely register and 1,000 clearly do. */
const SUB_BLOCK = 25;
/** The biggest tile has this many times the area of the smallest. */
const AREA_RATIO = 16;
/** How strongly rank, rather than the raw score, sets the size. */
const RANK_SHARE = 0.7;
/** Above 1 the small tiles stay small and only a few get big, like a wall of prints. */
const RANK_CURVE = 2.2;

export function mosaicScore(processed: number, stacks: number, subs: number): number {
  const p = Math.max(0, processed);
  const o = Math.max(0, stacks);
  const s = Math.max(0, subs);
  return (p > 0 ? PROCESSED_PRESENCE : 0)
    + PROCESSED_LOG * Math.log2(1 + p)
    + STACK_LOG * Math.log2(1 + o)
    + SUB_LOG * Math.log2(1 + s / SUB_BLOCK);
}

/** FNV-1a, so ties and shuffles never depend on the engine or the order objects arrive in. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Indices best-first. Equal scores are told apart by a hash of the id, so the order never shifts between visits. */
export function rankedIndices(scores: number[], ids: string[]): number[] {
  const hashes = ids.map(hashId);
  return scores.map((_, i) => i).sort((a, b) => {
    if (scores[a] !== scores[b]) return scores[b] - scores[a];
    if (hashes[a] !== hashes[b]) return hashes[a] - hashes[b];
    return ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0;
  });
}

/** Relative area (1 ... AREA_RATIO) per item. The ranking sets most of it; the score's own size nudges it. */
export function mosaicAreas(scores: number[], ids: string[]): number[] {
  const n = scores.length;
  if (n === 0 || ids.length !== n) return [];
  if (n === 1) return [Math.sqrt(AREA_RATIO)];
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const span = hi - lo;
  const out = new Array<number>(n).fill(1);
  rankedIndices(scores, ids).forEach((i, rank) => {
    const fromTop = 1 - rank / (n - 1);
    const linear = span > 1e-9 ? (scores[i] - lo) / span : fromTop;
    const share = RANK_SHARE * Math.pow(fromTop, RANK_CURVE) + (1 - RANK_SHARE) * Math.pow(linear, 1.5);
    out[i] = 1 + (AREA_RATIO - 1) * share;
  });
  return out;
}

export interface PackItem {
  id: string;
  score: number;
  /** World-space area the tile should have. */
  area: number;
}

export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 for the most-worked item, 1 for the least. */
  rank: number;
}

export interface PackLayout {
  /** Best-ranked first. */
  placements: Placement[];
  width: number;
  height: number;
}

interface Rect { x: number; y: number; w: number; h: number }

/** The longest a tile may be compared with its width (or the reverse) before it counts as thin. */
const COMFORTABLE_ASPECT = 1.7;

/**
 * Cuts the whole area in two along its longer side, in proportion to the area each half must hold, and each half the
 * same way until one tile is left. Pictures are cropped to fit, so the wall is solid like a sheet of prints. Several
 * fixed shuffles are tried and the one with the fewest thin tiles is kept; they are deterministic, so the same library
 * always gives the same wall.
 *
 * `aspect` is the width / height of the box the wall will be shown in.
 */
export function packMosaic(input: PackItem[], aspect = 1.5): PackLayout {
  if (input.length === 0) return { placements: [], width: 0, height: 0 };

  const ids = input.map(i => i.id);
  const order = rankedIndices(input.map(i => i.score), ids);
  const rankOf = new Map<string, number>();
  order.forEach((idx, r) => rankOf.set(input[idx].id, input.length > 1 ? r / (input.length - 1) : 0));

  // Summed in a fixed order: floating-point addition depends on it, and the wall must not depend on input order.
  const total = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .reduce((sum, i) => sum + Math.max(1, i.area), 0);
  const width = Math.sqrt(total * Math.max(0.2, aspect));
  const height = total / width;
  const whole: Rect = { x: 0, y: 0, w: width, h: height };

  // A big library gets fewer tries: the search is cheap per attempt but not free at a few thousand tiles.
  const attempts = input.length <= 2 ? 1 : input.length > 800 ? 6 : input.length > 300 ? 20 : 64;
  let best = new Map<string, Rect>();
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const seq = shuffledBySize(input, attempt);
    const rects = new Map<string, Rect>();
    place(seq, 0, seq.length, whole, rects);
    const penalty = thinness(seq, rects);
    if (penalty < bestPenalty) { bestPenalty = penalty; best = rects; }
    if (penalty === 0) break;
  }

  const placements = order.map(idx => {
    const item = input[idx];
    const r = best.get(item.id) ?? { x: 0, y: 0, w: 0, h: 0 };
    return { id: item.id, x: r.x, y: r.y, w: r.w, h: r.h, rank: rankOf.get(item.id) ?? 1 };
  });
  return { placements, width, height };
}

/** Sorted by size, cut into short runs of neighbours, and the runs shuffled: each run is like-sized tiles, and the runs
 *  (big ones included) land in different places on the wall. */
function shuffledBySize(input: PackItem[], salt: number): PackItem[] {
  const bySize = [...input].sort((a, b) => (a.area !== b.area ? b.area - a.area : a.id < b.id ? -1 : 1));
  const run = 2 + (salt % 3);
  const runs: { key: number; first: string; items: PackItem[] }[] = [];
  for (let i = 0; i < bySize.length; i += run) {
    const items = bySize.slice(i, i + run);
    runs.push({ key: hashId(`${items[0].id}#${salt}`), first: items[0].id, items });
  }
  runs.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.first < b.first ? -1 : 1));
  return runs.flatMap(r => r.items);
}

/** 0 when every tile is comfortable; grows with how much longer than that the thin ones are. */
function thinness(seq: PackItem[], rects: Map<string, Rect>): number {
  let sum = 0;
  for (const item of seq) {
    const r = rects.get(item.id);
    if (!r || r.w <= 0 || r.h <= 0) continue;
    const longer = Math.max(r.w / r.h, r.h / r.w);
    const over = Math.max(0, Math.log(longer / COMFORTABLE_ASPECT));
    sum += over * over;
  }
  return sum;
}

/** How far a half is from a shape its tiles can fill without slivers: a lone tile should be near square, and a group of
 *  n can be longer, since it will be cut into n pieces. */
function strain(aspect: number, count: number): number {
  const longer = Math.max(aspect, 1 / aspect);
  const allowed = COMFORTABLE_ASPECT * Math.sqrt(count);
  const over = Math.max(0, Math.log(longer / allowed));
  return over * over;
}

function place(items: PackItem[], start: number, end: number, rect: Rect, out: Map<string, Rect>): void {
  const count = end - start;
  if (count <= 0) return;
  if (count === 1) { out.set(items[start].id, rect); return; }

  let total = 0;
  for (let k = start; k < end; k++) total += Math.max(1, items[k].area);
  const wide = rect.w >= rect.h;
  let running = 0;
  let cut = start + 1;
  let best = Number.POSITIVE_INFINITY;
  let leftArea = 0;
  for (let k = start; k < end - 1; k++) {
    running += Math.max(1, items[k].area);
    const fraction = running / total;
    const aLeft = wide ? (rect.w * fraction) / rect.h : rect.w / (rect.h * fraction);
    const aRight = wide ? (rect.w * (1 - fraction)) / rect.h : rect.w / (rect.h * (1 - fraction));
    const leftCount = k - start + 1;
    const rightCount = end - k - 1;
    const cost = 0.6 * Math.abs(fraction - 0.5)
      + 4 * (strain(aLeft, leftCount) + strain(aRight, rightCount))
      + 0.1 * Math.max(Math.abs(Math.log(aLeft)), Math.abs(Math.log(aRight)));
    if (cost < best) { best = cost; cut = k + 1; leftArea = running; }
  }

  const fraction = leftArea / total;
  if (wide) {
    const w = rect.w * fraction;
    place(items, start, cut, { x: rect.x, y: rect.y, w, h: rect.h }, out);
    place(items, cut, end, { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h }, out);
  } else {
    const h = rect.h * fraction;
    place(items, start, cut, { x: rect.x, y: rect.y, w: rect.w, h }, out);
    place(items, cut, end, { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h }, out);
  }
}

/** Tile area in world units for a unit side of `unit`. */
export const MOSAIC_UNIT = 60;

/** Scores in, packed layout out: the single call both pages make. */
export function layoutMosaic(items: { id: string; score: number }[], aspect: number): PackLayout {
  const areas = mosaicAreas(items.map(i => i.score), items.map(i => i.id));
  return packMosaic(
    items.map((item, i) => ({ id: item.id, score: item.score, area: areas[i] * MOSAIC_UNIT * MOSAIC_UNIT })),
    aspect,
  );
}
