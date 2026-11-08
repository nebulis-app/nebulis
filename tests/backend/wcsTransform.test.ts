import { describe, expect, it } from 'vitest';
import {
  approximateWcs, pixelToSky, scaleWcs, skyToPixel, transformWcs,
  type EditRotation, type GeometryEdit, type Wcs,
} from '../../server/lib/annotate/wcs';
import { editGrid, findInGrid as find, makeGrid } from './gridEdit';

const W = 12, H = 8;
const bottomUp: Wcs = { ...approximateWcs({ raDeg: 83.8, decDeg: -5.4, width: W, height: H, longSideDeg: 1.2 }) };
// The same sky laid on a top-down array with a slight roll, as Dwarf writes it.
const topDown: Wcs = {
  crval1: 83.8, crval2: -5.4, crpix1: 6.5, crpix2: 4.5, width: W, height: H, yDown: true,
  cd: { cd11: -0.09, cd12: 0.02, cd21: 0.02, cd22: 0.09 },
};

const ROTATIONS: EditRotation[] = [0, 90, 180, 270];
const EDITS: Array<[string, GeometryEdit]> = [];
for (const rotation of ROTATIONS) {
  for (const flipH of [false, true]) {
    for (const flipV of [false, true]) {
      EDITS.push([`rotate ${rotation}${flipH ? ' flipH' : ''}${flipV ? ' flipV' : ''}`, { rotation, flipH, flipV }]);
    }
  }
}
const CROP = { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.875 }; // 6 x 5 cells of the 12 x 8 grid
EDITS.push(['crop', { crop: CROP }]);
EDITS.push(['crop and rotate 90', { crop: CROP, rotation: 90 }]);
EDITS.push(['crop, flip and rotate 270', { crop: CROP, flipH: true, rotation: 270 }]);

/** Every cell of the old picture must land, by sky position, on the cell the edit moved it to. */
function expectEveryCellFollows(wcs: Wcs, edit: GeometryEdit): void {
  const next = transformWcs(wcs, edit);
  const before = makeGrid(W, H);
  const after = editGrid(before, edit);
  expect(next.width).toBe(after[0].length);
  expect(next.height).toBe(after.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const moved = find(after, before[y][x]);
      if (!moved) continue; // cropped away
      const sky = pixelToSky(wcs, x + 0.5, y + 0.5);
      const at = skyToPixel(next, sky.raDeg, sky.decDeg);
      expect(at).not.toBeNull();
      expect(at!.x).toBeCloseTo(moved.x + 0.5, 6);
      expect(at!.y).toBeCloseTo(moved.y + 0.5, 6);
    }
  }
}

describe('transformWcs', () => {
  describe.each(EDITS)('%s', (_name, edit) => {
    it('keeps every star on its own pixel (bottom-up FITS solution)', () => expectEveryCellFollows(bottomUp, edit));
    it('keeps every star on its own pixel (top-down solution)', () => expectEveryCellFollows(topDown, edit));
  });

  it('leaves the sky position of the reference point alone', () => {
    const next = transformWcs(bottomUp, { rotation: 90, flipH: true });
    expect(next.crval1).toBe(bottomUp.crval1);
    expect(next.crval2).toBe(bottomUp.crval2);
  });

  it('keeps the pixel scale', () => {
    const next = transformWcs(topDown, { crop: CROP, rotation: 90 });
    const det = (w: Wcs) => Math.abs(w.cd.cd11 * w.cd.cd22 - w.cd.cd12 * w.cd.cd21);
    expect(det(next)).toBeCloseTo(det(topDown), 12);
  });

  it('gives a solution the shape check accepts for the edited picture', () => {
    // A portrait picture turned on its side: the case scaleWcs used to reject.
    const portrait = approximateWcs({ raDeg: 300, decDeg: 30, width: 3672, height: 6528, longSideDeg: 3 });
    const next = transformWcs(portrait, { rotation: 90 });
    expect(scaleWcs(portrait, 6528, 3672)).toBeNull();
    expect(scaleWcs(next, 6528, 3672)).not.toBeNull();
    expect(scaleWcs(next, 2048, 1151)).not.toBeNull();
  });

  it('composes: two edits equal their combined result', () => {
    const once = transformWcs(transformWcs(bottomUp, { rotation: 90 }), { flipH: true });
    const edge = skyToPixel(once, ...skyOf(bottomUp, 0.5, 0.5));
    // Cell (0,0) turned 90 degrees clockwise lands top-right of an 8 x 12 picture, then the flip mirrors it.
    expect(edge!.x).toBeCloseTo(0.5, 6);
    expect(edge!.y).toBeCloseTo(0.5, 6);
  });
});

function skyOf(w: Wcs, x: number, y: number): [number, number] {
  const s = pixelToSky(w, x, y);
  return [s.raDeg, s.decDeg];
}
