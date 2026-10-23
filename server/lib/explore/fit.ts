/**
 * Server-side port of `classifyFit` / `autoMosaicForObject` in
 * src/lib/telescopeFov.ts, so "Fits my scope" can filter a whole category
 * before paging. The field of view itself is resolved in the browser (saved
 * Framing setup, or the configured telescope) and sent with the request; this
 * only does the geometry. tests/frontend/exploreFitParity.test.ts pins the two
 * copies to the same answers.
 */
export interface FovDeg {
  widthDeg: number;
  heightDeg: number;
}

export type FitTag = 'tiny' | 'fits' | 'tight' | 'mosaic';

export interface FitAssessment {
  tag: FitTag;
  fillRatio: number;
  mosaicCols?: number;
  mosaicRows?: number;
}

const MOSAIC_OVERLAP = 0.1;
const MAX_TILES_PER_AXIS = 6;

function tilesNeeded(objDeg: number, fovDeg: number): number {
  if (objDeg <= fovDeg) return 1;
  const step = fovDeg * (1 - MOSAIC_OVERLAP);
  return Math.min(MAX_TILES_PER_AXIS, Math.ceil((objDeg - fovDeg) / step) + 1);
}

/** Objects here carry one size (the major axis), treated as a circle, which is
 *  what the client does when it has no formatted size string. Null when the
 *  size is unknown, so the caller leaves the badge off rather than guess. */
export function classifyFit(fov: FovDeg, majorAxisArcmin: number | null): FitAssessment | null {
  if (majorAxisArcmin == null || !Number.isFinite(majorAxisArcmin) || majorAxisArcmin <= 0) return null;
  const objDeg = majorAxisArcmin / 60;
  const fillRatio = Math.max(objDeg / fov.widthDeg, objDeg / fov.heightDeg);
  const cols = tilesNeeded(objDeg, fov.widthDeg);
  const rows = tilesNeeded(objDeg, fov.heightDeg);
  if (cols > 1 || rows > 1) return { tag: 'mosaic', fillRatio, mosaicCols: cols, mosaicRows: rows };
  if (fillRatio >= 0.75) return { tag: 'tight', fillRatio };
  if (fillRatio < 0.15) return { tag: 'tiny', fillRatio };
  return { tag: 'fits', fillRatio };
}

/** "Fits my scope": one frame holds it without it being lost in the frame.
 *  Mosaic targets and specks are both out; a tight crop is still in. */
export function fitsScope(fit: FitAssessment | null): boolean {
  return fit !== null && (fit.tag === 'fits' || fit.tag === 'tight');
}
