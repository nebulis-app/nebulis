/**
 * Shared file-eligibility gate for every import path (SMB fetch, folder copy,
 * upload distribute, and the folder-import wizard's scan + commit).
 *
 * Lives in its own module so the scan/commit code can apply the exact same
 * filter the rest of the importer uses without creating an import cycle with
 * import.ts. Behavior is driven by the user's import settings:
 *   importThumbnails / importJpg / importFits / importVideos / importSubFrames.
 */
import { parseFilename, isRealFile } from '../telescopeFiles.js';
import { debugLog } from '../debugLogger.js';

/** Returns true if the file extension should be imported based on settings. */
export function shouldImportFile(filename: string, settings: Record<string, unknown>): boolean {
  // Reject macOS metadata, hidden files, and anything not a real image/data file
  if (!isRealFile(filename)) {
    debugLog('import:filter', `Rejected: "${filename}" (not a real file — hidden/system/metadata)`);
    return false;
  }

  // Dwarf internal processing artifacts (reference frame, stacking counter, etc.)
  // start with img_. Never import these regardless of any other setting.
  if (/^img_/i.test(filename)) {
    debugLog('import:filter', `Rejected: "${filename}" (Dwarf processing artifact — img_ prefix)`);
    return false;
  }

  // Dwarf marks frames it rejected during stacking with a "failed_" prefix.
  // Never import these regardless of any other setting.
  if (filename.toLowerCase().includes('failed')) {
    debugLog('import:filter', `Rejected: "${filename}" (Dwarf failed frame marker)`);
    return false;
  }

  const ext = filename.toLowerCase();
  const parsed = parseFilename(filename);

  if (parsed.type === 'sub') {
    if (settings.importSubFrames !== true) {
      debugLog('import:filter', `Rejected: "${filename}" (sub-frame — importSubFrames disabled)`);
      return false;
    }
    // Sub-frame import is raw FITS only. Some firmware drops a frame-named
    // preview (e.g. Light_*.jpg) into the _sub folder, which parseFilename also
    // classifies as 'sub'. Never import those — JPGs must not ride in under the
    // sub-frame setting.
    if (!(ext.endsWith('.fit') || ext.endsWith('.fits'))) {
      debugLog('import:filter', `Rejected: "${filename}" (sub-frame folder image — sub-frames are FITS only)`);
      return false;
    }
    return true;
  }
  if (parsed.isThumbnail) {
    if (settings.importThumbnails === false) {
      debugLog('import:filter', `Rejected: "${filename}" (thumbnail — importThumbnails disabled)`);
      return false;
    }
    return true;
  }
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) {
    if (settings.importJpg === false) {
      debugLog('import:filter', `Rejected: "${filename}" (JPG — importJpg disabled)`);
      return false;
    }
    return true;
  }
  if (ext.endsWith('.fit') || ext.endsWith('.fits')) {
    if (settings.importFits === false) {
      debugLog('import:filter', `Rejected: "${filename}" (FITS — importFits disabled)`);
      return false;
    }
    return true;
  }
  if (ext.endsWith('.avi') || ext.endsWith('.mp4') || ext.endsWith('.mov')) {
    if (settings.importVideos !== true) {
      debugLog('import:filter', `Rejected: "${filename}" (video — importVideos disabled)`);
      return false;
    }
    return true;
  }
  debugLog('import:filter', `Accepted: "${filename}" (unknown type, allowing)`);
  return true;
}
