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
import { parseFilename, isRealFile } from '../telescopeFiles.js';
import { debugLog } from '../debugLogger.js';

/** Why a file was left out of an import. Codes are stable and safe to persist;
 *  SKIP_LABELS holds the wording shown to the user. */
export type ImportSkipReason =
  | 'not-a-real-file'
  | 'processing-artifact'
  | 'failed-frame'
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
  'sub-frames-disabled': 'sub-frames, because "Include subframes" is off',
  'sub-folder-preview': 'preview images inside sub-frame folders',
  'thumbnails-disabled': 'thumbnails, because thumbnail import is off',
  'jpg-disabled': 'JPG images, because JPG import is off',
  'fits-disabled': 'FITS images, because FITS import is off',
  'videos-disabled': 'videos, because video import is off',
  'unsupported-type': 'files of a type Nebulis cannot import',
};

export type ImportDecision =
  | { import: true }
  | { import: false; reason: ImportSkipReason };

export interface ClassifyOptions {
  /** True when the file was found inside a `_sub` directory. Everything in one
   *  is a sub-frame whatever the file is called, so the directory outranks the
   *  filename: callers that know the location should say so. Callers that don't
   *  (SMB fetch, upload distribute) still get the filename-based answer. */
  fromSubFolder?: boolean;
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
  // Reject macOS metadata, hidden files, and anything not a real image/data file
  if (!isRealFile(filename)) {
    return drop(filename, 'not-a-real-file', 'not a real file — hidden/system/metadata');
  }

  // Dwarf internal processing artifacts (reference frame, stacking counter, etc.)
  // start with img_. Never import these regardless of any other setting.
  if (/^img_/i.test(filename)) {
    return drop(filename, 'processing-artifact', 'Dwarf processing artifact — img_ prefix');
  }

  // Dwarf marks frames it rejected during stacking with a "failed_" prefix.
  // Never import these regardless of any other setting. Anchored to the
  // prefix (not a bare .includes('failed')) so a user's own file containing
  // "failed" anywhere in the name — e.g. "M31_failed_stack_retry.fits" — isn't
  // silently dropped.
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
  // Anything else with a recognized extension but no explicit rule above.
  // isRealFile already rejected unknown extensions, so this is a safety net:
  // reject rather than silently ingesting a type we have no handling for.
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
