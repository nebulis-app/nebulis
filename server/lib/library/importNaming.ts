/**
 * Canonical filenames for the folder-import wizard.
 *
 * The library has no per-file session table: getLocalSessions / getLocalFiles
 * decide which session a file belongs to by running parseFilename(name).date
 * through `sessionNightFor` (the observing-night rollover, see
 * telescopeFiles.ts) at read time. A file whose name yields no date (or the
 * wrong date) is either dropped from every session view or grouped under the
 * wrong night.
 *
 * So when the import assigns a file to a session date, the on-disk name must
 * parse + night-roll back to that exact date. Two cases:
 *
 *   1. The original name already parses (post-rollover) to the assigned date
 *      → keep it. This is the common case for SeeStar/Dwarf libraries and
 *      anything the user organized with dated filenames. No rename, no
 *      surprise.
 *
 *   2. It doesn't (a raw "light_001.fits", a folder-dated file, an mtime
 *      guess, or a merge/split override) → rewrite to the simple dated form
 *      parseFilename recognizes: `<stem>_<YYYYMMDD-HHMMSS>.<ext>`. The original
 *      stem is preserved as the leading text so the file is still recognizable.
 *
 *      Two sub-cases, to avoid a subtle double-rollover bug: if the assigned
 *      date is just this file's own natural observing night (no override),
 *      embed the file's TRUE capture date + time — reading it back re-derives
 *      the assigned date via the exact same rollover rule that computed it
 *      here, mirroring how hardware-native SeeStar/Dwarf filenames already
 *      round-trip. If the assigned date is an explicit override (the user
 *      merged/split sessions to a date that isn't this file's natural night),
 *      embed the assigned date directly, with the time clamped into the
 *      rollover-safe zone (see clampToNightSafeTime) — otherwise an unclamped
 *      early-morning time next to an already-resolved date would roll it back
 *      a second time the next time the file is read, silently sliding it to
 *      the wrong day.
 *
 * This mirrors what dwarfLocalName already does for Dwarf rolling stacks, and
 * keeps the read path untouched: an imported library stays self-describing.
 */
import { parseFilename, sessionNightFor, observingNightDate, clampToNightSafeTime } from '../telescopeFiles.js';

/** True when `name` already parses (via parseFilename + the observing-night
 *  rollover) to `date` (YYYY-MM-DD). */
export function parsesToDate(name: string, date: string): boolean {
  return sessionNightFor(parseFilename(name)) === date;
}

// Strip path separators, FS-reserved punctuation, and control characters so a
// rebuilt name can never escape the object folder. Control range is deliberate.
// Exported for reuse anywhere else a user-supplied filename is written to disk
// (e.g. processed-image uploads).
// eslint-disable-next-line no-control-regex
export const ILLEGAL_FS_CHARS = /[/\\<>:"|?*\x00-\x1f]/g;
const TRAILING_STAMP = /_\d{8}-\d{6}[A-Z]?$/;

interface NamePieces {
  stem: string;
  ext: string;
  isThumbnail: boolean;
}

function splitName(originalName: string): NamePieces {
  const isThumbnail = originalName.includes('_thn.');
  const dot = originalName.lastIndexOf('.');
  const rawStem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot).toLowerCase() : '';
  // Sanitize, drop an existing `_thn` marker (re-added below if needed), and
  // strip any trailing date stamp so a re-stamp can't double up.
  let stem = rawStem
    .replace(/_thn$/i, '')
    .replace(ILLEGAL_FS_CHARS, '_')
    .trim();
  stem = stem.replace(TRAILING_STAMP, '');
  if (!stem) stem = 'file';
  return { stem, ext, isThumbnail };
}

/** Add one second to an HHMMSS string, clamped so it never rolls past the day
 *  (235959 stays 235959). Keeping the date fixed keeps the session fixed. */
function bumpSeconds(hms: string): string {
  let n = parseInt(hms, 10);
  if (!Number.isFinite(n)) n = 120000;
  const ss = (n % 100) + 1;
  const mm = Math.floor(n / 100) % 100;
  const hh = Math.floor(n / 10000);
  let totalSec = hh * 3600 + mm * 60 + ss;
  const maxSec = 23 * 3600 + 59 * 60 + 59;
  if (totalSec > maxSec) totalSec = maxSec;
  const nh = Math.floor(totalSec / 3600);
  const nm = Math.floor((totalSec % 3600) / 60);
  const nsec = totalSec % 60;
  return `${String(nh).padStart(2, '0')}${String(nm).padStart(2, '0')}${String(nsec).padStart(2, '0')}`;
}

/**
 * Resolve the on-disk name for an imported file assigned to `finalDate`.
 *
 * `used` holds names already taken in the destination object folder (including
 * files imported earlier in the same run); the returned name is guaranteed not
 * to be in it, and the caller should add it once committed.
 *
 * `trueDate` is the file's own derived capture date (dateDerivation's output,
 * before any rollover) and `time` its HHMMSS time-of-day when known. Passing
 * `null` for either means there's no real capture time to anchor to (e.g. the
 * unsorted bucket assigned a date by hand) — treated as an override.
 */
export function canonicalImportName(
  originalName: string,
  finalDate: string,
  trueDate: string | null,
  time: string | null,
  used: ReadonlySet<string>,
): string {
  // Case 1: the original name already lands in the right session and the slot
  // is free. Leave it exactly as-is.
  if (parsesToDate(originalName, finalDate) && !used.has(originalName)) {
    return originalName;
  }

  // Case 2: build the simple dated form parseFilename understands.
  const { stem, ext, isThumbnail } = splitName(originalName);

  // Is `finalDate` just this file's own natural observing night (the default,
  // no-override case), or did the user explicitly reassign it to some other
  // date? See the module doc comment for why this distinction matters.
  const naturalNight = trueDate ? observingNightDate(trueDate, time) : null;
  const isOverride = naturalNight !== null && naturalNight !== finalDate;

  // Default: embed the TRUE capture date, so re-parsing + re-rolling lands
  // back on finalDate exactly. Override: embed finalDate directly, with the
  // time clamped so it can never roll further on the next read.
  const embedDate = isOverride ? finalDate : (trueDate ?? finalDate);
  const compactDate = embedDate.replace(/-/g, '');
  const thn = isThumbnail ? '_thn' : '';

  let hms = time && /^\d{6}$/.test(time) ? time : '120000';
  if (isOverride) hms = clampToNightSafeTime(hms);
  // First try the natural timestamp, then walk seconds within the day, then
  // fall back to a numeric stem suffix so we always converge on a free name.
  for (let attempt = 0; attempt < 86400; attempt++) {
    const candidate = `${stem}_${compactDate}-${hms}${thn}${ext}`;
    if (!used.has(candidate)) return candidate;
    hms = bumpSeconds(hms);
    // If seconds saturated at end-of-day, break to the counter fallback.
    if (hms === '235959' && attempt > 1) break;
  }
  for (let counter = 2; counter <= 99_999; counter++) {
    const candidate = `${stem}-${counter}_${compactDate}-${hms}${thn}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Cannot find a unique name for "${originalName}" after 99,999 attempts. The destination folder may contain a conflicting file.`);
}
