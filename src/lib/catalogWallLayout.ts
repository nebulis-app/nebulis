/**
 * Layout for the "My Catalog" wall.
 *
 * One pure function places every tile on an explicit grid, and both the
 * on-screen wall and the poster renderer call it. That is what keeps the poster
 * a faithful copy of what the user sees (and of any size edits they made):
 * neither relies on the browser's own grid auto-placement.
 */
import type { WallSpan } from './api/catalogs';

export interface LayoutItem {
  key: string;
  span: WallSpan;
}

export interface Placement extends LayoutItem {
  /** 0-based cell coordinates of the tile's top-left corner. */
  col: number;
  row: number;
  /** The span actually used, after clamping to the column count. */
  placed: WallSpan;
}

export interface WallLayout {
  placements: Placement[];
  rows: number;
}

/** Column count for a container width. Phones land on 4, a wide desktop on ~17. */
export function columnsForWidth(widthPx: number): number {
  return Math.min(17, Math.max(4, Math.round(widthPx / 110)));
}

/**
 * First-fit "dense" packing in reading order: each tile takes the earliest free
 * spot where it fits, so smaller tiles later in the list fill holes beside big
 * ones. A span wider than the grid shrinks to the grid (keeping its shape as
 * closely as it can) while the saved span stays untouched in the data.
 */
export function layoutWall(items: LayoutItem[], columns: number): WallLayout {
  const cols = Math.max(1, Math.floor(columns));
  // occupied[row] is a boolean row of length `cols`, grown on demand.
  const occupied: boolean[][] = [];
  const rowAt = (r: number) => (occupied[r] ??= new Array<boolean>(cols).fill(false));

  const fits = (c: number, r: number, w: number, h: number): boolean => {
    if (c + w > cols) return false;
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (rowAt(y)[x]) return false;
    return true;
  };

  const placements: Placement[] = [];
  for (const item of items) {
    const w = Math.max(1, Math.min(cols, item.span.cols));
    // A tile squeezed in width keeps roughly its area by growing taller, but never
    // past its saved height: a 3x2 on a 2-column grid becomes 2x2, not 2x3.
    const h = Math.max(1, item.span.rows);
    let spot: { c: number; r: number } | null = null;
    for (let r = 0; !spot; r++) {
      for (let c = 0; c + w <= cols; c++) {
        if (fits(c, r, w, h)) { spot = { c, r }; break; }
      }
    }
    for (let y = spot.r; y < spot.r + h; y++) for (let x = spot.c; x < spot.c + w; x++) rowAt(y)[x] = true;
    placements.push({ ...item, col: spot.c, row: spot.r, placed: { cols: w, rows: h } });
  }
  return { placements, rows: occupied.length };
}
