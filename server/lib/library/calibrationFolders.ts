/**
 * Calibration-frame folder recognition and filename metadata.
 *
 * `objectDiscovery.ts` already excluded ASIAIR's flat `Dark/`, `Flat/`,
 * `Bias/` folders (singular, no target) from object discovery, and
 * `archiveFolders.ts`/`import.ts` already archive Dwarf's `CALI_FRAME`/
 * `DWARF_DARK` unconditionally. Neither recognized the shape a lot of real
 * calibration libraries actually take: plural folder names (`Darks`, `Flats`,
 * `Bias`), a "flat dark" frame type ASIAIR/N.I.N.A. users commonly shoot but
 * which had no folder-name mapping at all, and per-setup subfolders (one per
 * gain/exposure/binning/temperature combination, e.g. `G100_TECm8`,
 * `G100_60s_TECm8`) nested a level below the frame-type folder.
 *
 * A folder-import wizard run pointed at that shape today either drops the
 * plural folders on the floor entirely (not recognized as non-observation,
 * so `isObjectFolder` accepts them — they'd import as bogus objects named
 * "Darks" whose "sessions" are per-camera-setting subfolders) or, for the
 * singular ASIAIR names, only archives them when "archive everything" is on.
 * Both are wrong for data the whole point of this module is to give a real
 * home to. See archiveFolders.ts's file-level comment for the "promoted into
 * a real calibration-frame feature later" note this is that migration.
 *
 * Kept separate from objectDiscovery.ts (which owns folder-exclusion rules in
 * general) because this module also owns the filename metadata parse, which
 * objectDiscovery.ts has no reason to know about.
 */

export type CalibrationFrameType = 'bias' | 'dark' | 'flat' | 'flatDark';

/** Human-facing label for a recognized calibration frame type. `mixed` covers
 *  Dwarf's `CALI_FRAME`, which is not a single frame type — see
 *  `CALIBRATION_FOLDER_TYPE` below. */
export function calibrationTypeLabel(type: CalibrationFrameType | 'mixed'): string {
  switch (type) {
    case 'bias': return 'Bias';
    case 'dark': return 'Darks';
    case 'flat': return 'Flats';
    case 'flatDark': return 'Flat darks';
    case 'mixed': return 'Calibration (mixed)';
  }
}

/**
 * Every folder name (lowercased) recognized as holding calibration frames,
 * mapped to the frame type it holds. Singular and plural both included since
 * real libraries use either (ASIAIR itself writes singular; a lot of manual/
 * NINA-organized libraries use plural). `cali_frame` is Dwarf's folder and
 * holds a blend of frame types rather than one, so it is handled separately
 * as `'mixed'` rather than living in this map — `dwarf_dark` does hold one
 * type (dark) and is included here directly.
 */
const CALIBRATION_FOLDER_TYPE: Readonly<Record<string, CalibrationFrameType>> = {
  bias: 'bias',
  biases: 'bias',
  dark: 'dark',
  darks: 'dark',
  dwarf_dark: 'dark',
  // SeeStar's on-device dark library, written at the share root beside
  // MyWorks. One frame type, files named by the firmware.
  darklibrary: 'dark',
  dark_library: 'dark',
  'dark-library': 'dark',
  flat: 'flat',
  flats: 'flat',
  flatdark: 'flatDark',
  flatdarks: 'flatDark',
  flat_dark: 'flatDark',
  flat_darks: 'flatDark',
  'flat-dark': 'flatDark',
  'flat-darks': 'flatDark',
  darkflat: 'flatDark',
  darkflats: 'flatDark',
  dark_flat: 'flatDark',
  dark_flats: 'flatDark',
  'dark-flat': 'flatDark',
  'dark-flats': 'flatDark',
};

/** SeeStar's on-device dark library folder, at the share root. */
export const SEESTAR_DARK_LIBRARY_FOLDER = 'darklibrary';

/** Dwarf's mixed-content calibration folder — handled outside
 *  `CALIBRATION_FOLDER_TYPE` because it is not one frame type. */
