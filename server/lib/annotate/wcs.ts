/**
 * A plate solution (WCS) and the maths to move between image pixels and the sky.
 *
 * The solution follows the FITS convention ASTAP writes: gnomonic (TAN)
 * projection, 1-based pixels, +y pointing UP. Every image we draw on is stored
 * top-down (JPEG/PNG/TIFF row 0 is the top), so `skyToPixel`/`pixelToSky` take
 * and return top-left, y-down, continuous pixel coordinates (0,0 = the top-left
 * corner of the first pixel) and do the flip internally. Callers never see the
 * FITS convention.
 *
 * A solution is tied to the pixel grid it was solved on (`width` x `height`).
 * `scaleWcs` re-expresses it for a same-shaped image at another resolution, so
 * a solve done on a 2048 px preview still lands correctly on the original.
 */
import type { CdMatrix } from '../fitsWcs.js';

export interface Wcs {
  /** Sky position of the reference pixel, degrees. */
  crval1: number;
  crval2: number;
  /** Reference pixel, FITS 1-based, +y up. */
  crpix1: number;
  crpix2: number;
  /** Degrees of sky per pixel step (row 1 east, row 2 north). */
  cd: CdMatrix;
  /** Pixel grid the solution was made on. */
  width: number;
  height: number;
  /**
   * Row direction of the solved array relative to the picture. Unset/false is
   * the classic FITS convention (row 1 at the BOTTOM), which `skyToPixel`
   * flips into a top-down picture. True means the array's row 1 is already the
   * TOP row, so no flip is wanted. Dwarf writes its FITS this way. Use
   * `wcsFromFitsSolution` to set this; do not guess it by hand.
   */
  yDown?: boolean;
}

/** Read a Wcs back from stored JSON (the fileWcs cache), checking every field
 *  rather than trusting the text. Null when anything is missing or not a finite
 *  number, which callers treat as "no cached solution". */
