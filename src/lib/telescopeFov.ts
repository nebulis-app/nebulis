/**
 * Field-of-view profiles for smart telescopes, plus the geometry helpers the
 * framing overlay uses to draw a sensor rectangle (and mosaic grid) over a
 * catalog sky image.
 *
 * Smart telescopes have fixed optics and a fixed sensor, so each model has one
 * known field of view. That makes this a lookup table rather than a
 * camera/lens calculator. For anything not listed, `fovFromOptics` derives the
 * FOV from focal length + sensor dimensions (the general camera case).
 *
 * FOV values are the imaging field for the model's primary (telephoto) mode,
 * width × height in degrees. They are approximate: verify against the
 * manufacturer spec sheet before treating any single number as exact. Where a
 * datasheet publishes sensor size and focal length, the value here is
 * `2·atan(sensorMm / (2·focalMm))`.
 */
import type { TelescopeKind } from './telescopePresets';

export interface FovProfile {
  id: string;
  label: string;
  /** Full imaging field width in degrees. */
  widthDeg: number;
  /** Full imaging field height in degrees. */
  heightDeg: number;
  /** Native long-frame orientation is landscape for all current models. */
  vendor: 'ZWO' | 'DwarfLab' | 'Vaonis' | 'Unistellar' | 'Custom';
}

/**
 * The catalog value used to pick a sensible default view zoom. Ordered so the
 * first entry is the most common starter scope.
 */
export const FOV_PROFILES: FovProfile[] = [
  { id: 'seestar-s50', label: 'ZWO SeeStar S50', widthDeg: 1.28, heightDeg: 0.73, vendor: 'ZWO' },
  { id: 'seestar-s30', label: 'ZWO SeeStar S30', widthDeg: 2.14, heightDeg: 1.22, vendor: 'ZWO' },
  { id: 'dwarf-3', label: 'DwarfLab Dwarf 3', widthDeg: 2.94, heightDeg: 1.65, vendor: 'DwarfLab' },
  { id: 'dwarf-2', label: 'DwarfLab Dwarf II', widthDeg: 3.20, heightDeg: 1.80, vendor: 'DwarfLab' },
  { id: 'dwarf-mini', label: 'DwarfLab Dwarf Mini', widthDeg: 2.90, heightDeg: 1.63, vendor: 'DwarfLab' },
  { id: 'vespera', label: 'Vaonis Vespera', widthDeg: 1.60, heightDeg: 0.90, vendor: 'Vaonis' },
  { id: 'vespera-2', label: 'Vaonis Vespera II', widthDeg: 2.50, heightDeg: 1.40, vendor: 'Vaonis' },
  { id: 'vespera-pro', label: 'Vaonis Vespera Pro', widthDeg: 1.60, heightDeg: 0.90, vendor: 'Vaonis' },
  { id: 'stellina', label: 'Vaonis Stellina', widthDeg: 1.00, heightDeg: 0.70, vendor: 'Vaonis' },
  { id: 'evscope-2', label: 'Unistellar eVscope 2', widthDeg: 0.75, heightDeg: 0.56, vendor: 'Unistellar' },
  { id: 'equinox-2', label: 'Unistellar eQuinox 2', widthDeg: 0.68, heightDeg: 0.51, vendor: 'Unistellar' },
];

export const DEFAULT_FOV_PROFILE_ID = 'seestar-s50';

/** Map an owned telescope's `kind` to the matching framing profile id. */
export function fovProfileIdForKind(kind: TelescopeKind | null | undefined): string {
  if (!kind || kind === 'other') return DEFAULT_FOV_PROFILE_ID;
  // The imported kinds share ids with the profile table above.
  return FOV_PROFILES.some(p => p.id === kind) ? kind : DEFAULT_FOV_PROFILE_ID;
}

export function fovProfileById(id: string): FovProfile | undefined {
  return FOV_PROFILES.find(p => p.id === id);
}

/** Derive FOV (degrees) from focal length and sensor dimensions (all mm). */
export function fovFromOptics(focalMm: number, sensorWidthMm: number, sensorHeightMm: number): { widthDeg: number; heightDeg: number } {
  const toDeg = (mm: number) => (2 * Math.atan(mm / (2 * focalMm)) * 180) / Math.PI;
  return { widthDeg: toDeg(sensorWidthMm), heightDeg: toDeg(sensorHeightMm) };
}

