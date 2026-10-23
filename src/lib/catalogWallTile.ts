/** Small shared helpers for wall tiles (kept out of component files for fast refresh). */
import type { WallSpan, WallTile } from './api/catalogs';

/** Label for a tile: its id plus any objects sharing its frame ("M42 · M43"). */
export function tileLabel(tile: WallTile): string {
  return [tile.id, ...tile.mergedIds].join(' · ');
}

/** Sizes offered in the edit-mode picker. */
export const SPAN_CHOICES: WallSpan[] = [
  { cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 1, rows: 2 }, { cols: 2, rows: 2 },
  { cols: 3, rows: 2 }, { cols: 2, rows: 3 }, { cols: 3, rows: 3 }, { cols: 4, rows: 2 },
];
