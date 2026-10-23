/**
 * Read side of the Calibration Library: turns whatever
 * `_archive/<scope>/...` already holds (see archiveFolders.ts / import.ts)
 * into a browsable, sorted tree — the "promoted into a real
 * calibration-frame feature" archiveFolders.ts's file comment describes.
 *
 * Deliberately reads the existing archive rather than a new copy
 * destination: bytes that were already archived by a prior import/sync
 * become visible here with no re-import needed, and a folder-import wizard
 * run pointed at a calibration library that is *only* calibration data (no
 * light frames at all) still lands somewhere the user can find it.
 *
 * Pure read/measure over the filesystem, no database — same philosophy
 * `listArchivedFolders` already uses, just one level deeper (per-file, with
 * calibrationFolders.ts's filename metadata attached) and grouped by
 * calibration type instead of raw folder name.
 */
import fs from 'fs';
import path from 'path';
import { getArchiveDir, listArchiveScopes } from './archiveFolders.js';
import {
  calibrationFrameTypeFromFolderName,
  calibrationTypeForFolderName,
  calibrationTypeLabel,
  dwarfCameraFromRelPath,
  dwarfDarkSessionFolderInfo,
  parseCalibrationFilename,
  type CalibrationFrameInfo,
  type CalibrationFrameType,
} from './calibrationFolders.js';
import { isHiddenOrSystemFile } from '../telescopeFiles.js';
import type { CalibrationAttachmentSummary } from './calibrationAttachmentTypes.js';
import { getAllProfiles, getSettingsData } from '../telescopes.js';
import { ASIAIR_MODE_FOLDERS } from '../walkers/asiairWalker.js';

/** Same bound archiveFolders.ts's own tree walk uses, so a pathological
 *  subfolder depth can't hang a request. Calibration trees are shallow in
 *  practice (frame-type / camera-setting / files), so this is generous. */
const MAX_DEPTH = 12;

export interface CalibrationFile {
  name: string;
  size: number;
  /** ISO timestamp, from the file's mtime on disk. */
  modifiedAt: string;
  /** Absolute path on the server. Exposed the same way `ArchivedFolder.path`
   *  already is (archiveFolders.ts) — this is a single-tenant, self-hosted
   *  app, and a user pointing Siril/PixInsight straight at a frame needs the
   *  real path, not a relative one. */
  path: string;
  /** Metadata parsed from the filename itself, when it matched a recognized
   *  pattern. Null rather than omitted so the frontend can tell "parsed, no
   *  fields" apart from "never attempted" — it never actually can today (the
   *  parser either returns every field or none), but keeping the shape
   *  explicit costs nothing and survives the parser growing partial matches
   *  later. */
  info: CalibrationFrameInfo | null;
}

/**
 * A bundle of frames sharing the exact capture settings that matter for
 * calibration matching in stacking software — exposure, binning, gain,
 * sensor (TEC) temperature — regardless of which subfolder they physically
 * sit in. This is the grouping a real calibration workflow actually needs
 * ("give me every 60s/Bin1/gain100/-8°C dark, whatever folder they're
 * scattered across") and folder-name-based `subfolders` only approximates it
 * when the source happened to be organized that way already.
 *
 * `null` in any field means "the filename didn't encode this" (an
 * ISO-gain/DSLR rig has no numeric gain; an unparseable name has none of
 * them) — frames agreeing on every *present* field still bundle together, so
 * a rig that never writes a camera-angle/temperature field doesn't fragment
 * into a separate one-frame group per file.
 */
