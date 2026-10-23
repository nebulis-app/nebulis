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
import type { TelescopeProfile, TelescopeOpticalConfig } from './api/telescopes';
import { isRecord } from './typeGuards';

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
export const DEFAULT_FOV_PROFILE_ID = 'seestar-s50';

/** The generic fallback profile, held by name so callers that need "some
 *  profile, always" get a `FovProfile` rather than a `find()` result plus a
 *  non-null assertion. Same object as `FOV_PROFILES[0]`. */
const DEFAULT_FOV_PROFILE: FovProfile = {
  id: DEFAULT_FOV_PROFILE_ID, label: 'ZWO SeeStar S50', widthDeg: 1.28, heightDeg: 0.73, vendor: 'ZWO',
};

export const FOV_PROFILES: FovProfile[] = [
  DEFAULT_FOV_PROFILE,
  { id: 'seestar-s50-pro', label: 'ZWO SeeStar S50 Pro', widthDeg: 2.45, heightDeg: 1.38, vendor: 'ZWO' },
  { id: 'seestar-s30', label: 'ZWO SeeStar S30', widthDeg: 2.14, heightDeg: 1.22, vendor: 'ZWO' },
  { id: 'seestar-s30-pro', label: 'ZWO SeeStar S30 Pro', widthDeg: 3.99, heightDeg: 2.24, vendor: 'ZWO' },
  { id: 'dwarf-3', label: 'DwarfLab Dwarf 3', widthDeg: 2.94, heightDeg: 1.65, vendor: 'DwarfLab' },
  { id: 'dwarf-2', label: 'DwarfLab Dwarf II', widthDeg: 3.20, heightDeg: 1.80, vendor: 'DwarfLab' },
  { id: 'dwarf-mini', label: 'DwarfLab Dwarf Mini', widthDeg: 2.13, heightDeg: 1.20, vendor: 'DwarfLab' },
  { id: 'vespera', label: 'Vaonis Vespera', widthDeg: 1.60, heightDeg: 0.90, vendor: 'Vaonis' },
  { id: 'vespera-2', label: 'Vaonis Vespera II', widthDeg: 2.50, heightDeg: 1.40, vendor: 'Vaonis' },
  { id: 'vespera-pro', label: 'Vaonis Vespera Pro', widthDeg: 1.60, heightDeg: 1.60, vendor: 'Vaonis' },
  { id: 'stellina', label: 'Vaonis Stellina', widthDeg: 1.00, heightDeg: 0.70, vendor: 'Vaonis' },
  { id: 'evscope-2', label: 'Unistellar eVscope 2', widthDeg: 0.75, heightDeg: 0.56, vendor: 'Unistellar' },
  { id: 'equinox-2', label: 'Unistellar eQuinox 2', widthDeg: 0.76, heightDeg: 0.57, vendor: 'Unistellar' },
];

