/**
 * Shared file-eligibility gate for every import path (SMB fetch, folder copy,
 * upload distribute, and the folder-import wizard's scan + commit).
 *
 * Lives in its own module so the scan/commit code can apply the exact same
 * filter the rest of the importer uses without creating an import cycle with
 * import.ts. Behavior is driven by the user's import settings:
 *   importThumbnails / importJpg / importFits / importVideos / importSubFrames.
 *
 * `classifyImportFile` is the single authority: it returns *why* a file is out,
 * so the wizard can tell the user what it left behind instead of just showing a
 * shorter list than the folder they picked. `shouldImportFile` is the boolean
 * shorthand for callers that only need the verdict.
 */
import { parseFilename, isRealFile, isSidecarFile, isHiddenOrSystemFile } from '../telescopeFiles.js';
import { debugLog } from '../debugLogger.js';

/** Why a file was left out of an import. Codes are stable and safe to persist;
 *  SKIP_LABELS holds the wording shown to the user. */
export type ImportSkipReason =
  | 'not-a-real-file'
  | 'processing-artifact'
  | 'failed-frame'
  | 'non-observation-folder'
  | 'undecodable-session-folder'
  | 'deleted-session'
  | 'date-dropped'
  | 'sub-frames-disabled'
  | 'sub-folder-preview'
  | 'thumbnails-disabled'
  | 'jpg-disabled'
  | 'fits-disabled'
  | 'videos-disabled'
  | 'unsupported-type';

/** Reads as "<count> <label>", e.g. "1184 sub-frames, because ...". */
export const SKIP_LABELS: Record<ImportSkipReason, string> = {
  'not-a-real-file': 'hidden or system files',
  'processing-artifact': 'telescope processing artifacts',
  'failed-frame': 'frames the telescope rejected while stacking',
  // Counted per folder, not per file — see isNonObjectFolder in objectDiscovery.ts.
  // classifyImportFile never returns this reason; the scan adds it directly.
  'non-observation-folder': 'folders that hold no observations (calibration frames, restacks, daytime photos)',
  // Also never returned by classifyImportFile: dwarfLocalName in import.ts
  // decides it, because only the naming step knows whether the session folder
  // yielded a target and timestamp to stamp into the local filename.
  'undecodable-session-folder': 'files in session folders Nebulis could not read a target and date from',
  'deleted-session': 'files belonging to sessions you deleted, which are never re-imported',
  // Decided by commitFolderImport, not classifyImportFile: the file is
  // importable, but the plan sent back from the review step gave its session no
  // date to file it under.
  'date-dropped': 'files left without a session date in the review step',
  'sub-frames-disabled': 'sub-frames, because "Include subframes" is off',
  'sub-folder-preview': 'preview images inside sub-frame folders',
  'thumbnails-disabled': 'thumbnails, because thumbnail import is off',
  'jpg-disabled': 'JPG images, because JPG import is off',
  'fits-disabled': 'FITS images, because FITS import is off',
  'videos-disabled': 'videos, because video import is off',
  'unsupported-type': 'files of a type Nebulis cannot import',
};

/** One reason files were left out of an import, and how many. `label` is the
 *  wording to show the user; the whole thing reads as "<count> <label>". */
export interface ImportSkipSummary {
  reason: ImportSkipReason;
  label: string;
  count: number;
  /** Total size of the skipped files, when the caller knew it. 0 means "not
   *  measured", not "empty" — a remote listing does not always carry sizes, and
   *  history rows written before this field existed have none. The UI shows a
   *  size only when this is above zero, so the two cases render the same. */
  bytes: number;
}

/** Running per-run tally. Every import path accumulates into one of these and
 *  hands it to `summarizeSkips` for display, so the wizard and the telescope
 *  import report the same reasons in the same words. */
export type SkipTally = Map<ImportSkipReason, { count: number; bytes: number }>;

