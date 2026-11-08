/**
 * Where a "Save as new version" picture from the image editor goes: a new `<objectId>_YYYYMMDD-HHMMSSE.<ext>` file in
 * the object's folder, so it shows under Telescope Images for that night.
 */
import fs from 'fs';
import path from 'path';
import { getObjectFolderName } from './objects.js';
import { getLibraryDir } from '../libraryPath.js';
import { activeSiteTimeZone } from '../siteTimeZone.js';
import { localParts } from '../timezone.js';
import { clampToNightSafeTime } from '../telescopeFiles.js';

/**
 * The name and destination for a new edited variant, creating the object folder if it is missing.
 *
 * The filename must stay parseable by `parseFilename`: the trailing `E` marks an edited variant and lands in the
 * simpleMatch suffix slot (`[A-Z]?`). Free-form text like ` (edited)` breaks the regex, so the file would be saved on
 * disk but invisible to getLocalFiles().
 *
 * `date` is the session the user is editing, not this file's own capture time. The embedded time of day is clamped
 * into the rollover-safe zone (see clampToNightSafeTime) so an edit made at 2am is not rolled back a day by
 * sessionNightFor the next time it is read.
 *
 * Throws when the object id resolves outside the library: getObjectFolderName falls back to the raw id on a DB miss,
 * so a crafted id with traversal tokens would otherwise write outside LIBRARY_DIR.
 */
export function editedVariantTarget(objectId: string, date: string, ext: string): { objDir: string; filename: string; destPath: string } {
  const libraryDir = getLibraryDir();
  const objDir = path.resolve(libraryDir, getObjectFolderName(objectId));
  if (!objDir.startsWith(libraryDir + path.sep)) throw new Error('Object id resolves outside the library');

  const now = localParts(new Date(), activeSiteTimeZone());
  const datePart = date.replace(/-/g, '');
  const rawTimePart = [now.hour, now.minute, now.second].map(n => String(n).padStart(2, '0')).join('');
  const timePart = clampToNightSafeTime(rawTimePart);
  // The extension may come from a client-supplied filename: keep only a plain alphanumeric token.
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const filename = `${objectId}_${datePart}-${timePart}E.${safeExt}`;
  if (!fs.existsSync(objDir)) fs.mkdirSync(objDir, { recursive: true });
  return { objDir, filename, destPath: path.join(objDir, filename) };
}
