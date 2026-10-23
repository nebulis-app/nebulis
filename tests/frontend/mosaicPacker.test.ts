import { describe, it, expect } from 'vitest';
import { layoutMosaic, mosaicAreas, mosaicScore, rankedIndices } from '../../src/lib/mosaic/mosaicPacker';

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `obj-${i}`, score: (i * 7) % 11 }));

describe('mosaicScore', () => {
  it('puts one processed picture above a week of raw stacks', () => {
    expect(mosaicScore(1, 1, 50)).toBeGreaterThan(mosaicScore(0, 7, 500));
  });
  it('lets a huge unprocessed project outgrow a single snapshot', () => {
    expect(mosaicScore(0, 30, 3000)).toBeGreaterThan(mosaicScore(1, 1, 50));
  });
  it('is zero for nothing', () => {
    expect(mosaicScore(0, 0, 0)).toBe(0);
  });
});

describe('rankedIndices', () => {
  it('orders best first and breaks ties the same way for any input order', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const forward = rankedIndices([1, 1, 1, 1], ids).map(i => ids[i]);
    const reversedIds = [...ids].reverse();
    const backward = rankedIndices([1, 1, 1, 1], reversedIds).map(i => reversedIds[i]);
    expect(forward).toEqual(backward);
  });
});

describe('mosaicAreas', () => {
  it('varies sizes even when every score is equal', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const areas = mosaicAreas([1, 1, 1, 1, 1], ids);
    expect(Math.max(...areas)).toBeGreaterThan(Math.min(...areas));
  });
  it('gives the best-scored item the biggest area', () => {
    const areas = mosaicAreas([5, 1, 3], ['a', 'b', 'c']);
    expect(areas[0]).toBeGreaterThan(areas[2]);
    expect(areas[2]).toBeGreaterThan(areas[1]);
  });
});

describe('layoutMosaic', () => {
  it('is empty for no items', () => {
    expect(layoutMosaic([], 1.5).placements).toEqual([]);
  });

  it('places every item once, inside the wall, with no overlaps and no gaps', () => {
    const layout = layoutMosaic(items(60), 1.6);
    expect(layout.placements).toHaveLength(60);
    let area = 0;
    for (const p of layout.placements) {
      expect(p.w).toBeGreaterThan(0);
      expect(p.h).toBeGreaterThan(0);
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x + p.w).toBeLessThanOrEqual(layout.width + 1e-6);
      expect(p.y + p.h).toBeLessThanOrEqual(layout.height + 1e-6);
      area += p.w * p.h;
    }
    expect(area).toBeCloseTo(layout.width * layout.height, 3);
    const eps = 1e-6;
    for (let i = 0; i < layout.placements.length; i++) {
      for (let j = i + 1; j < layout.placements.length; j++) {
        const a = layout.placements[i];
        const b = layout.placements[j];
        const overlapX = a.x < b.x + b.w - eps && b.x < a.x + a.w - eps;
        const overlapY = a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it('matches the shape of the box it is shown in', () => {
    const layout = layoutMosaic(items(40), 2);
    expect(layout.width / layout.height).toBeCloseTo(2, 5);
  });

  it('gives the same wall for the same library whatever order it arrives in', () => {
    const list = items(30);
    const a = layoutMosaic(list, 1.5);
    const b = layoutMosaic([...list].reverse(), 1.5);
    const byId = (l: typeof a) => Object.fromEntries(l.placements.map(p => [p.id, [p.x, p.y, p.w, p.h].map(n => +n.toFixed(4))]));
    expect(byId(b)).toEqual(byId(a));
  });

  it('keeps tiles from becoming slivers', () => {
    const layout = layoutMosaic(items(80), 1.5);
    const worst = Math.max(...layout.placements.map(p => Math.max(p.w / p.h, p.h / p.w)));
    expect(worst).toBeLessThan(4);
  });

  it('handles a single item and a few thousand', () => {
    const one = layoutMosaic([{ id: 'only', score: 1 }], 1.5);
    expect(one.placements).toHaveLength(1);
    const start = Date.now();
    const big = layoutMosaic(items(2000), 1.5);
    expect(big.placements).toHaveLength(2000);
    expect(Date.now() - start).toBeLessThan(4000);
  });
});