const MIXED_CALIBRATION_FOLDER = 'cali_frame';

/** Every recognized folder name, lowercased, including the mixed one. Used by
 *  `import.ts` to build its "always archive, regardless of archiveAllFiles"
 *  folder list — the superset this module exists to widen. */
export const CALIBRATION_FOLDER_NAMES: readonly string[] = [
  ...Object.keys(CALIBRATION_FOLDER_TYPE),
  MIXED_CALIBRATION_FOLDER,
];

/** The frame type a folder name maps to, or `'mixed'` for Dwarf's blended
 *  folder, or null when the name isn't a recognized calibration folder.
 *  Case-insensitive, exact-match only (a user's own folder that merely
 *  contains one of these words, e.g. "Dark Nebulae Targets", must not match —
 *  same guarantee `isNonObjectFolder` gives every other entry). */
export function calibrationTypeForFolderName(name: string): CalibrationFrameType | 'mixed' | null {
  const lower = name.toLowerCase();
  if (lower === MIXED_CALIBRATION_FOLDER) return 'mixed';
  return CALIBRATION_FOLDER_TYPE[lower] ?? null;
}

/** True for any folder name this module recognizes as calibration data. */
export function isCalibrationFolderName(name: string): boolean {
  return calibrationTypeForFolderName(name) !== null;
}

/**
 * The real bias/dark/flat/flat-dark type ONE FILE inside a `mixed`
 * (`CALI_FRAME`) group belongs to, read from the name of the subfolder that
 * directly holds it — `CALI_FRAME/dark/cam_0/...` names its `dark` folder
 * exactly like a standalone `Darks` archive would. Excludes `mixed` itself
 * (that is `CALI_FRAME`'s own folder name, never a per-file type) and,
 * like `calibrationTypeForFolderName`, returns `undefined` rather than
 * guessing for anything else — a camera-setting subfolder (`G100_TECm8`) or
 * an unrecognized layout.
 *
 * Without this, a bias and a flat frame that happen to share every encoded
 * setting (real example: Dwarf's `bias_gain_2_bin_1.fits` and
 * `flat_gain_2_bin_1.fits` — neither carries an exposure or a temperature)
 * parse to an identical settings key and silently merge into one bundle,
 * mixing two different frame types together. See calibrationScan.ts's
 * `buildSettingsGroups`, which folds this into the bucket key for `mixed`
 * groups only — a non-`mixed` group's own type already disambiguates this
 * with no help needed here.
 */
export function calibrationFrameTypeFromFolderName(name: string): CalibrationFrameType | undefined {
  const type = calibrationTypeForFolderName(name);
  return type === null || type === 'mixed' ? undefined : type;
}

