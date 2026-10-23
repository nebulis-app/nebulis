/**
 * Visibility check against the observer's "visible sky" map.
 *
 * The map is a 288-element boolean array representing 36 azimuth slices
 * (10° wide each, 0° at North, going clockwise) crossed with 8 elevation
 * bands, each 10° tall (centers 5°, 15°, …, 75°):
 *
 *   Band 0: 0°–10°
 *   Band 1: 10°–20°
 *   …
 *   Band 7: 70°–80°
 *
 * Elevations above 80° are treated as zenith and always visible.
 * Elevations below 0° (object below horizon) are always blocked.
 *
 * Index layout: `map[azSlice * SKY_MAP_BANDS + band]`. Index 0 = North horizon
 * band, the first 10° east of North starts at index SKY_MAP_BANDS, and so on.
 */
import { altAz } from './altaz';

export const SKY_MAP_AZ_SLICES = 36;
export const SKY_MAP_BANDS = 8;
export const SKY_MAP_CELLS = SKY_MAP_AZ_SLICES * SKY_MAP_BANDS;
const SKY_MAP_AZ_WIDTH_DEG = 360 / SKY_MAP_AZ_SLICES; // 10
export const SKY_MAP_BAND_HEIGHT_DEG = 80 / SKY_MAP_BANDS;   // 10 (covers 0-80°)

export type VisibleSkyMap = boolean[];

/** Empty map = no preference set; the visibility check treats it as fully visible. */
function isEmptyMap(map: VisibleSkyMap | null | undefined): boolean {
  return !Array.isArray(map) || map.length !== SKY_MAP_CELLS;
}

export function makeAllVisibleMap(): VisibleSkyMap {
  return Array<boolean>(SKY_MAP_CELLS).fill(true);
}

export function makeAllBlockedMap(): VisibleSkyMap {
  return Array<boolean>(SKY_MAP_CELLS).fill(false);
}

export function cellIndex(azSlice: number, band: number): number {
  return azSlice * SKY_MAP_BANDS + band;
}

/** Decompose (az, alt) into (azSlice, band). Returns null for below-horizon. */
function locateCell(az: number, alt: number): { azSlice: number; band: number } | null {
  if (alt < 0) return null;
  const azNorm = ((az % 360) + 360) % 360;
  const azSlice = Math.min(SKY_MAP_AZ_SLICES - 1, Math.floor(azNorm / SKY_MAP_AZ_WIDTH_DEG));
  if (alt >= 80) return { azSlice, band: SKY_MAP_BANDS - 1 };
  const band = Math.min(SKY_MAP_BANDS - 1, Math.floor(alt / SKY_MAP_BAND_HEIGHT_DEG));
  return { azSlice, band };
}

/** Look up whether a single (az, alt) point lies in a visible cell. */
function isPointVisible(map: VisibleSkyMap | null | undefined, az: number, alt: number): boolean {
  if (!map || isEmptyMap(map)) return true;    // no map set = treat everything as visible
  if (alt < 0) return false;                    // below horizon
  if (alt >= 80) return true;                   // zenith always visible
  const cell = locateCell(az, alt);
  if (!cell) return false;
  return map[cellIndex(cell.azSlice, cell.band)];
}

export type VisibilityVerdict = 'all' | 'partial' | 'none';

export interface BlockVisibilityResult {
  verdict: VisibilityVerdict;
  /** Fraction of sampled points that fell in a visible cell (0–1). */
  fractionVisible: number;
  /** First sample time the object went into a blocked cell, if any. */
  firstBlockedAt: Date | null;
  /** Reason summary (e.g. "Below 30° NE between 02:00 and 02:30"). Empty if all visible. */
  reason: string;
  /** Minimum altitude (degrees) the object reaches during the block. */
  minAlt: number;
  /** Maximum altitude (degrees) the object reaches during the block. */
  maxAlt: number;
}

/** Does the object ever pass through a visible cell across [start, end]? */
export function objectEverVisible(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  start: Date,
  end: Date,
  map: VisibleSkyMap | null | undefined,
  stepMinutes = 15,
): boolean {
  if (isEmptyMap(map)) return true;
  const stepMs = Math.max(1, stepMinutes) * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const { alt, az } = altAz(ra, dec, lat, lon, new Date(t));
    if (isPointVisible(map, az, alt)) return true;
  }
  return false;
}
