/**
 * Visibility check against the observer's "visible sky" map.
 *
 * The map is a 144-element boolean array representing 36 azimuth slices
 * (10° wide each, 0° at North, going clockwise) crossed with 4 elevation
 * bands centered at 10°, 30°, 50°, 70°:
 *
 *   Band 0: 0°–20°
 *   Band 1: 20°–40°
 *   Band 2: 40°–60°
 *   Band 3: 60°–80°
 *
 * Elevations above 80° are treated as zenith and always visible.
 * Elevations below 0° (object below horizon) are always blocked.
 *
 * Index layout: `map[azSlice * 4 + band]`. Index 0 = North horizon band,
 * 3 = North zenith band, 4 = first 10° east of North, and so on.
 */
import { altAz } from './altaz';

export const SKY_MAP_AZ_SLICES = 36;
export const SKY_MAP_BANDS = 4;
export const SKY_MAP_CELLS = SKY_MAP_AZ_SLICES * SKY_MAP_BANDS;
export const SKY_MAP_AZ_WIDTH_DEG = 360 / SKY_MAP_AZ_SLICES; // 10
export const SKY_MAP_BAND_HEIGHT_DEG = 80 / SKY_MAP_BANDS;   // 20 (covers 0-80°)

export type VisibleSkyMap = boolean[];

/** Empty map = no preference set; the visibility check treats it as fully visible. */
export function isEmptyMap(map: VisibleSkyMap | null | undefined): boolean {
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
export function locateCell(az: number, alt: number): { azSlice: number; band: number } | null {
  if (alt < 0) return null;
  const azNorm = ((az % 360) + 360) % 360;
  const azSlice = Math.min(SKY_MAP_AZ_SLICES - 1, Math.floor(azNorm / SKY_MAP_AZ_WIDTH_DEG));
  if (alt >= 80) return { azSlice, band: SKY_MAP_BANDS - 1 };
  const band = Math.min(SKY_MAP_BANDS - 1, Math.floor(alt / SKY_MAP_BAND_HEIGHT_DEG));
  return { azSlice, band };
}

/** Look up whether a single (az, alt) point lies in a visible cell. */
export function isPointVisible(map: VisibleSkyMap | null | undefined, az: number, alt: number): boolean {
  if (isEmptyMap(map)) return true;            // no map set = treat everything as visible
  if (alt < 0) return false;                    // below horizon
  if (alt >= 80) return true;                   // zenith always visible
  const cell = locateCell(az, alt);
  if (!cell) return false;
  return map![cellIndex(cell.azSlice, cell.band)];
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

/**
 * Check whether an object is visible across a time range, given the observer's
 * sky map. Samples at `stepMinutes` cadence (5 minutes by default — fine
 * enough that a 30-minute block gets 7 samples).
 */
export function checkBlockVisibility(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  start: Date,
  end: Date,
  map: VisibleSkyMap | null | undefined,
  stepMinutes = 5,
): BlockVisibilityResult {
  const stepMs = Math.max(1, stepMinutes) * 60 * 1000;
  let visible = 0;
  let total = 0;
  let firstBlockedAt: Date | null = null;
  let firstBlockedAz = 0;
  let firstBlockedAlt = 0;
  let minAlt = Infinity;
  let maxAlt = -Infinity;

  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const when = new Date(t);
    const { alt, az } = altAz(ra, dec, lat, lon, when);
    total += 1;
    if (alt < minAlt) minAlt = alt;
    if (alt > maxAlt) maxAlt = alt;
    if (isPointVisible(map, az, alt)) {
      visible += 1;
    } else if (firstBlockedAt === null) {
      firstBlockedAt = when;
      firstBlockedAz = az;
      firstBlockedAlt = alt;
    }
  }

  if (total === 0) {
    return { verdict: 'all', fractionVisible: 1, firstBlockedAt: null, reason: '', minAlt: 0, maxAlt: 0 };
  }
  if (isEmptyMap(map)) {
    // Skip the visibility verdict (no map configured) but keep the alt range.
    return { verdict: 'all', fractionVisible: 1, firstBlockedAt: null, reason: '', minAlt, maxAlt };
  }
  const fractionVisible = visible / total;
  let verdict: VisibilityVerdict;
  if (visible === total) verdict = 'all';
  else if (visible === 0) verdict = 'none';
  else verdict = 'partial';

  let reason = '';
  if (firstBlockedAt) {
    const compass = compassFromAzimuth(firstBlockedAz);
    const altLabel = firstBlockedAlt < 0 ? 'below horizon' : `${Math.round(firstBlockedAlt)}°`;
    reason = `Outside your viewable sky to the ${compass} (${altLabel}) from ${formatHm(firstBlockedAt)}`;
  }
  return { verdict, fractionVisible, firstBlockedAt, reason, minAlt, maxAlt };
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

function compassFromAzimuth(az: number): string {
  const az360 = ((az % 360) + 360) % 360;
  const labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const i = Math.round(az360 / 22.5) % 16;
  return labels[i];
}

function formatHm(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