/** Map an owned telescope's `kind` to the matching framing profile id. */
export function fovProfileIdForKind(kind: TelescopeKind | null | undefined): string {
  // 'asiair' is grouped with 'other' rather than given a profile of its own: an
  // ASIAIR is a controller, not an optic, so its field is whatever telescope
  // and camera the user attached. There is no per-kind answer to give, and
  // inventing one would put a confidently wrong rectangle on the sky. Users
  // with an ASIAIR should pick a profile by hand or enter their own optics.
  if (!kind || kind === 'other' || kind === 'asiair') return DEFAULT_FOV_PROFILE_ID;
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

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** Format a degree value as degrees or arcminutes, whichever reads cleaner. */
export function formatFovDeg(deg: number): string {
  if (deg < 1) return `${Math.round(deg * 60)}′`;
  return `${deg.toFixed(2)}°`;
}

// ─── Plate scale (arcsec/pixel) ───────────────────────────────────────────

/** Plate scale in arcsec/pixel: `206.265 · pixelSizeUm / focalMm`. Only
 *  meaningful for a custom rig, since the built-in FOV_PROFILES are looked up
 *  by imaging field rather than derived from a focal length + pixel pitch. */
export function arcsecPerPixel(focalMm: number, pixelSizeUm: number): number {
  if (focalMm <= 0 || pixelSizeUm <= 0) return 0;
  return (206.265 * pixelSizeUm) / focalMm;
}

// ─── Fit classification (Planner list badge + Framing modal verdict) ─────

export type FitTag = 'tiny' | 'fits' | 'tight' | 'mosaic';

export interface FitAssessment {
  tag: FitTag;
  /** Fraction of the frame's limiting axis the object's bounding box fills
   *  (see `frameFillRatio`'s doc comment — same rotation-agnostic caveat).
   *  Exposed mainly so callers can secondary-sort within one `tag` (e.g. the
   *  Catalogs board's "Best frame fit" sort) without recomputing it. */
  fillRatio: number;
  /** Set only when `tag === 'mosaic'`: the grid a `classifyFit` caller would
   *  need to cover the object, so a translated verdict can say "needs a 3 × 2
   *  mosaic" without recomputing `autoMosaicForObject` itself. */
  mosaicCols?: number;
  mosaicRows?: number;
}

/** Fraction of the frame's limiting axis the object's bounding box fills,
 *  ignoring rotation (same approximation `autoMosaicForObject` uses — we
 *  rarely know the object's position angle). >1 means it overflows that axis. */
function frameFillRatio(fov: { widthDeg: number; heightDeg: number }, object: ObjectExtentArcmin): number {
  return Math.max(
    (object.widthArcmin / 60) / fov.widthDeg,
    (object.heightArcmin / 60) / fov.heightDeg,
  );
}

/**
 * Classifies how an object sits in a given FOV: too large for one frame
 * (needs a mosaic), a tight single-frame crop, a comfortable fit, or tiny
 * against the frame. Same geometry as `autoMosaicForObject` (rotation-agnostic
 * bounding-box comparison) but returns a structured tag so callers can render
 * a colored badge instead of parsing a sentence.
 *
 * Returns `null` when the object's angular size isn't known — callers should
 * omit the badge entirely rather than guess. Pure/untranslated by design (it
 * feeds sorting as well as display, e.g. the Catalogs board's "Best frame
 * fit" sort in CatalogBoard.tsx) — pass the result through `fitDisplayStrings`
 * to get user-facing text.
 */
export function classifyFit(
  fov: { widthDeg: number; heightDeg: number },
  object: ObjectExtentArcmin | null,
): FitAssessment | null {
  if (!object) return null;
  const fillRatio = frameFillRatio(fov, object);
  const { cols, rows } = autoMosaicForObject(fov, object, 0.1);
  if (cols > 1 || rows > 1) {
    return { tag: 'mosaic', fillRatio, mosaicCols: cols, mosaicRows: rows };
  }
  if (fillRatio >= 0.75) return { tag: 'tight', fillRatio };
  if (fillRatio < 0.15) return { tag: 'tiny', fillRatio };
  return { tag: 'fits', fillRatio };
}

/** Best-to-worst ranking of `FitTag` for sorting a list of objects by "does
 *  this fit my telescope's frame" — e.g. the Catalogs board's "Best frame
 *  fit" sort. Lower sorts first. `fits` (comfortable single frame) leads;
 *  `mosaic` (needs multiple frames) trails. `tight` and `tiny` both still
 *  capture in one frame, so both rank ahead of `mosaic` — `tight` first
 *  since a tiny object is arguably a worse composition than a tight crop. */
export const FRAME_FIT_RANK: Record<FitTag, number> = {
  fits: 0,
  tight: 1,
  tiny: 2,
  mosaic: 3,
};

/** Translates a `FitAssessment` into the short chip text and longer tooltip
 *  `FitBadge` displays. Kept separate from `classifyFit` per the `lib/`
 *  translation convention (a plain lib function takes `t` explicitly):
 *  `classifyFit` is a pure classifier reused for sorting, while this is the
 *  one place that turns a tag into user-facing copy. */
export function fitDisplayStrings(fit: FitAssessment, t: TFunc): { short: string; label: string } {
  switch (fit.tag) {
    case 'fits':
      return { short: t('framingModal.fitFits'), label: t('framingModal.fitFitsLabel') };
    case 'tight':
      return { short: t('framingModal.fitTight'), label: t('framingModal.fitTightLabel') };
    case 'tiny':
      return { short: t('framingModal.fitTiny'), label: t('framingModal.fitTinyLabel') };
    case 'mosaic':
      // Reuses the existing "Mosaic" section label and needsMosaic sentence
      // rather than introducing near-duplicate copy for the same concept.
      return {
        short: t('framingModal.mosaic'),
        label: t('framingModal.needsMosaic', { cols: fit.mosaicCols, rows: fit.mosaicRows }),
      };
  }
}

// ─── Persisted framing setup (Settings → Telescopes default + override) ──

export const CUSTOM_FOV_PROFILE_ID = 'custom';

export interface CustomOptics {
  focalMm: number;
  sensorWMm: number;
  sensorHMm: number;
  /** Pixel pitch in microns. Optional — only used for the arcsec/pixel readout. */
  pixelSizeUm: number | null;
}

/** Starting point for a first-time custom rig: a small OSC camera on a short
 *  APO refractor, with a common ZWO pixel pitch (matches the ASIAIR default
 *  in server/routes/satellite.ts) so the arcsec/pixel readout isn't 0 out of the box. */
export const DEFAULT_CUSTOM_OPTICS: CustomOptics = {
  focalMm: 250,
  sensorWMm: 5.6,
  sensorHMm: 3.2,
  pixelSizeUm: 3.76,
};

export interface FovSetup {
  /** A FOV_PROFILES id, `CUSTOM_FOV_PROFILE_ID`, or null to follow whichever
   *  telescope is configured under Settings → Telescopes. */
  profileId: string | null;
  custom: CustomOptics;
}

const FOV_SETUP_KEY = 'nebulis-fov-setup';

/** Validates a stored `CustomOptics` blob: the three dimensions must be
 *  numbers; a missing/non-numeric pixel pitch reads as `null` (the field is
 *  optional for the arcsec/pixel readout only). */
function parseCustomOptics(v: unknown): CustomOptics | null {
  if (!isRecord(v)) return null;
  const { focalMm, sensorWMm, sensorHMm, pixelSizeUm } = v;
  if (typeof focalMm !== 'number' || typeof sensorWMm !== 'number' || typeof sensorHMm !== 'number') return null;
  return { focalMm, sensorWMm, sensorHMm, pixelSizeUm: typeof pixelSizeUm === 'number' ? pixelSizeUm : null };
}

const DEFAULT_FOV_SETUP: FovSetup = { profileId: null, custom: DEFAULT_CUSTOM_OPTICS };

/** Reads the user's saved Framing & Mosaic setup (the Framing modal writes
 *  this every time the telescope pick or custom optics change), so a manual
 *  override for an unsupported rig — a bare ZWO camera + third-party lens,
 *  say — sticks the same way everywhere it's used: the modal itself and the
 *  Planner list's fit badge. Falls back to following the configured telescope
 *  when nothing has been saved yet. */
export function readFovSetup(): FovSetup {
  if (typeof window === 'undefined') return DEFAULT_FOV_SETUP;
  try {
    const raw = localStorage.getItem(FOV_SETUP_KEY);
    if (!raw) return DEFAULT_FOV_SETUP;
    const parsed: unknown = JSON.parse(raw);
    // A non-object payload (`null`, a bare number/string) carries no fields,
    // so it resolves to the same value as the defaults.
    if (!isRecord(parsed)) return DEFAULT_FOV_SETUP;
    return {
      profileId: typeof parsed.profileId === 'string' ? parsed.profileId : null,
      custom: parseCustomOptics(parsed.custom) ?? DEFAULT_CUSTOM_OPTICS,
    };
  } catch {
    return DEFAULT_FOV_SETUP;
  }
}

export function writeFovSetup(setup: FovSetup): void {
  try {
    localStorage.setItem(FOV_SETUP_KEY, JSON.stringify(setup));
  } catch {
    /* ignore — a private/full storage just means the pick won't stick */
  }
}

// ─── Saved custom-optics presets ("name it and reuse it") ────────────────
//
// A lighter-weight alternative to registering a full telescope under
// Settings → Telescopes: a named preset is just a label over a `CustomOptics`
// value, stored client-side, with no transport/connection/import config to
// fill in. Useful for a bare camera+lens combo the user reaches for
// occasionally but doesn't want to manage as a "telescope".

export interface SavedCustomRig {
  id: string;
  name: string;
  optics: CustomOptics;
}

const SAVED_CUSTOM_RIGS_KEY = 'nebulis-saved-custom-rigs';

export function readSavedCustomRigs(): SavedCustomRig[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SAVED_CUSTOM_RIGS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((r: unknown): SavedCustomRig[] => {
      if (!isRecord(r) || typeof r.id !== 'string' || typeof r.name !== 'string') return [];
      const optics = parseCustomOptics(r.optics);
      return optics ? [{ id: r.id, name: r.name, optics }] : [];
    });
  } catch {
    return [];
  }
}