export interface CalibrationFrameInfo {
  /** Exposure length in seconds, when the filename encodes one (a `ms` unit
   *  is converted to seconds). */
  exposureSec?: number;
  /** Sensor binning (1 = 1x1, 2 = 2x2, ...). */
  binning?: number;
  /** Camera gain setting. Absent for ISO-based (DSLR) rigs, which encode
   *  `ISO<n>` in the same filename slot instead of `gain<n>` — not surfaced
   *  as a separate field since it isn't this codebase's concern anywhere
   *  else either (telescopeFiles.ts's own ASIAIR parser only treats it as
   *  "not a filter", the same way this one does). */
  gain?: number;
  /** The token between Bin<n> and gain/ISO. Usually a filter-wheel slot
   *  name; for bias/dark captures behind a filter wheel this is often a
   *  fixed "Dark"/blank-slot label rather than a real filter, so it is kept
   *  generic rather than assumed to be a color filter. */
  filterLabel?: string;
  /** Sensor (CCD/CMOS) temperature in Celsius at capture time. */
  sensorTempC?: number;
  /** ASIAIR's "Camera Angle" field (degrees of sensor/field rotation) — a
   *  real, independently toggleable field on the device's own "Customize
   *  File Name" screen, not a temperature reading (see
   *  telescopeFiles.ts's validated ASIAIR parser for the same field). */
  cameraAngleDeg?: number;
  /** When the frame was captured, derived from the filename's timestamp. Never
   *  present for a Dwarf frame — its filename carries no timestamp, see
   *  `parseDwarfCalibrationFilename`. */
  capturedAt?: string;
  /** Frame sequence number within its capture run. ASIAIR-only. */
  sequence?: number;
  /** Which of a Dwarf 3's two optical paths this master was captured on —
   *  the raw `cam_0`/`cam_1` folder token (see `dwarfCameraFromRelPath`),
   *  not a semantic 'wide'/'tele' label, since which physical lens is which
   *  index is not confirmed against ZWO/DWARFLAB documentation. Undefined
   *  for every non-Dwarf frame, and for a single-camera Dwarf (II/Mini)
   *  whose CALI_FRAME/DWARF_DARK nests frames directly with no cam_N split. */
  camera?: string;
  /** How many raw frames the Dwarf firmware itself combined into this master
   *  (its `_stack_<n>` filename token). Dwarf's CALI_FRAME already holds
   *  pre-stacked masters, not raw subs the way ASIAIR's calibration folders
   *  do, so this is the closest equivalent to `sequence` for a Dwarf frame. */
  stackCount?: number;
  /** This file's real bias/dark/flat/flat-dark type, read from its
   *  containing subfolder's name — see `calibrationFrameTypeFromFolderName`.
   *  Only ever set within a `mixed` (`CALI_FRAME`) group; a non-`mixed`
   *  group's files are already all one type via the group itself. */
  frameType?: CalibrationFrameType;
}

/** `120_0` -> `120.0`, `-8.0` -> `-8.0`: ASIAIR writes decimal points as
 *  underscores on-device (confirmed against real hardware — see
 *  telescopeFiles.ts's ASIAIR filename docs), though older captures/tooling
 *  may still produce a literal dot; both are accepted. */
function toDecimal(raw: string): number {
  return Number(raw.replace('_', '.'));
}

/**
 * SeeStar's on-device dark library (`darklibrary/` at the share root) holds
 * masters the telescope stacked itself, named:
 *
 *   MasterDark_5_30.0s_26.0C_20261014-192837.fit
 *   MasterDark_5_30.0s_26.0C_20261014-192837.jpg   (its preview)
 *
 * Exposure and sensor temperature are explicit (`30.0s`, `26.0C`) and the
 * stamp is the usual local `YYYYMMDD-HHMMSS`. The number after the type is
 * left unread on purpose: nothing confirms whether it is a frame count or a
 * setting, and a wrong `stackCount` or `gain` would mis-match darks to lights.
 */
const SEESTAR_MASTER_CALIBRATION_FILENAME_RE =
  /^Master(?:Dark|Bias|Flat|DarkFlat|FlatDark)_\d+_(?<exp>\d+(?:\.\d+)?)s_(?<temp>-?\d+(?:\.\d+)?)C_(?<date>\d{8})-(?<time>\d{6})\d*\.[^.]+$/i;

function parseSeestarMasterCalibrationFilename(name: string): CalibrationFrameInfo | null {
  const m = SEESTAR_MASTER_CALIBRATION_FILENAME_RE.exec(name);
  if (!m?.groups) return null;
  const g = m.groups;

  const info: CalibrationFrameInfo = {
    exposureSec: Number(g.exp),
    sensorTempC: Number(g.temp),
  };

  // Local time, no zone in the name: the same limitation every telescope
  // filename timestamp in this module has.
  const { date, time } = g;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  const parsed = new Date(iso);
  if (!isNaN(parsed.getTime())) info.capturedAt = parsed.toISOString();

  return info;
}

