import { describe, it, expect } from 'vitest';
import { choosePosterGrid, POSTER_FORMATS } from '../../src/lib/catalogWallPoster';

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, span: { cols: 1, rows: 1 } }));

describe('choosePosterGrid', () => {
  it('fits the whole wall inside the area, with the largest cells that allow it', () => {
    const { width, height } = POSTER_FORMATS.wide;
    const areaW = width - 80, areaH = height - 300, gap = 2;
    const g = choosePosterGrid(items(110), areaW, areaH, gap);
    const h = g.layout.rows * g.cell + (g.layout.rows - 1) * gap;
    expect(h).toBeLessThanOrEqual(areaH);
    // One fewer column would have made bigger tiles that no longer fit.
    if (g.columns > 3) {
      const smaller = layoutRows(items(110), g.columns - 1);
      const cell = (areaW - (g.columns - 2) * gap) / (g.columns - 1);
      expect(smaller * cell + (smaller - 1) * gap).toBeGreaterThan(areaH);
    }
  });

  it('uses fewer, bigger columns for a portrait story than a wide poster', () => {
    const story = POSTER_FORMATS.story, wide = POSTER_FORMATS.wide;
    const a = choosePosterGrid(items(60), story.width - 80, story.height - 300, 2);
    const b = choosePosterGrid(items(60), wide.width - 80, wide.height - 300, 2);
    expect(a.columns).toBeLessThan(b.columns);
  });
});

import { layoutWall } from '../../src/lib/catalogWallLayout';
function layoutRows(it: ReturnType<typeof items>, cols: number) { return layoutWall(it, cols).rows; }