/**
 * Add `n` files (and optionally their total size) to a tally.
 *
 * Hidden/system junk (.DS_Store, AppleDouble sidecars) is deliberately never
 * counted: the user does not think of it as their files, so reporting it would
 * only add noise to the one thing this summary exists to explain. Enforced here
 * rather than at each call site so no path can start reporting it by accident.
 */
export function countSkip(tally: SkipTally, reason: ImportSkipReason, n = 1, bytes = 0): void {
  if (reason === 'not-a-real-file' || n <= 0) return;
  const prev = tally.get(reason);
  tally.set(reason, {
    count: (prev?.count ?? 0) + n,
    bytes: (prev?.bytes ?? 0) + Math.max(0, bytes),
  });
}

/** Collapse a tally into the user-facing list, largest group first. */
export function summarizeSkips(tally: SkipTally): ImportSkipSummary[] {
  return Array.from(tally.entries())
    .filter(([, v]) => v.count > 0)
    .map(([reason, v]) => ({ reason, label: SKIP_LABELS[reason], count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.count - a.count);
}

export type ImportDecision =
  | { import: true }
  | { import: false; reason: ImportSkipReason };

export interface ClassifyOptions {
  /** True when the file was found inside a `_sub` directory. Everything in one
   *  is a sub-frame whatever the file is called, so the directory outranks the
   *  filename: callers that know the location should say so. The folder-import
   *  wizard and the telescope import both do. Callers that genuinely cannot
   *  tell (upload distribute, where the client sends a flat file list) still
   *  get the filename-based answer. */
  fromSubFolder?: boolean;
}

/** The one `img_`-prefixed Dwarf file that is real science output rather than an
 *  internal working image. Anchored to the stem so it cannot be widened by a
 *  filename that merely contains the phrase. */
export function isDwarfMasterStack(filename: string): boolean {
  return /^img_stacked_all\.[a-z0-9]+$/i.test(filename);
}

const KEEP: ImportDecision = { import: true };

function drop(filename: string, reason: ImportSkipReason, detail: string): ImportDecision {
  debugLog('import:filter', `Rejected: "${filename}" (${detail})`);
  return { import: false, reason };
}

/** Decide whether a file should be imported, and if not, why not. */
export function classifyImportFile(
  filename: string,
  settings: Record<string, unknown>,
  opts: ClassifyOptions = {},
): ImportDecision {
  /**
   * Archive mode: keep EVERYTHING the device holds, so the library folder is a
   * complete copy rather than only the parts Nebulis renders.
   *
   * This is a hard override, not a relaxation of a few rules. It bypasses the
   * per-type toggles as well (JPG / FITS / thumbnails / sub-frames / videos) —
   * a user who asks to archive everything means everything, and having a
   * "keep it all" switch that silently still dropped whole categories would be
   * worse than not offering it. The one exclusion is OS bookkeeping, which is
   * not the user's data in the first place.
   *
   * The size implication is real (sub-frames dominate a Dwarf session), so the
   * UI states it plainly rather than the filter second-guessing the request.
   */
  if (settings.archiveAllFiles === true) {
    // `.DS_Store`, AppleDouble forks, `Thumbs.db`. Copying these into an archive
    // is noise, not completeness, and they are not files the user captured.
    if (isHiddenOrSystemFile(filename)) {
      return drop(filename, 'not-a-real-file', 'hidden or system file');
    }
    return KEEP;
  }

  // Sidecars are checked before isRealFile, which is image-only by design (see
  // isSidecarFile). They carry the best per-session metadata a device produces
  // and used to be dropped outright for not being pictures.
  if (isSidecarFile(filename)) return KEEP;

  // OS bookkeeping and anything without a recognized extension.
  if (!isRealFile(filename)) {
    return drop(filename, 'not-a-real-file', 'not a real file — hidden/system/metadata');
  }

  // Dwarf writes several files with an `img_` prefix. Most are internal working
  // images: `img_reference.png` is the alignment reference frame and
  // `img_stacked_counter.png` is a per-pixel stack-count map (both 16-bit RGB at
  // sensor resolution). Archive mode keeps them; normally they are refused.
  //
  // `img_stacked_all` is not one of them. It is the master integration — a
  // 32-bit FLOAT RGB image at full sensor resolution, ~100 MB, and the
  // highest-fidelity output the device produces. Blanket-rejecting the prefix
  // silently discarded it from every single Dwarf session, archive mode or not.
  if (/^img_/i.test(filename) && !isDwarfMasterStack(filename)) {
    return drop(filename, 'processing-artifact', 'Dwarf processing artifact — img_ prefix');
  }

  // Dwarf marks frames it rejected during stacking with a "failed_" prefix.
  // Anchored to the prefix (not a bare .includes('failed')) so a user's own file
  // containing "failed" anywhere in the name — e.g. "M31_failed_stack_retry.fits"
  // — isn't silently dropped.
  if (/^failed_/i.test(filename)) {
    return drop(filename, 'failed-frame', 'Dwarf failed frame marker');
  }

  const ext = filename.toLowerCase();
  const parsed = parseFilename(filename);

  // The filename usually gives it away (SeeStar names sub-frames Light_*), but
  // the directory is the real authority: everything in a `_sub` folder is a
  // sub-frame however it happens to be named.
  if (opts.fromSubFolder === true || parsed.type === 'sub') {
    if (settings.importSubFrames !== true) {
      return drop(filename, 'sub-frames-disabled', 'sub-frame — importSubFrames disabled');
    }
    // Sub-frame import is raw FITS only. Some firmware drops a frame-named
    // preview (e.g. Light_*.jpg) into the _sub folder, which parseFilename also
    // classifies as 'sub'. Never import those — JPGs must not ride in under the
    // sub-frame setting.
    if (!(ext.endsWith('.fit') || ext.endsWith('.fits') || ext.endsWith('.fts'))) {
      return drop(filename, 'sub-folder-preview', 'sub-frame folder image — sub-frames are FITS only');
    }
    return KEEP;
  }
  if (parsed.isThumbnail) {
    if (settings.importThumbnails === false) {
      return drop(filename, 'thumbnails-disabled', 'thumbnail — importThumbnails disabled');
    }
    return KEEP;
  }
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) {
    if (settings.importJpg === false) {
      return drop(filename, 'jpg-disabled', 'JPG — importJpg disabled');
    }
    return KEEP;
  }
  if (ext.endsWith('.fit') || ext.endsWith('.fits') || ext.endsWith('.fts')) {
    if (settings.importFits === false) {
      return drop(filename, 'fits-disabled', 'FITS — importFits disabled');
    }
    return KEEP;
  }
  if (ext.endsWith('.avi') || ext.endsWith('.mp4') || ext.endsWith('.mov')) {
    if (settings.importVideos !== true) {
      return drop(filename, 'videos-disabled', 'video — importVideos disabled');
    }
    return KEEP;
  }
  // PNG / TIFF: rendered raster images from stacking apps and processed
  // exports. Always imported (isRealFile already limited us to known
  // extensions); they are not governed by importJpg, which is JPEG-specific.
  if (ext.endsWith('.png') || ext.endsWith('.tif') || ext.endsWith('.tiff')) {
    return KEEP;
  }
  // Anything with a recognized extension but no explicit rule above. A safety
  // net: refuse rather than silently ingesting a type we have no handling for.
  // (Archive mode already returned above.)
  return drop(filename, 'unsupported-type', 'no import rule for this type');
}

/** Returns true if the file extension should be imported based on settings. */
export function shouldImportFile(
  filename: string,
  settings: Record<string, unknown>,
  opts: ClassifyOptions = {},
): boolean {
  return classifyImportFile(filename, settings, opts).import;
}