/**
 * Parse the metadata a calibration frame's own filename encodes.
 *
 * ASIAIR calibration frames (Dark/Flat/Bias) follow the *exact same*
 * filename convention as its light frames — telescopeFiles.ts's
 * `parseFilename` documents the validated shape in full, including the two
 * quirks confirmed against real hardware this pattern mirrors: decimal points
 * come out as underscores, and `_<n>deg_` is the real "Camera Angle" field,
 * not a temperature. This module needs the additional gain/binning/
 * temperature/angle fields a light frame's parser has no reason to expose
 * (it only needs target/exposure/filter/timestamp), so the pattern is
 * duplicated here rather than shared — but it is intentionally kept in
 * lock-step with telescopeFiles.ts's `asiairMatch` regex; widen that one,
 * widen this one too.
 *
 *   Bias_5.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit
 *   Dark_120_0s_Bin1_None_gain100_20260904-051928_2deg_-8_0C_0207.fit
 *   Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit
 *
 * Best-effort: returns null for anything that doesn't match rather than
 * guessing, since a file that fails to parse is still listed (just without
 * the derived chips) rather than dropped.
 *
 * Unlike telescopeFiles.ts's light-frame `asiairMatch`, this pattern has no
 * optional leading target group: calibration frames never carry a target
 * token (per that same module's own comment), and including one anyway
 * introduced a real ambiguity — its lazy `.+?_` happily swallowed the leading
 * digits of an underscore-decimal exposure (`120_0s` parsed as target `"120"`
 * + exposure `"0"`) since the rest of the pattern is lax enough to still
 * match what's left. Dropping the group entirely (calibration frames don't
 * need a target field here regardless) resolves it cleanly rather than
 * tightening the ambiguity away some other way.
 */
const CALIBRATION_FILENAME_RE =
  /^[A-Za-z]+_(?<exp>\d+(?:[._]\d+)?)(?<unit>m?s)_Bin(?<bin>\d+)(?<middle>(?:_[A-Za-z0-9+-]+)*?)_(?<date>\d{8})-(?<time>\d{6})\d*(?:_(?<angle>\d+)deg)?(?:_(?<temp>-?\d+(?:[._]\d+)?)C)?(?:_(?<seq>\d+))?\.[^.]+$/i;

function parseAsiairCalibrationFilename(name: string): CalibrationFrameInfo | null {
  const m = CALIBRATION_FILENAME_RE.exec(name);
  if (!m?.groups) return null;
  const g = m.groups;

  const exposureRaw = toDecimal(g.exp);
  const info: CalibrationFrameInfo = {
    exposureSec: g.unit.toLowerCase() === 'ms' ? exposureRaw / 1000 : exposureRaw,
    binning: Number(g.bin),
  };

  // gain<n>/ISO<n> is the exposure setting, not a filter — the ASI Camera
  // Model token, when present, sits alongside it in the same chunk. Whichever
  // token comes first that isn't gain/ISO is the filter/filter-wheel-slot
  // label. Mirrors telescopeFiles.ts's identical ASIAIR light-frame logic
  // exactly, since the two share this middle chunk's shape.
  const tokens = g.middle.split('_').filter(Boolean);
  const gainToken = tokens.find(t => /^gain\d+$/i.test(t));
  if (gainToken) info.gain = Number(gainToken.slice(4));
  const filterToken = tokens.find(t => !/^(?:gain\d+|ISO\d+)$/i.test(t));
  if (filterToken) info.filterLabel = filterToken;

  if (g.angle !== undefined) info.cameraAngleDeg = Number(g.angle);
  if (g.temp !== undefined) info.sensorTempC = toDecimal(g.temp);
  if (g.seq !== undefined) info.sequence = Number(g.seq);

  // YYYYMMDD-HHMMSS, always local to wherever the telescope/capture box's
  // clock was set — there is no timezone in the filename to do better than
  // that, same limitation SeeStar/Dwarf filename timestamps have elsewhere
  // in telescopeFiles.ts.
  const { date, time } = g;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  const parsed = new Date(iso);
  if (!isNaN(parsed.getTime())) info.capturedAt = parsed.toISOString();

  return info;
}