// ─── Object angular size ────────────────────────────────────────────────

export interface ObjectExtentArcmin {
  widthArcmin: number;
  heightArcmin: number;
}

/**
 * Best-effort object angular extent in arcminutes. Prefers the formatted size
 * string (e.g. "13.2' x 7.9'"), then falls back to the major axis (treated as
 * a circle). Returns null when nothing is known.
 */
export function objectExtentArcmin(
  size: string | null | undefined,
  majorAxisArcmin: number | null | undefined,
): ObjectExtentArcmin | null {
  if (size) {
    // Match one or two arcminute figures: "13.2' x 7.9'", "45'", "1.5' × 1.5'".
    const nums = size.match(/(\d+(?:\.\d+)?)/g);
    if (nums && nums.length >= 1) {
      const w = parseFloat(nums[0]);
      const h = nums.length >= 2 ? parseFloat(nums[1]) : w;
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0) {
        return { widthArcmin: w, heightArcmin: h > 0 ? h : w };
      }
    }
  }
  if (majorAxisArcmin != null && Number.isFinite(majorAxisArcmin) && majorAxisArcmin > 0) {
    return { widthArcmin: majorAxisArcmin, heightArcmin: majorAxisArcmin };
  }
  return null;
}

// ─── Mosaic geometry ──────────────────────────────────────────────────────

export interface MosaicPlan {
  cols: number;
  rows: number;
  /** Overlap fraction between adjacent tiles (0–0.5). */
  overlap: number;
  /** Total field covered by the tiled grid, in degrees. */
  coverageWidthDeg: number;
  coverageHeightDeg: number;
}

/** Total ground the mosaic covers given per-tile FOV, grid size and overlap. */
export function mosaicCoverageDeg(
  fov: { widthDeg: number; heightDeg: number },
  cols: number,
  rows: number,
  overlap: number,
): { coverageWidthDeg: number; coverageHeightDeg: number } {
  const stepX = fov.widthDeg * (1 - overlap);
  const stepY = fov.heightDeg * (1 - overlap);
  return {
    coverageWidthDeg: fov.widthDeg + Math.max(0, cols - 1) * stepX,
    coverageHeightDeg: fov.heightDeg + Math.max(0, rows - 1) * stepY,
  };
}

/**
 * Smallest cols × rows that covers an object of the given extent, ignoring
 * rotation (an approximation, since we rarely know the object's position
 * angle). Returns 1×1 when a single frame already contains it.
 */
export function autoMosaicForObject(
  fov: { widthDeg: number; heightDeg: number },
  object: ObjectExtentArcmin,
  overlap: number,
  maxTilesPerAxis = 6,
): { cols: number; rows: number } {
  const objWDeg = object.widthArcmin / 60;
  const objHDeg = object.heightArcmin / 60;
  const need = (objDeg: number, fovDeg: number) => {
    if (objDeg <= fovDeg) return 1;
    const step = fovDeg * (1 - overlap);
    return Math.min(maxTilesPerAxis, Math.ceil((objDeg - fovDeg) / step) + 1);
  };
  return { cols: need(objWDeg, fov.widthDeg), rows: need(objHDeg, fov.heightDeg) };
}

/** Human summary of whether an object fits, e.g. "Fits in one frame" or "Needs a 3 × 1 mosaic". */
export function fitVerdict(
  fov: { widthDeg: number; heightDeg: number },
  object: ObjectExtentArcmin | null,
): string {
  if (!object) return 'Angular size unknown';
  const { cols, rows } = autoMosaicForObject(fov, object, 0.1);
  if (cols === 1 && rows === 1) return 'Fits in a single frame';
  return `Needs a ${cols} × ${rows} mosaic to capture fully`;
}

/** Format a degree value as degrees or arcminutes, whichever reads cleaner. */
export function formatFovDeg(deg: number): string {
  if (deg < 1) return `${Math.round(deg * 60)}′`;
  return `${deg.toFixed(2)}°`;
}