export interface CalibrationSettingsGroup {
  /** Opaque, stable for the same settings — safe to round-trip back to the
   *  download endpoint, which re-derives the file list from a fresh scan
   *  rather than trusting anything the key itself might seem to encode. */
  key: string;
  exposureSec: number | null;
  binning: number | null;
  gain: number | null;
  /** Which of a Dwarf 3's two optical paths this bundle was captured on
   *  (`cam_0`/`cam_1`) — see `CalibrationFrameInfo.camera`. `null` for every
   *  non-Dwarf bundle and for a single-camera Dwarf. Included in the bucket
   *  key precisely because a wide and a tele dark can otherwise share every
   *  other setting (same exposure/gain/bin, and TEC clustering would happily
   *  merge close-enough ambient temperatures) while coming from physically
   *  different sensors. */
  camera: string | null;
  /** This bundle's real bias/dark/flat/flat-dark type, resolved from its
   *  files' subfolder names — only ever non-null within a `mixed`
   *  (`CALI_FRAME`) group, where it disambiguates bundles a non-`mixed`
   *  group's own `type` already would. `null` when the group isn't `mixed`
   *  (redundant with the group's own type there) or when a `mixed` group's
   *  files didn't parse cleanly enough to resolve one. Governs `isExpired`
   *  and attachability for a `mixed` group's own rows — see
   *  `resolveFrameType` in calibrationScan.ts and `isAttachableType`/
   *  `isDeletableType` in CalibrationLibrary.tsx, both of which fall back to
   *  the group's own type when this is null. */
  frameType: CalibrationFrameType | null;
  /** The mean of every frame in this bundle's own reading, rounded to one
   *  decimal — not necessarily any single frame's exact value. Frames whose
   *  readings are within TEC_TOLERANCE_C of their neighbors are clustered
   *  into one bundle (a cooled camera's TEC holds *near* its setpoint, not
   *  exactly on it), so this is the bundle's representative temperature,
   *  not a guarantee every file matches it precisely. Exposure/binning/gain
   *  get no such tolerance — those are discrete settings a user picks
   *  exactly, not an analog reading that drifts. */
  sensorTempC: number | null;
  fileCount: number;
  bytes: number;
  modifiedAt: string | null;
  files: CalibrationFile[];
  /** When this bundle was captured — the latest `info.capturedAt` among its
   *  files (parsed from the filename's own timestamp), falling back to file
   *  mtime for a file whose name didn't parse one. `null` only when every
   *  file in the bundle has neither. */
  capturedAt: string | null;
  /** True once this bundle is older than the configured calibration expiry
   *  (Settings → Library → "Dark/bias validity", 180 days by default) —
   *  bias/dark only (resolved via `frameType ?? group.type`, so a `mixed`
   *  group's own dark/bias rows are checked same as a standalone Darks/Bias
   *  group's), and only when `capturedAt` is known (an unknown capture date
   *  is never assumed expired; that would be guessing, not measuring). A
   *  sensor's dark current and read noise drift as it ages (dust settling,
   *  gradual degradation), so a bias/dark set captured long ago is worth
   *  re-shooting rather than trusted indefinitely — unlike the "reusable
   *  across sessions" framing bias/darks otherwise get. Always `false` for
   *  flat/flat-dark rows (and for a `mixed` row whose frameType didn't
   *  resolve), which are governed by session attachment instead
   *  (calibrationAttachments.ts), not age. */
  isExpired: boolean;
  /** Where this bundle is attached (calibrationAttachments.ts), for flat/
   *  flat-dark bundles only. Left `undefined` by this module — it stays a
   *  pure filesystem read with no database — and populated afterward by the
   *  `/calibrations` route, which is the one place calibration data and the
   *  attachments table meet. */
  attachments?: CalibrationAttachmentSummary[];
}

export interface CalibrationSubfolder {
  /** Per-camera-setup subfolder name, e.g. `G100_TECm8`, `G100_60s_TECm8`.
   *  Equal to the type folder's own name when the frames sit flat with no
   *  further nesting (ASIAIR's own SD-card layout). */
  name: string;
  fileCount: number;
  bytes: number;
  /** Latest file mtime in this subfolder, ISO, or null if empty. */
  modifiedAt: string | null;
  files: CalibrationFile[];
}