/**
 * Dwarf 3's own CALI_FRAME filename convention — confirmed against a real
 * device export (`Astronomy/CALI_FRAME/{bias,dark,flat}/cam_{0,1}/...`),
 * unlike the rest of this module's ASIAIR/N.I.N.A. assumptions:
 *
 *   bias_gain_2_bin_1.fits
 *   flat_gain_2_bin_1.fits
 *   flat_gain_2_bin_1_ir_1.fits
 *   dark_exp_30.000000_gain_60_bin_1_22C_stack_6.fits
 *
 * Bias and flat carry no exposure or temperature (bias has none by
 * definition; the real export never showed one for flat either) and no
 * decimal-underscore quirk — exposure is a plain decimal, temperature a bare
 * unsigned integer (Dwarf's sensor is uncooled, so this is an ambient
 * reading, not a TEC setpoint, and the real export never showed a negative
 * one). `_ir_<n>` (flat only, cam_0 only in the sample) is the IR-cut filter
 * position; folded into `filterLabel` as `IR<n>` since it plays the same
 * "which optical state was this shot in" role ASIAIR's filter-wheel token
 * does. `_stack_<n>` is how many raw frames Dwarf's own firmware combined
 * into this master — CALI_FRAME already holds pre-stacked masters, not raw
 * subs, unlike ASIAIR's calibration folders.
 *
 * The `cam_0`/`cam_1` split is a folder, not a filename token, so it is not
 * parsed here — see `dwarfCameraFromRelPath`, applied by the caller.
 */
const DWARF_MASTER_CALIBRATION_FILENAME_RE =
  /^(?:bias|dark|flat)_(?:exp_(?<exp>\d+(?:\.\d+)?)_)?gain_(?<gain>\d+)_bin_(?<bin>\d+)(?:_ir_(?<ir>\d+))?(?:_(?<temp>\d+)C)?(?:_stack_(?<stack>\d+))?\.[^.]+$/i;

function parseDwarfMasterCalibrationFilename(name: string): CalibrationFrameInfo | null {
  const m = DWARF_MASTER_CALIBRATION_FILENAME_RE.exec(name);
  if (!m?.groups) return null;
  const g = m.groups;

  const info: CalibrationFrameInfo = {
    gain: Number(g.gain),
    binning: Number(g.bin),
  };
  if (g.exp !== undefined) info.exposureSec = Number(g.exp);
  if (g.temp !== undefined) info.sensorTempC = Number(g.temp);
  if (g.ir !== undefined) info.filterLabel = `IR${g.ir}`;
  if (g.stack !== undefined) info.stackCount = Number(g.stack);

  return info;
}

/**
 * Dwarf's OTHER calibration convention: `DWARF_DARK` (the folder
 * `driveEnumeration.ts`/`dwarfMounts.ts` already know is distinct from
 * `CALI_FRAME`) holds raw, unstacked sub-frames in per-session folders,
 * rather than `CALI_FRAME`'s pre-stacked masters — confirmed against a real
 * export where a single Dwarf 3 had accumulated both (an older firmware's
 * `DWARF_DARK` output alongside a newer one's `CALI_FRAME` output):
 *
 *   DWARF_DARK/tele_exp_60_gain_60_bin_1_2025-06-19-22-47-27-957/
 *     raw_60s_60_0009_20250619-225727031_37C.fits
 *   DWARF_DARK/wide_exp_30_gain_60_bin_1_2025-07-24-23-43-28-522/
 *     raw_30s_60_0000_20250724-234357539_22C.fits
 *
 * The session folder's name carries `camera` (a semantic `tele`/`wide` token
 * here, unlike `CALI_FRAME`'s numeric `cam_0`/`cam_1`) and `binning` — the
 * one field the file's own name doesn't repeat. Exposure, gain, sequence,
 * capture timestamp and sensor temperature all live in the per-file name
 * instead; see `parseDwarfRawCalibrationFilename` below.
 */
