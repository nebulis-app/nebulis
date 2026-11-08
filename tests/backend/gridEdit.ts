/** Edits done on a plain array of cells, with no shared maths, as the reference for what an edit must do to pixels. */
import type { GeometryEdit } from '../../server/lib/annotate/wcs';

export type Grid = number[][];

export function makeGrid(w: number, h: number): Grid {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => y * w + x));
}
const crop = (g: Grid, c: NonNullable<GeometryEdit['crop']>): Grid => {
  const h = g.length, w = g[0].length;
  const x1 = Math.round(c.x1 * w), x2 = Math.round(c.x2 * w), y1 = Math.round(c.y1 * h), y2 = Math.round(c.y2 * h);
  return g.slice(y1, y2).map(row => row.slice(x1, x2));
};
const turn = (g: Grid): Grid => {
  const h = g.length, w = g[0].length;
  return Array.from({ length: w }, (_, r) => Array.from({ length: h }, (_, c) => g[h - 1 - c][r]));
};
/** Crop the source, flip the cropped part, then turn it clockwise: the editor's order. */
export function editGrid(g: Grid, e: GeometryEdit): Grid {
  let out = e.crop ? crop(g, e.crop) : g;
  if (e.flipH) out = out.map(row => [...row].reverse());
  if (e.flipV) out = [...out].reverse();
  for (let i = 0; i < (e.rotation ?? 0) / 90; i++) out = turn(out);
  return out;
}
export function findInGrid(g: Grid, value: number): { x: number; y: number } | null {
  for (let y = 0; y < g.length; y++) {
    const x = g[y].indexOf(value);
    if (x >= 0) return { x, y };
  }
  return null;
}