export function parseWcs(value: unknown): Wcs | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const num = (key: string): number | null => {
    const v: unknown = Reflect.get(value, key);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const cdRaw: unknown = Reflect.get(value, 'cd');
  if (typeof cdRaw !== 'object' || cdRaw === null) return null;
  const cdNum = (key: string): number | null => {
    const v: unknown = Reflect.get(cdRaw, key);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const crval1 = num('crval1'), crval2 = num('crval2'), crpix1 = num('crpix1'), crpix2 = num('crpix2');
  const width = num('width'), height = num('height');
  const cd11 = cdNum('cd11'), cd12 = cdNum('cd12'), cd21 = cdNum('cd21'), cd22 = cdNum('cd22');
  if (
    crval1 === null || crval2 === null || crpix1 === null || crpix2 === null ||
    width === null || height === null ||
    cd11 === null || cd12 === null || cd21 === null || cd22 === null
  ) return null;
  const wcs: Wcs = { crval1, crval2, crpix1, crpix2, cd: { cd11, cd12, cd21, cd22 }, width, height };
  const yDown: unknown = Reflect.get(value, 'yDown');
  if (typeof yDown === 'boolean') wcs.yDown = yDown;
  return wcs;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface SkyPoint {
  raDeg: number;
  decDeg: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

/** Sky → image pixel, or null when the point is on the far side of the sky
 *  from the tangent point (the TAN projection is undefined there). */
export function skyToPixel(wcs: Wcs, raDeg: number, decDeg: number): ImagePoint | null {
  const a = raDeg * D2R;
  const d = decDeg * D2R;
  const a0 = wcs.crval1 * D2R;
  const d0 = wcs.crval2 * D2R;
  const dRa = a - a0;
  const cosc = Math.sin(d) * Math.sin(d0) + Math.cos(d) * Math.cos(d0) * Math.cos(dRa);
  if (cosc <= 1e-9) return null;
  // Standard coordinates in degrees (xi east, eta north).
  const xi = (Math.cos(d) * Math.sin(dRa) / cosc) * R2D;
  const eta = ((Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dRa)) / cosc) * R2D;

  const { cd11, cd12, cd21, cd22 } = wcs.cd;
  const det = cd11 * cd22 - cd12 * cd21;
  if (det === 0) return null;
  const u = (cd22 * xi - cd12 * eta) / det;
  const v = (-cd21 * xi + cd11 * eta) / det;

  const xFits = wcs.crpix1 + u;
  const yFits = wcs.crpix2 + v;
  // FITS pixel p is centred on p, so the continuous coordinate is p - 0.5; the
  // vertical axis is then flipped to run top-down.
  return { x: xFits - 0.5, y: wcs.yDown ? yFits - 0.5 : wcs.height - (yFits - 0.5) };
}

/** Image pixel (top-left, y down, continuous) → sky position. */
export function pixelToSky(wcs: Wcs, x: number, y: number): SkyPoint {
  const u = (x + 0.5) - wcs.crpix1;
  const v = (wcs.yDown ? y + 0.5 : wcs.height - y + 0.5) - wcs.crpix2;
  const { cd11, cd12, cd21, cd22 } = wcs.cd;
  const xi = (cd11 * u + cd12 * v) * D2R;
  const eta = (cd21 * u + cd22 * v) * D2R;
  const a0 = wcs.crval1 * D2R;
  const d0 = wcs.crval2 * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return { raDeg: wcs.crval1, decDeg: wcs.crval2 };
  const c = Math.atan(rho);
  const sinc = Math.sin(c);
  const cosc = Math.cos(c);
  const dec = Math.asin(cosc * Math.sin(d0) + (eta * sinc * Math.cos(d0)) / rho);
  const ra = a0 + Math.atan2(xi * sinc, rho * Math.cos(d0) * cosc - eta * Math.sin(d0) * sinc);
  return { raDeg: (((ra * R2D) % 360) + 360) % 360, decDeg: dec * R2D };
}

/** Arcseconds per pixel at the reference point. */
export function pixelScaleArcsec(wcs: Wcs): number {
  const det = Math.abs(wcs.cd.cd11 * wcs.cd.cd22 - wcs.cd.cd12 * wcs.cd.cd21);
  return Math.sqrt(det) * 3600;
}

/** Re-express a solution for the same picture at `width` x `height`. Rejects
 *  (returns null) a shape that is not the same picture, because scaling would
 *  then silently stretch the sky. */
export function scaleWcs(wcs: Wcs, width: number, height: number, aspectTolerance = 0.02): Wcs | null {
  const sx = width / wcs.width;
  const sy = height / wcs.height;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return null;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > aspectTolerance) return null;
  const s = (sx + sy) / 2;
  return {
    crval1: wcs.crval1,
    crval2: wcs.crval2,
    crpix1: (wcs.crpix1 - 0.5) * s + 0.5,
    crpix2: (wcs.crpix2 - 0.5) * s + 0.5,
    cd: {
      cd11: wcs.cd.cd11 / s,
      cd12: wcs.cd.cd12 / s,
      cd21: wcs.cd.cd21 / s,
      cd22: wcs.cd.cd22 / s,
    },
    width,
    height,
    ...(wcs.yDown ? { yDown: true } : {}),
  };
}

/**
 * Whether a solution describes sky with the parity of an ordinary picture
 * (east to the left when north is up). In the classic FITS frame (row 1 at the
 * bottom) that means a NEGATIVE CD determinant.
 */
export function hasNormalParity(cd: CdMatrix): boolean {
  return cd.cd11 * cd.cd22 - cd.cd12 * cd.cd21 < 0;
}

/**
 * Fix the row direction of a solution read from a FITS file (a header's WCS, or
 * ASTAP's solve of the FITS itself) so it lands correctly on a picture made
 * from that file.
 *
 * FITS says row 1 is the bottom, but not every writer obeys: Dwarf stores the
 * top row first. The file does not say which, so it is read from the sky: a
 * picture shown to a person is never mirrored, so whichever row direction gives
 * an ordinary-parity picture is the right one. A bottom-up array with a normal
 * solution keeps the usual flip; a solution with mirrored parity can only be a
 * top-down array, so the flip is skipped.
 */
export function wcsFromFitsSolution(wcs: Wcs): Wcs {
  return hasNormalParity(wcs.cd) ? { ...wcs, yDown: false } : { ...wcs, yDown: true };
}

/** Great-circle separation in degrees (haversine). */
export function angularSeparationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const p1 = dec1 * D2R;
  const p2 = dec2 * D2R;
  const dp = p2 - p1;
  const dl = (ra2 - ra1) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * R2D;
}

/**
 * A north-up, unrotated solution centred on (raDeg, decDeg) whose long side
 * spans `longSideDeg`. This is the "assume the frame is centred and square to
 * the sky" guess used when nothing better is known.
 */
export function approximateWcs(opts: {
  raDeg: number;
  decDeg: number;
  width: number;
  height: number;
  longSideDeg: number;
}): Wcs {
  const { raDeg, decDeg, width, height, longSideDeg } = opts;
  const scale = longSideDeg / Math.max(width, height);
  return {
    crval1: raDeg,
    crval2: decDeg,
    crpix1: (width + 1) / 2,
    crpix2: (height + 1) / 2,
    // East is to the left on a normally oriented image, north up.
    cd: { cd11: -scale, cd12: 0, cd21: 0, cd22: scale },
    width,
    height,
  };
}