const DWARF_DARK_SESSION_FOLDER_RE = /^(?<camera>[a-z]+)_exp_\d+(?:\.\d+)?_gain_\d+_bin_(?<bin>\d+)_/i;

/** Camera + binning from a `DWARF_DARK` session folder's own name, or null
 *  for anything else (a `CALI_FRAME` type-folder name like `dark`/`bias`/
 *  `flat` never matches this, since it has no `_exp_..._gain_..._bin_..._`
 *  shape). Applied by the caller alongside the per-file parse — see
 *  calibrationScan.ts's `buildSubfolder`. */
export function dwarfDarkSessionFolderInfo(name: string): { camera: string; binning: number } | null {
  const m = DWARF_DARK_SESSION_FOLDER_RE.exec(name);
  if (!m?.groups) return null;
  return { camera: m.groups.camera.toLowerCase(), binning: Number(m.groups.bin) };
}

const DWARF_RAW_CALIBRATION_FILENAME_RE =
  /^raw_(?<exp>\d+(?:\.\d+)?)s_(?<gain>\d+)_(?<seq>\d+)_(?<date>\d{8})-(?<time>\d{6})\d*_(?<temp>-?\d+)C\.[^.]+$/i;

function parseDwarfRawCalibrationFilename(name: string): CalibrationFrameInfo | null {
  const m = DWARF_RAW_CALIBRATION_FILENAME_RE.exec(name);
  if (!m?.groups) return null;
  const g = m.groups;

  const info: CalibrationFrameInfo = {
    exposureSec: Number(g.exp),
    gain: Number(g.gain),
    sequence: Number(g.seq),
    sensorTempC: Number(g.temp),
  };

  // YYYYMMDD-HHMMSS(+milliseconds), local time as always for a Dwarf
  // filename timestamp — same limitation as everywhere else in this module.
  const { date, time } = g;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  const parsed = new Date(iso);
  if (!isNaN(parsed.getTime())) info.capturedAt = parsed.toISOString();

  return info;
}

/**
 * Parse the metadata a calibration frame's own filename encodes.
 *
 * Tries the ASIAIR/N.I.N.A. convention first, then Dwarf's `CALI_FRAME`
 * master convention, then Dwarf's `DWARF_DARK` raw-sub-frame convention, then
 * SeeStar's `darklibrary` masters — the four shapes cannot collide (each has a distinct, required literal prefix
 * or timestamp token the others never produce). Best-effort: returns null
 * for anything that matches none of them rather than guessing, since a file
 * that fails to parse is still listed (just without the derived chips)
 * rather than dropped.
 */
export function parseCalibrationFilename(name: string): CalibrationFrameInfo | null {
  return parseAsiairCalibrationFilename(name)
    ?? parseDwarfMasterCalibrationFilename(name)
    ?? parseDwarfRawCalibrationFilename(name)
    ?? parseSeestarMasterCalibrationFilename(name);
}

/** Dwarf 3's per-camera `CALI_FRAME` calibration subfolder, e.g.
 *  `cam_0/dark_....fits` as it appears in a `CalibrationFile.name` (relative
 *  to its type folder, posix-style so this works the same on every OS
 *  regardless of which separator the filesystem walk used to build it).
 *  Returns the raw token (`cam_0`, `cam_1`), not a semantic label — see
 *  `CalibrationFrameInfo.camera`. Never matches a `DWARF_DARK` file, whose
 *  camera comes from its session folder's name instead — see
 *  `dwarfDarkSessionFolderInfo`. */
const DWARF_CAMERA_FOLDER_RE = /^cam_(\d+)$/i;

export function dwarfCameraFromRelPath(relName: string): string | undefined {
  const posixName = relName.split(/[/\\]/).join('/');
  const dir = posixName.includes('/') ? posixName.slice(0, posixName.lastIndexOf('/')) : '';
  const leaf = dir.includes('/') ? dir.slice(dir.lastIndexOf('/') + 1) : dir;
  return DWARF_CAMERA_FOLDER_RE.test(leaf) ? leaf.toLowerCase() : undefined;
}