export interface CalibrationGroup {
  type: CalibrationFrameType | 'mixed';
  typeLabel: string;
  /** Top-level folder name as found on disk, e.g. `Bias`, `Darks`, `CALI_FRAME`. */
  folderName: string;
  /** Telescope id this scope belongs to, or null for the shared unscoped
   *  bucket (archiveFolders.ts's ARCHIVE_UNSCOPED_DIR). */
  scope: string | null;
  scopeLabel: string;
  fileCount: number;
  bytes: number;
  modifiedAt: string | null;
  subfolders: CalibrationSubfolder[];
  /** Same files as `subfolders`, flattened and re-bucketed by capture
   *  settings instead of by folder — see `CalibrationSettingsGroup`. Sorted
   *  exposure → binning → gain → temperature, ascending, with any field
   *  the filename didn't encode sorting last within its tier (an "unknown"
   *  bucket is still a usable bundle, just a less specific one). */
  settingsGroups: CalibrationSettingsGroup[];
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** ASIAIR's own JPEG preview alongside a frame (`<stem>_thn.jpg`) — the same
 *  `_thn.` marker telescopeFiles.ts's light-frame parsing recognizes. Left
 *  out of the calibration listing: it is a preview of the `.fit`/`.fits` row
 *  already shown next to it, not a second calibration frame, and showing both
 *  reads as double-counting rather than completeness. */
function isThumbnailPreview(name: string): boolean {
  return name.toLowerCase().includes('_thn.');
}

/** Walk one type-folder's contents, splitting it into subfolders (one level
 *  of nesting — a per-camera-setup grouping like `G100_TECm8` — is what every
 *  real-world layout seen so far uses) plus a synthetic "flat" subfolder for
 *  any files sitting directly in the type folder with no further nesting.
 *  Deeper nesting than that is walked too, flattened into the nearest
 *  first-level subfolder, rather than silently dropped. */
function scanTypeFolder(dir: string, folderName: string): CalibrationSubfolder[] {
  let topEntries: fs.Dirent[];
  try {
    topEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const subfolders: CalibrationSubfolder[] = [];

  const loose = topEntries.filter(e => e.isFile() && !isHiddenOrSystemFile(e.name) && !isThumbnailPreview(e.name));
  const previews = previewNamesOf(loose.map(e => e.name));
  const flatFiles = loose.filter(e => !previews.has(e.name));
  if (flatFiles.length > 0) {
    subfolders.push(buildSubfolder(dir, folderName, flatFiles.map(e => e.name)));
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const subDir = path.join(dir, entry.name);
    const fileNames = collectFileNamesRecursive(subDir, 1);
    if (fileNames.length === 0) continue;
    subfolders.push(buildSubfolder(subDir, entry.name, fileNames));
  }

  return subfolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const RAW_FRAME_EXT = /\.(?:fit|fits|fts|xisf)$/i;
const PREVIEW_PICTURE_EXT = /\.(?:jpe?g|png)$/i;

/** A picture beside a raw frame of the same name (`MasterDark_5_30.0s_26.0C_20261014-192837.fit` and its `.jpg`) is that frame's
 *  preview, the same image twice, so it is not a second frame. Names are compared within one folder. */
export function previewNamesOf(fileNames: string[]): Set<string> {
  const rawStems = new Set(fileNames.filter(n => RAW_FRAME_EXT.test(n)).map(n => n.replace(RAW_FRAME_EXT, '').toLowerCase()));
  return new Set(fileNames.filter(n => PREVIEW_PICTURE_EXT.test(n) && rawStems.has(n.replace(PREVIEW_PICTURE_EXT, '').toLowerCase())));
}

function collectFileNamesRecursive(dir: string, depth: number): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const nested = collectFileNamesRecursive(path.join(dir, entry.name), depth + 1);
      names.push(...nested.map(n => path.join(entry.name, n)));
      continue;
    }
    if (!entry.isFile() || isHiddenOrSystemFile(entry.name) || isThumbnailPreview(entry.name)) continue;
    names.push(entry.name);
  }
  const previews = previewNamesOf(names.filter(n => !n.includes(path.sep)));
  return previews.size > 0 ? names.filter(n => !previews.has(n)) : names;
}

