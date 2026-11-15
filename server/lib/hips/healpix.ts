/**
 * The HEALPix pixelization, cut down to the one direction a HiPS renderer needs: sky position in, tile and
 * sub-tile position out.
 *
 * A HiPS tile at order N is one HEALPix cell at nside 2^N, held as a 512x512 raster of that cell's square in the
 * HEALPix projection plane. So the same mapping that finds the cell also gives the position inside the tile, and
 * pixels are sampled from the raster rather than from the sphere.
 *
 * The projection steps are the ones in the HEALPix paper as implemented by healpy and by the MIT `@hscmap/healpix`
 * package: (z, a) -> (t, u) -> (face, p, q) -> (face, ix, iy). `tests/backend/hipsHealpix.test.ts` pins this
 * against healpy, including the sub-tile layout, which is the part that would silently make every cutout wrong.
 */

const PI = Math.PI;
const HALF_PI = PI / 2;
const QUARTER_PI = PI / 4;
const TWO_PI = 2 * PI;

/** A tile raster is 512x512 by the HiPS recommendation, and every host we read from uses that. */
export const TILE_PIXELS = 512;

export interface TilePosition {
  /** HEALPix NESTED pixel index at the tile's order, which is also the tile number on disk. */
  tile: number;
  face: number;
  /** Cell within the face, in tile units. */
  ix: number;
  iy: number;
  /** Position inside the cell, 0 to 1. Multiply by TILE_PIXELS for raster coordinates. */
  fx: number;
  fy: number;
}

/** Positive modulo, as the projection needs for azimuth and quadrant arithmetic. */
function wrap(value: number, period: number): number {
  return value < 0 ? period - (-value % period) : value % period;
}

function clip(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Latitude of the boundary between the equatorial belt and a polar cap, as the signed distance the polar faces use:
 * 1 at the cap edge (z = 2/3) and 0 at the pole.
 */
function capCoordinate(z: number): number {
  const magnitude = 2 - Math.sqrt(3 * (1 - Math.abs(z)));
  return z < 0 ? -magnitude : magnitude;
}

/** Interleave the bits of two cell indices into one NESTED pixel index. */
export function bitCombine(x: number, y: number): number {
  let combined = 0;
  for (let bit = 0; bit < 16; bit++) {
    combined |= ((x >> bit) & 1) << (2 * bit);
    combined |= ((y >> bit) & 1) << (2 * bit + 1);
  }
  return combined;
}

/**
 * An azimuth nudge for positions that land exactly on a face edge, where the projection has no side to fall on.
 * One nanoradian is a millionth of a tile pixel: invisible in the output, and enough to choose the neighbouring
 * face instead of failing. Without it, an object at a whole-degree RA in the polar cap renders as nothing.
 */
const FACE_EDGE_NUDGE = 1e-9;

/**
 * Where a sky position falls: which tile at `order`, and where inside that tile.
 *
 * `raRad` is 0 to 2π and `decRad` is -π/2 to π/2.
 */
export function skyToTile(raRad: number, decRad: number, order: number): TilePosition {
  const z = Math.sin(decRad);
  const a = wrap(raRad, TWO_PI);
  const onFace = faceOf(a, z);
  if (onFace.faceRow >= 0) return cellOf(onFace, order);
  // Exactly on a face edge: either neighbouring face is a correct answer, so take the one a hair to the east.
  const nudged = faceOf(wrap(a + FACE_EDGE_NUDGE, TWO_PI), z);
  if (nudged.faceRow >= 0) return cellOf(nudged, order);
  // Only reachable if the nudge is swallowed by rounding at a face corner. Forcing the face row into range still
  // names a face that touches this position, which beats refusing to render it.
  return cellOf({ ...onFace, faceRow: 0 }, order);
}

interface FacePosition {
  /** 0 to 2 for a real face, -1 where the projection lands outside every face. */
  faceRow: number;
  pFace: number;
  qFace: number;
  pp: number;
  qq: number;
}

/** The projection proper: (z, a) to the face and the position inside it. */
function faceOf(a: number, z: number): FacePosition {
  // (z, a) -> (t, u): the equatorial belt is a plain equal-area rectangle, the caps fold around their pole.
  let t: number;
  let u: number;
  if (Math.abs(z) <= 2 / 3) {
    t = a;
    u = (3 * PI * z) / 8;
  } else {
    const s = capCoordinate(z);
    const withinQuadrant = wrap(a, HALF_PI);
    t = a - (Math.abs(s) - 1) * (withinQuadrant - QUARTER_PI);
    u = QUARTER_PI * s;
  }

  // (t, u) -> the face and the position inside it, in face units where each face is one unit square.
  const tQuadrants = wrap(t / QUARTER_PI, 8) - 4;
  const uQuadrants = u / QUARTER_PI + 5;
  const pp = clip((uQuadrants + tQuadrants) / 2, 0, 5);
  const pFace = Math.floor(pp);
  const qq = clip((uQuadrants - tQuadrants) / 2, 3 - pFace, 6 - pFace);
  const qFace = Math.floor(qq);
  return { faceRow: 5 - (pFace + qFace), pFace, qFace, pp, qq };
}

/** Face units to cell units. A cell is one HEALPix pixel at this order, and one tile raster. */
function cellOf(position: FacePosition, order: number): TilePosition {
  const { faceRow, pFace, qFace, pp, qq } = position;
  const face = 4 * faceRow + ((pFace - qFace + 4) >> 1) % 4;
  const nside = 2 ** order;
  const x = (pp - pFace) * nside;
  const y = (qq - qFace) * nside;
  const ix = Math.min(Math.floor(x), nside - 1);
  const iy = Math.min(Math.floor(y), nside - 1);

  return {
    tile: face * nside * nside + bitCombine(ix, iy),
    face,
    ix,
    iy,
    fx: x - ix,
    fy: y - iy,
  };
}