function writeSavedCustomRigs(rigs: SavedCustomRig[]): void {
  try {
    localStorage.setItem(SAVED_CUSTOM_RIGS_KEY, JSON.stringify(rigs));
  } catch {
    /* ignore — a private/full storage just means the preset won't stick */
  }
}

function generateRigId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `rig-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Saves a new named custom-optics preset. Returns the created row so the
 *  caller can select it immediately. */
export function saveCustomRig(name: string, optics: CustomOptics): SavedCustomRig {
  const rig: SavedCustomRig = { id: generateRigId(), name, optics };
  writeSavedCustomRigs([...readSavedCustomRigs(), rig]);
  return rig;
}

/** Overwrites an existing preset's optics in place (the name is unchanged). */
export function updateCustomRig(id: string, optics: CustomOptics): void {
  writeSavedCustomRigs(readSavedCustomRigs().map(r => (r.id === id ? { ...r, optics } : r)));
}

export function deleteCustomRig(id: string): void {
  writeSavedCustomRigs(readSavedCustomRigs().filter(r => r.id !== id));
}

/** Dropdown-option-id prefix for a saved custom-optics preset, parallel to
 *  `TELESCOPE_PROFILE_PREFIX`: `customRig:<id>`. */
export const CUSTOM_RIG_PREFIX = 'customRig:';

export function customRigOptionId(id: string): string {
  return `${CUSTOM_RIG_PREFIX}${id}`;
}

export interface ResolvedFov {
  widthDeg: number;
  heightDeg: number;
  label: string;
  /** Only set when the plate scale is knowable: a custom setup (ad-hoc or a
   *  registered profile) with a pixel size entered. */
  arcsecPerPixel: number | null;
  profileId: string;
}

/** Dropdown-option-id prefix for a registered telescope profile, so
 *  `FovSetup.profileId` can distinguish "a `FOV_PROFILES` id",
 *  "`CUSTOM_FOV_PROFILE_ID`", and "this specific telescope (+ optionally a
 *  specific optical configuration on it) from Settings → Telescopes" from one
 *  string: `telescope:<telescopeId>` (its active/default config) or
 *  `telescope:<telescopeId>:<configId>` (a specific one). */
export const TELESCOPE_PROFILE_PREFIX = 'telescope:';

export function telescopeProfileOptionId(telescopeId: string, configId?: string | null): string {
  return configId ? `${TELESCOPE_PROFILE_PREFIX}${telescopeId}:${configId}` : `${TELESCOPE_PROFILE_PREFIX}${telescopeId}`;
}

/** The subset of `TelescopeOpticalConfig` (src/lib/api/telescopes.ts)
 *  resolveFov actually needs. */
export type OpticalConfigLike = Pick<
  TelescopeOpticalConfig,
  'id' | 'name' | 'focalLengthMm' | 'sensorWidthMm' | 'sensorHeightMm' | 'pixelSizeUm'
>;

/** The subset of `TelescopeProfile` (src/lib/api/telescopes.ts) resolveFov
 *  actually needs — kept narrow so tests can build one without the full
 *  connection/import-toggle shape. */
export type TelescopeProfileLike = Pick<
  TelescopeProfile,
  'id' | 'name' | 'kind' | 'archivedAt' | 'activeOpticalConfigId'
> & {
  opticalConfigs: OpticalConfigLike[];
};

/** Picks which of a profile's optical configs to use: an explicit `configId`
 *  if it still exists, else the profile's `activeOpticalConfigId` if set and
 *  still valid, else the oldest config (server orders `opticalConfigs` by
 *  `createdAt asc`), else `null` when there are none at all. */
function pickOpticalConfig(t: TelescopeProfileLike, configId?: string): OpticalConfigLike | null {
  const configs = t.opticalConfigs;
  if (configs.length === 0) return null;
  if (configId) {
    const requested = configs.find(c => c.id === configId);
    if (requested) return requested;
  }
  const active = t.activeOpticalConfigId ? configs.find(c => c.id === t.activeOpticalConfigId) : undefined;
  return active ?? configs[0];
}

/** FOV for one registered telescope profile, optionally a specific optical
 *  config on it. Optical configs only take effect for kinds Nebulis has no
 *  `FOV_PROFILES` lookup for (`other`, `asiair`) — a known smart-telescope
 *  kind always uses its lookup entry, even if configs happen to be present
 *  from an earlier kind switch. */
function fovForTelescopeProfile(
  t: TelescopeProfileLike,
  configId?: string,
): { widthDeg: number; heightDeg: number; arcsecPerPixel: number | null; configId: string | null; configName: string | null } {
  if (t.kind === 'other' || t.kind === 'asiair') {
    const config = pickOpticalConfig(t, configId);
    if (config) {
      const { widthDeg, heightDeg } = fovFromOptics(config.focalLengthMm, config.sensorWidthMm, config.sensorHeightMm);
      const arcsecPx = config.pixelSizeUm ? arcsecPerPixel(config.focalLengthMm, config.pixelSizeUm) : null;
      return { widthDeg, heightDeg, arcsecPerPixel: arcsecPx, configId: config.id, configName: config.name };
    }
  }
  const p = fovProfileById(fovProfileIdForKind(t.kind)) ?? DEFAULT_FOV_PROFILE;
  return { widthDeg: p.widthDeg, heightDeg: p.heightDeg, arcsecPerPixel: null, configId: null, configName: null };
}

/**
 * Turns a saved `FovSetup` + the telescopes registered under Settings →
 * Telescopes into the actual FOV to draw/classify against. Shared by the
 * Framing modal and the Planner list badge so both always agree on "the
 * current rig".
 *
 * Resolution order:
 * 1. An explicit pick (`setup.profileId`) wins: a built-in `FOV_PROFILES` id,
 *    `CUSTOM_FOV_PROFILE_ID` (the modal's ad-hoc, unsaved "Custom" entry), or
 *    a `telescope:<id>[:<configId>]` pick of a registered profile (optionally
 *    a specific optical config on it) — which resolves through that config's
 *    optics, that profile's active/oldest config, or its kind's
 *    `FOV_PROFILES` lookup, in that order.
 * 2. No pick, or the picked telescope was since deleted: fall back to
 *    whichever telescope is active (first non-archived, else the first at
 *    all) under Settings → Telescopes, using its active/oldest config.
 * 3. No telescopes registered at all: the generic `DEFAULT_FOV_PROFILE_ID`.
 */
export function resolveFov(setup: FovSetup, telescopes: TelescopeProfileLike[] | null | undefined): ResolvedFov {
  const list = telescopes ?? [];

  if (setup.profileId) {
    // A saved named preset resolves through the SAME live `setup.custom`
    // values as the generic ad-hoc Custom entry (so an in-progress edit shows
    // up immediately) — the prefix only changes which label is shown. See
    // `saveCustomRig`/`readSavedCustomRigs`.
    if (setup.profileId === CUSTOM_FOV_PROFILE_ID || setup.profileId.startsWith(CUSTOM_RIG_PREFIX)) {
      const { widthDeg, heightDeg } = fovFromOptics(
        setup.custom.focalMm || 1,
        setup.custom.sensorWMm || 0.1,
        setup.custom.sensorHMm || 0.1,
      );
      const arcsecPx = setup.custom.pixelSizeUm ? arcsecPerPixel(setup.custom.focalMm, setup.custom.pixelSizeUm) : null;
      let label = 'Custom';
      const pickedId = setup.profileId;
      if (pickedId.startsWith(CUSTOM_RIG_PREFIX)) {
        const rig = readSavedCustomRigs().find(r => r.id === pickedId.slice(CUSTOM_RIG_PREFIX.length));
        if (rig) label = rig.name;
      }
      return { widthDeg, heightDeg, label, arcsecPerPixel: arcsecPx, profileId: setup.profileId };
    }
    if (setup.profileId.startsWith(TELESCOPE_PROFILE_PREFIX)) {
      const rest = setup.profileId.slice(TELESCOPE_PROFILE_PREFIX.length);
      const sep = rest.indexOf(':');
      const telescopeId = sep === -1 ? rest : rest.slice(0, sep);
      const configId = sep === -1 ? undefined : rest.slice(sep + 1);
      const t = list.find(p => p.id === telescopeId);
      if (t) {
        const fov = fovForTelescopeProfile(t, configId);
        const label = fov.configName ? `${t.name} — ${fov.configName}` : t.name;
        return { widthDeg: fov.widthDeg, heightDeg: fov.heightDeg, label, arcsecPerPixel: fov.arcsecPerPixel, profileId: setup.profileId };
      }
      // The saved pick no longer exists (profile deleted since) — fall
      // through to the active-telescope default below.
    } else {
      const p = fovProfileById(setup.profileId);
      if (p) return { widthDeg: p.widthDeg, heightDeg: p.heightDeg, label: p.label, arcsecPerPixel: null, profileId: p.id };
    }
  }

  const owned = list.find(t => !t.archivedAt) ?? list[0] ?? null;
  if (owned) {
    const fov = fovForTelescopeProfile(owned);
    const label = fov.configName ? `${owned.name} — ${fov.configName}` : owned.name;
    return { widthDeg: fov.widthDeg, heightDeg: fov.heightDeg, label, arcsecPerPixel: fov.arcsecPerPixel, profileId: telescopeProfileOptionId(owned.id, fov.configId) };
  }

  const fallback = DEFAULT_FOV_PROFILE;
  return { widthDeg: fallback.widthDeg, heightDeg: fallback.heightDeg, label: fallback.label, arcsecPerPixel: null, profileId: fallback.id };
}