function buildSubfolder(dir: string, name: string, relativeFileNames: string[]): CalibrationSubfolder {
  const files: CalibrationFile[] = [];
  let bytes = 0;
  let latestMs: number | null = null;

  for (const relName of relativeFileNames) {
    const abs = path.join(dir, relName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    bytes += stat.size;
    const mtimeMs = stat.mtimeMs;
    if (latestMs === null || mtimeMs > latestMs) latestMs = mtimeMs;
    // A nested relative name (e.g. `2026-08-15/frame.fit`) keeps its full
    // path in `name` so a namesake in a different sub-subfolder never
    // collides in the UI; recognized filenames are still parsed on the
    // basename alone since that's where the encoded metadata lives. Three
    // fields never live in the filename itself, only merged in when the
    // filename itself parsed (matching this module's "no info at all" rule
    // for anything unrecognized, rather than fabricating a partial row):
    //  - CALI_FRAME's `cam_0`/`cam_1` split is a subfolder one level below
    //    the type folder, read off the relative path (`dwarfCameraFromRelPath`).
    //  - DWARF_DARK's camera AND binning live in the session folder's own
    //    name (`this subfolder's `name`, e.g. `tele_exp_60_gain_60_bin_1_...`)
    //    — its per-file `raw_*.fits` name repeats neither.
    //  - A `mixed` (CALI_FRAME) group's real per-file bias/dark/flat type is
    //    this subfolder's own name too (`dark`/`bias`/`flat`), since that is
    //    literally what it is called one level below CALI_FRAME.
    const parsedInfo = parseCalibrationFilename(path.basename(relName));
    const caliFrameCamera = dwarfCameraFromRelPath(relName);
    const darkSession = dwarfDarkSessionFolderInfo(name);
    const frameType = calibrationFrameTypeFromFolderName(name);
    let info = parsedInfo;
    if (info) {
      const camera = caliFrameCamera ?? darkSession?.camera;
      if (camera !== undefined) info = { ...info, camera };
      if (info.binning === undefined && darkSession?.binning !== undefined) {
        info = { ...info, binning: darkSession.binning };
      }
      if (frameType !== undefined) info = { ...info, frameType };
    }
    files.push({
      name: relName,
      size: stat.size,
      modifiedAt: new Date(mtimeMs).toISOString(),
      path: abs,
      info,
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    name,
    fileCount: files.length,
    bytes,
    modifiedAt: isoOrNull(latestMs),
    files,
  };
}

/** `undefined` (filename didn't encode this field) always sorts as `null` in
 *  the public shape — "not present" is a real, meaningful bucket of its own,
 *  not a parse failure to hide. */
function orNull(v: number | undefined): number | null {
  return v === undefined ? null : v;
}

const UNKNOWN_KEY_TOKEN = 'x';

/** Fallback for the rare case the settings row itself can't be read — kept in
 *  sync with db.ts's schema default for the same column (Settings → Library
 *  → "Dark/bias validity"), which is what actually governs this in normal
 *  operation. ~6 months, this feature's original unit before it became a
 *  finer-grained days setting. */
const CALIBRATION_EXPIRY_DAYS_DEFAULT = 180;

/** How long a bias/dark set is trusted before it's flagged for re-shooting —
 *  see `CalibrationSettingsGroup.isExpired`. User-configurable in days
 *  (Settings → Library); falls back to the default above if the setting is
 *  somehow missing/non-numeric rather than treating everything as expired. */
function calibrationExpiryDays(): number {
  const configured = getSettingsData().calibrationExpiryDays;
  return typeof configured === 'number' && configured > 0 ? configured : CALIBRATION_EXPIRY_DAYS_DEFAULT;
}

function isExpiredCalibration(type: CalibrationFrameType | 'mixed', capturedAt: string | null): boolean {
  if (type !== 'bias' && type !== 'dark') return false;
  if (!capturedAt) return false;
  const expiryCutoff = new Date();
  expiryCutoff.setDate(expiryCutoff.getDate() - calibrationExpiryDays());
  return new Date(capturedAt).getTime() < expiryCutoff.getTime();
}

/** The bundle's own "captured at" — the latest of each file's parsed
 *  filename timestamp, falling back to file mtime for one that didn't parse
 *  a timestamp at all. Latest (not earliest) so a bundle that got a few
 *  fresh frames added to an older set reads by its most recent contribution,
 *  not its oldest. */
function latestCapturedAt(files: readonly CalibrationFile[]): string | null {
  let latestMs: number | null = null;
  for (const file of files) {
    const ts = file.info?.capturedAt ?? file.modifiedAt;
    const ms = new Date(ts).getTime();
    if (!isNaN(ms) && (latestMs === null || ms > latestMs)) latestMs = ms;
  }
  return isoOrNull(latestMs);
}

/** A cooled camera's TEC holds *near* its setpoint, not exactly on it — the
 *  real dark frames this feature was built against drifted by a few tenths
 *  of a degree run to run. Without tolerance, 25 darks at -7.8/-8.0/-8.1/
 *  -7.9°C would fragment into three or four near-duplicate one-or-two-frame
 *  bundles instead of the one 25-frame set they actually are. Frames whose
 *  temperatures land within this many degrees of each other cluster into one
 *  bundle instead. Exposure/binning/gain get no such tolerance — those are
 *  discrete camera settings a user picks exactly, not an analog reading that
 *  drifts. */
const TEC_TOLERANCE_C = 1;

/** Resolves a bundle's effective type for expiry/attach purposes: a
 *  non-`mixed` group's own type (its files are already all one type), or a
 *  `mixed` group's own resolved `frameType` when its files parsed cleanly
 *  enough to have one. Falls back to `'mixed'` itself only when a `mixed`
 *  group's files didn't resolve a type — `isExpiredCalibration` already
 *  treats that as "never expired", the same safe default as before this
 *  distinction existed. */
export function resolveFrameType(groupType: CalibrationFrameType | 'mixed', bundleFrameType: CalibrationFrameType | null): CalibrationFrameType | 'mixed' {
  return groupType === 'mixed' ? (bundleFrameType ?? 'mixed') : groupType;
}

/** Grouping key for the settings that never need tolerance — everything
 *  except temperature, which is clustered separately below. Camera is
 *  included here (not just in the final key) so a wide and a tele Dwarf dark
 *  sharing every other setting never even reach temperature clustering
 *  together — see `CalibrationSettingsGroup.camera`. `frameType` is included
 *  ONLY for a `mixed` group (the caller passes `undefined` otherwise): a
 *  bias and a flat frame sharing every other setting (Dwarf's
 *  `bias_gain_2_bin_1.fits` / `flat_gain_2_bin_1.fits` — neither carries an
 *  exposure or temperature) would otherwise silently bucket together. */
function coarseSettingsKey(info: CalibrationFrameInfo | null, includeFrameType: boolean): string {
  const part = (v: number | undefined) => (v === undefined ? UNKNOWN_KEY_TOKEN : String(v));
  const parts = [info?.camera ?? UNKNOWN_KEY_TOKEN, part(info?.exposureSec), part(info?.binning), part(info?.gain)];
  if (includeFrameType) parts.unshift(info?.frameType ?? UNKNOWN_KEY_TOKEN);
  return parts.join('|');
}

interface CoarseBucket {
  camera: string | null;
  frameType: CalibrationFrameType | null;
  exposureSec: number | null;
  binning: number | null;
  gain: number | null;
  files: CalibrationFile[];
}

/** Build one `CalibrationSettingsGroup` from an already-decided set of files
 *  sharing exposure/binning/gain and a (possibly clustered) temperature.
 *  `sensorTempC` is the cluster's own representative — see
 *  `buildSettingsGroups` — not necessarily any single file's exact reading.
 *  `groupType` is only used (via `resolveFrameType`) to decide whether
 *  `isExpired` can ever be true. */
function finishSettingsGroup(
  bucket: CoarseBucket,
  files: readonly CalibrationFile[],
  sensorTempC: number | null,
  groupType: CalibrationFrameType | 'mixed',
): CalibrationSettingsGroup {
  const part = (v: number | null) => (v === null ? UNKNOWN_KEY_TOKEN : String(v));
  const key = [bucket.frameType ?? UNKNOWN_KEY_TOKEN, bucket.camera ?? UNKNOWN_KEY_TOKEN, part(bucket.exposureSec), part(bucket.binning), part(bucket.gain), part(sensorTempC)].join('|');

  let bytes = 0;
  let latestMs: number | null = null;
  for (const file of files) {
    bytes += file.size;
    const mtimeMs = new Date(file.modifiedAt).getTime();
    if (latestMs === null || mtimeMs > latestMs) latestMs = mtimeMs;
  }

  const capturedAt = latestCapturedAt(files);

  return {
    key,
    camera: bucket.camera,
    frameType: bucket.frameType,
    exposureSec: bucket.exposureSec,
    binning: bucket.binning,
    gain: bucket.gain,
    sensorTempC,
    fileCount: files.length,
    bytes,
    modifiedAt: isoOrNull(latestMs),
    capturedAt,
    isExpired: isExpiredCalibration(resolveFrameType(groupType, bucket.frameType), capturedAt),
    files: [...files],
  };
}

/**
 * Split one coarse (exposure/binning/gain) bucket's temperature-bearing
 * files into clusters no wider than TEC_TOLERANCE_C between consecutive
 * readings — a deterministic, order-independent "maximum gap" clustering
 * (sorted first, so it doesn't depend on filesystem iteration order): sort
 * ascending, start a new cluster whenever the gap to the previous reading
 * exceeds the tolerance. Each cluster's representative temperature is its
 * own mean, rounded to one decimal place, rather than a fixed rounding grid
 * — a grid anchored at, say, every even degree would inconsistently split a
 * real -9.0°C setpoint's own readings across the -8°C and -10°C buckets
 * depending on which side of the boundary each one happened to drift to.
 */
function clusterByTemperature(files: readonly CalibrationFile[]): Array<{ files: CalibrationFile[]; representative: number }> {
  // The caller passes only files that carry a reading; pairing each file with
  // its temperature up front lets the arithmetic below use a plain number.
  const sorted = files
    .flatMap(file => {
      const temp = file.info?.sensorTempC;
      return temp === undefined ? [] : [{ file, temp }];
    })
    .sort((a, b) => a.temp - b.temp);
  const clusters: Array<{ files: CalibrationFile[]; representative: number }> = [];

  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const endOfCluster = i === sorted.length || sorted[i].temp - sorted[i - 1].temp > TEC_TOLERANCE_C;
    if (!endOfCluster) continue;
    const cluster = sorted.slice(start, i);
    const mean = cluster.reduce((sum, entry) => sum + entry.temp, 0) / cluster.length;
    clusters.push({ files: cluster.map(entry => entry.file), representative: Math.round(mean * 10) / 10 });
    start = i;
  }
  return clusters;
}

/** Re-buckets every file across every subfolder of one `CalibrationGroup` by
 *  capture settings instead of by the folder it happened to be archived
 *  under. See `CalibrationSettingsGroup`. */
function buildSettingsGroups(subfolders: readonly CalibrationSubfolder[], type: CalibrationFrameType | 'mixed'): CalibrationSettingsGroup[] {
  const isMixed = type === 'mixed';
  const coarseBuckets = new Map<string, CoarseBucket>();
  for (const sub of subfolders) {
    for (const file of sub.files) {
      const key = coarseSettingsKey(file.info, isMixed);
      let bucket = coarseBuckets.get(key);
      if (!bucket) {
        bucket = {
          camera: file.info?.camera ?? null,
          frameType: isMixed ? (file.info?.frameType ?? null) : null,
          exposureSec: orNull(file.info?.exposureSec),
          binning: orNull(file.info?.binning),
          gain: orNull(file.info?.gain),
          files: [],
        };
        coarseBuckets.set(key, bucket);
      }
      bucket.files.push(file);
    }
  }

  const groups: CalibrationSettingsGroup[] = [];
  for (const bucket of coarseBuckets.values()) {
    const withTemp = bucket.files.filter(f => f.info?.sensorTempC !== undefined);
    const withoutTemp = bucket.files.filter(f => f.info?.sensorTempC === undefined);

    if (withoutTemp.length > 0) {
      groups.push(finishSettingsGroup(bucket, withoutTemp, null, type));
    }
    for (const cluster of clusterByTemperature(withTemp)) {
      groups.push(finishSettingsGroup(bucket, cluster.files, cluster.representative, type));
    }
  }

  // Frame type → camera → exposure → binning → gain → temperature,
  // ascending; `null` (unknown) sorts after every real value within its own
  // tier rather than interleaving with them, so "unrecognized settings"
  // reads as one deliberate catch-all bucket at the end instead of
  // scattered NaN-like ordering. Frame type sorts first (only ever set for a
  // `mixed` group) so a Dwarf CALI_FRAME's bias/dark/flat rows group
  // together instead of interleaving by exposure; camera sorts next so a
  // Dwarf 3's two cameras' bundles group together within that.
  const rank = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v);
  const stringRank = (v: string | null) => v ?? '￿';
  return groups.sort((a, b) =>
    stringRank(a.frameType).localeCompare(stringRank(b.frameType))
    || stringRank(a.camera).localeCompare(stringRank(b.camera))
    || rank(a.exposureSec) - rank(b.exposureSec)
    || rank(a.binning) - rank(b.binning)
    || rank(a.gain) - rank(b.gain)
    || rank(a.sensorTempC) - rank(b.sensorTempC),
  );
}

function scopeLabel(scope: string | null, profilesById: Map<string, string>): string {
  if (scope === null) return 'Unassigned';
  return profilesById.get(scope) ?? 'Deleted telescope';
}

/** Case-insensitive check against ASIAIR's own `Autorun`/`Plan` capture-mode
 *  folder names (asiairWalker.ts). Archived live-sync calibration data keeps
 *  this prefix in its relative path (`ASIAIR_CALIBRATION_PATHS` is
 *  `${mode}/${type}`, e.g. `Plan/Dark` — "worth preserving in the archive"
 *  per that module's own comment), so `_archive/<scope>/Plan/Dark/...` is a
 *  real, expected shape here, distinct from the folder-import wizard's flat
 *  `_archive/<scope>/Darks/...` (no mode prefix — a manual/NAS import has no
 *  Autorun-vs-Plan distinction to preserve). Both shapes must resolve to the
 *  same `CalibrationGroup` list, or a live-synced ASIAIR's calibration frames
 *  (the common case) silently never appear here at all — a top-level
 *  `readdirSync` alone only ever sees `Plan`/`Autorun`, never `Dark` itself. */
function isAsiairModeFolder(name: string): boolean {
  return ASIAIR_MODE_FOLDERS.some(m => m.toLowerCase() === name.toLowerCase());
}

function buildGroup(
  scope: string | null,
  scopeLabelValue: string,
  folderName: string,
  type: CalibrationFrameType | 'mixed',
  dir: string,
  synthSubfolderName: string,
): CalibrationGroup | null {
  const subfolders = scanTypeFolder(dir, synthSubfolderName);
  if (subfolders.length === 0) return null;

  const fileCount = subfolders.reduce((sum, s) => sum + s.fileCount, 0);
  const bytes = subfolders.reduce((sum, s) => sum + s.bytes, 0);
  const modifiedMs = subfolders.reduce<number | null>((latest, s) => {
    if (!s.modifiedAt) return latest;
    const ms = new Date(s.modifiedAt).getTime();
    return latest === null || ms > latest ? ms : latest;
  }, null);

  return {
    type,
    typeLabel: calibrationTypeLabel(type),
    folderName,
    scope,
    scopeLabel: scopeLabelValue,
    fileCount,
    bytes,
    modifiedAt: isoOrNull(modifiedMs),
    subfolders,
    settingsGroups: buildSettingsGroups(subfolders, type),
  };
}

/**
 * Every calibration group across every archive scope, sorted the way a
 * directory listing would be: by scope (telescopes first, in profile order,
 * unassigned last), then by frame type, then by the folder's own name.
 * Subfolders and files within each group are already sorted by
 * `scanTypeFolder`/`buildSubfolder`.
 */
export function listCalibrationLibrary(): CalibrationGroup[] {
  const profiles = getAllProfiles();
  const profilesById = new Map(profiles.map(p => [p.id, p.name]));
  const profileOrder = new Map(profiles.map((p, i) => [p.id, i]));

  const scopes = listArchiveScopes();
  const groups: CalibrationGroup[] = [];

  for (const scope of scopes) {
    const archiveDir = getArchiveDir(scope);
    const label = scopeLabel(scope, profilesById);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(archiveDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      // Folder-import wizard shape: the calibration folder sits directly at
      // the scope root (`_archive/<scope>/Darks/...`).
      const directType = calibrationTypeForFolderName(entry.name);
      if (directType !== null) {
        const dir = path.join(archiveDir, entry.name);
        const group = buildGroup(scope, label, entry.name, directType, dir, entry.name);
        if (group) groups.push(group);
        continue;
      }

      // ASIAIR live-sync shape: the calibration folder sits one level under
      // its capture-mode wrapper (`_archive/<scope>/Plan/Dark/...`). Descend
      // once and check that folder's children instead.
      if (isAsiairModeFolder(entry.name)) {
        const modeDir = path.join(archiveDir, entry.name);
        let modeEntries: fs.Dirent[];
        try {
          modeEntries = fs.readdirSync(modeDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of modeEntries) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          const type = calibrationTypeForFolderName(sub.name);
          if (type === null) continue;
          const dir = path.join(modeDir, sub.name);
          const group = buildGroup(scope, label, `${entry.name}/${sub.name}`, type, dir, sub.name);
          if (group) groups.push(group);
        }
      }
    }
  }

  return groups.sort((a, b) => {
    if (a.scope !== b.scope) {
      // Unassigned (null) sorts after every real telescope, matching the
      // Settings > Telescopes archive browser's own "per-telescope, then
      // unscoped leftovers" convention.
      if (a.scope === null) return 1;
      if (b.scope === null) return -1;
      const orderA = profileOrder.get(a.scope) ?? Number.MAX_SAFE_INTEGER;
      const orderB = profileOrder.get(b.scope) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
    }
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.folderName.localeCompare(b.folderName, undefined, { numeric: true });
  });
}

/** One filename-safe token per settings field, for building a bundle ZIP's
 *  download name — `null` (unknown) reads as "unk" rather than the literal
 *  sentinel key token, which would look like a bug in a downloaded filename. */
function settingsToken(value: number | null, suffix: string): string {
  return value === null ? 'unk' : `${value}${suffix}`;
}

/** Human-facing base name for a bundle ZIP, e.g. `Darks_60s_Bin1_gain100_-8C`
 *  (or, for one bundle inside a Dwarf 3's mixed CALI_FRAME, `Bias_cam1_..._unk`
 *  — using the bundle's own resolved frame type, not the group's generic
 *  "Calibration (mixed)" label, once it has one) — no extension, caller
 *  appends `.zip`. */
export function calibrationBundleName(group: CalibrationGroup, set: CalibrationSettingsGroup): string {
  const label = set.frameType ? calibrationTypeLabel(set.frameType) : group.typeLabel;
  const parts = [
    label.replace(/\s+/g, ''),
    ...(set.camera ? [set.camera.replace(/_/g, '')] : []),
    settingsToken(set.exposureSec, 's'),
    `Bin${set.binning ?? 'unk'}`,
    set.gain === null ? 'unk' : `gain${set.gain}`,
    settingsToken(set.sensorTempC, 'C'),
  ];
  return parts.join('_');
}

/**
 * Re-scans the archive and locates one exact `(scope, folderName, key)`
 * bundle for download — never trusts a client-supplied path, only an opaque
 * key matched against a fresh, authoritative filesystem walk. `scope` uses
 * the same `null` = shared unscoped bucket convention as everywhere else in
 * this module.
 */
export function findCalibrationBundle(
  scope: string | null,
  folderName: string,
  key: string,
): { group: CalibrationGroup; set: CalibrationSettingsGroup } | null {
  const group = listCalibrationLibrary().find(g => g.scope === scope && g.folderName === folderName);
  if (!group) return null;
  const set = group.settingsGroups.find(s => s.key === key);
  if (!set) return null;
  return { group, set };
}

export interface DeleteBundleResult {
  deleted: number;
  failed: number;
}

/**
 * Permanently removes every file in one bundle from the archive on disk —
 * unlike detaching a flat/flat-dark (calibrationAttachments.ts), which only
 * removes a database pointer, this deletes the actual bytes. Meant for
 * expired bias/dark sets a user wants to reclaim disk space from once
 * they've re-shot fresh ones; the route layer restricts this to bias/dark
 * bundles only (flats/flat-darks are managed by attaching them to an
 * object, not by deleting them here).
 *
 * Re-derives the file list from a fresh scan via `findCalibrationBundle`
 * rather than trusting anything client-supplied — same reasoning as the
 * download route. Prunes now-empty per-camera-setting subfolders afterward
 * (e.g. a `G100_TECm8/` that held only this bundle's files), bounded at the
 * type folder itself (`Darks/`, `Bias/`, ...), which is never removed even
 * if it ends up empty — that would read as "no calibration data was ever
 * here" rather than "it was deliberately cleared".
 */
export function deleteCalibrationBundle(
  scope: string | null,
  folderName: string,
  key: string,
): DeleteBundleResult | null {
  const found = findCalibrationBundle(scope, folderName, key);
  if (!found) return null;

  let deleted = 0;
  let failed = 0;
  const parentDirs = new Set<string>();
  for (const file of found.set.files) {
    try {
      fs.unlinkSync(file.path);
      deleted++;
      parentDirs.add(path.dirname(file.path));
    } catch {
      failed++;
    }
  }

  const typeDir = path.join(getArchiveDir(scope), ...folderName.split('/'));
  for (const dir of parentDirs) {
    let current = dir;
    while (current !== typeDir && (current + path.sep).startsWith(typeDir + path.sep)) {
      let remaining: string[];
      try {
        remaining = fs.readdirSync(current);
      } catch {
        break;
      }
      if (remaining.length > 0) break;
      try {
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }

  return { deleted, failed };
}
