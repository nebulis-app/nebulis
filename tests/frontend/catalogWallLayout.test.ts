import { describe, it, expect } from 'vitest';
import { layoutWall, columnsForWidth } from '../../src/lib/catalogWallLayout';

const item = (key: string, cols = 1, rows = 1) => ({ key, span: { cols, rows } });

describe('columnsForWidth', () => {
  it('clamps between 4 and 17', () => {
    expect(columnsForWidth(300)).toBe(4);
    expect(columnsForWidth(390)).toBe(4);
    expect(columnsForWidth(1900)).toBe(17);
    expect(columnsForWidth(4000)).toBe(17);
  });
});

describe('layoutWall', () => {
  it('places 1x1 tiles in reading order', () => {
    const { placements, rows } = layoutWall([item('a'), item('b'), item('c')], 2);
    expect(placements.map(p => [p.col, p.row])).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(rows).toBe(2);
  });

  it('backfills holes beside a large tile with later small ones', () => {
    const { placements } = layoutWall([item('big', 2, 2), item('a'), item('b'), item('c')], 3);
    const at = (k: string) => placements.find(p => p.key === k)!;
    expect([at('big').col, at('big').row]).toEqual([0, 0]);
    expect([at('a').col, at('a').row]).toEqual([2, 0]);
    expect([at('b').col, at('b').row]).toEqual([2, 1]);
    expect([at('c').col, at('c').row]).toEqual([0, 2]);
  });

  it('never overlaps tiles', () => {
    const items = [item('a', 3, 2), item('b', 2, 2), item('c'), item('d', 2, 1), item('e', 1, 2), item('f', 2, 3), item('g')];
    const { placements } = layoutWall(items, 5);
    const seen = new Set<string>();
    for (const p of placements) {
      for (let y = p.row; y < p.row + p.placed.rows; y++) {
        for (let x = p.col; x < p.col + p.placed.cols; x++) {
          const k = `${x},${y}`;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
    }
  });

  it('shrinks a span wider than the grid without touching the saved span', () => {
    const { placements } = layoutWall([item('wide', 3, 2)], 2);
    expect(placements[0].placed).toEqual({ cols: 2, rows: 2 });
    expect(placements[0].span).toEqual({ cols: 3, rows: 2 });
  });
});
