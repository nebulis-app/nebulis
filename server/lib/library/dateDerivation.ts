/**
 * Session-date derivation for the folder-import wizard.
 *
 * The library re-derives session membership from filenames at read time
 * (see getLocalSessions / getLocalFiles, which call parseFilename(name).date
 * and skip any file that yields no date). So when we import an arbitrary
 * library that does NOT follow SeeStar/Dwarf naming, we have to figure out a
 * session date for each file from whatever signal is available, then make the
 * on-disk filename carry that date (see importNaming.ts) so the read path
 * reproduces it.
 *
 * This module is the single source of that derivation. It is deliberately
 * filesystem-light: a FITS read touches only the header bytes, and everything
 * else is string/stat work, so scanning a few thousand files is cheap enough
 * for a synchronous request.
 *
 * Convention note: this module derives the *calendar date* of the capture
 * timestamp — it does not itself apply any observing-night rollover. Callers
 * that group derived dates into sessions (`summarizeSessions` in
 * folderScan.ts, `resolveTargetDate`/`canonicalImportName` in import.ts /
 * importNaming.ts) run the {date, time} pair through `observingNightDate` (see
 * telescopeFiles.ts) before using it as a session key, so a session that
 * crosses local midnight groups under one date instead of splitting into two
 * — the same rollover the live SMB/USB import path applies via
 * `sessionNightFor`. Keeping the rollover out of this module means the `date`
 * field returned here always answers "what calendar date was this file
 * actually captured on", independent of how it gets bucketed into a session.
 * The review step still lets the user override the computed bucket (an
 * arbitrary merge/split), which is why the date lives in a separate field
 * rather than being baked in here.
 *
 * Filename beats FITS DATE-OBS (see deriveFileDate below) rather than the
 * other way around: DATE-OBS is always UTC (see the note in
 * satelliteTracker.ts), while SeeStar/Dwarf filenames encode the *local*
 * capture time — and the live SMB/USB import path (runImport in import.ts)
 * derives its session date from the filename/session-folder only; it never
 * reads DATE-OBS at all. Trusting FITS first here meant a file with a
 * filename-derived local date could get re-dated (and renamed, per
 * importNaming.ts) to a different UTC calendar date by the folder wizard,
 * which then collides with the same physical capture arriving later via a
 * direct telescope sync — two different on-disk names for one file.
 */
import fs from 'fs';
import { parseFitsHeader } from '../fitsParser.js';
import { parseFilename } from '../telescopeFiles.js';
import { exifDateFromFile } from '../exifDate.js';

/** Where a file's session date came from, in priority order. Drives the
 *  confidence badge in the review UI: 'fits' and 'filename' are both
 *  high-confidence (see confidenceForSource), 'mtime' is a last-resort guess,
 *  'none' means the file lands in the unsorted tray. */
export type DateSource = 'fits' | 'filename' | 'folder' | 'mtime' | 'none';

export interface DerivedDate {
  /** YYYY-MM-DD, or null when no date could be derived (unsorted). */
  date: string | null;
  source: DateSource;
  /** HHMMSS time-of-day when known. Used to build a unique, correctly-ordered
   *  canonical filename and to keep within-session start/end times sensible.
   *  Null when only a date (no time) was available. */
  time: string | null;
}

/** Confidence the UI shows next to a derived session, by source. */
export function confidenceForSource(source: DateSource): 'high' | 'medium' | 'low' | 'none' {
  switch (source) {
    case 'fits': return 'high';
    case 'filename': return 'high';
    case 'folder': return 'medium';
    case 'mtime': return 'low';
    case 'none': return 'none';
  }
}

// FITS headers come in 2880-byte blocks; 28800 covers ten blocks, enough for
// the primary header of any telescope we've seen. Matches the read size used
// in getLocalObservationDetail so behavior is consistent across the codebase.
const FITS_HEADER_BYTES = 28800;

const FITS_EXTENSIONS = new Set(['.fit', '.fits', '.fts']);

/** Pull the date (and time when present) out of a FITS DATE-OBS card.
 *  Handles the two common shapes:
 *    DATE-OBS = '2024-01-15T22:30:45.123'   (combined)
 *    DATE-OBS = '2024-01-15' + TIME-OBS = '22:30:45'   (split)
 *  Returns null when the file isn't FITS or carries no usable date. */
export function deriveFromFits(absPath: string): DerivedDate | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(FITS_HEADER_BYTES);
    const read = fs.readSync(fd, buf, 0, FITS_HEADER_BYTES, 0);
    if (read < 80) return null;
    const header = parseFitsHeader(read === FITS_HEADER_BYTES ? buf : buf.subarray(0, read));
    const values = header.values;

    const rawDate = firstString(values, ['DATE-OBS', 'DATE_OBS', 'DATEOBS', 'DATE']);
    if (!rawDate) return null;

    const isoMatch = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
    if (!isoMatch) return null;
    const [, y, mo, d, hh, mm, ss] = isoMatch;
    const date = `${y}-${mo}-${d}`;

    let time: string | null = hh && mm && ss ? `${hh}${mm}${ss}` : null;
    if (!time) {
      // Split form: a separate time card.
      const rawTime = firstString(values, ['TIME-OBS', 'TIME_OBS', 'UT', 'UT-OBS']);
      const tMatch = rawTime?.match(/(\d{2}):(\d{2}):(\d{2})/);
      if (tMatch) time = `${tMatch[1]}${tMatch[2]}${tMatch[3]}`;
    }
    return { date, source: 'fits', time };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

function firstString(
  values: Record<string, string | number | boolean>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const v = values[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Look for a date embedded in any folder segment of the file's path within
 *  its object (e.g. "M31/2024-01-15/Ha/light_001.fits"). Accepts dashed
 *  (2024-01-15) and compact (20240115) forms. */
export function deriveFromPath(relPath: string): DerivedDate | null {
  const segments = relPath.replace(/\\/g, '/').split('/');
  // Walk leaf-to-root so the most specific (closest) folder wins.
  for (let i = segments.length - 2; i >= 0; i--) {
    const found = matchDateInText(segments[i]);
    if (found) return { date: found, source: 'folder', time: null };
  }
  return null;
}

function matchDateInText(text: string): string | null {
  const dashed = text.match(/(20\d{2}|19\d{2})-(\d{2})-(\d{2})/);
  if (dashed && isPlausibleDate(dashed[1], dashed[2], dashed[3])) {
    return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  }
  const compact = text.match(/(?<!\d)(20\d{2}|19\d{2})(\d{2})(\d{2})(?!\d)/);
  if (compact && isPlausibleDate(compact[1], compact[2], compact[3])) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  return null;
}

function isPlausibleDate(y: string, mo: string, d: string): boolean {
  const month = Number(mo);
  const day = Number(d);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** Local-time date + time from a file's modified timestamp. Always succeeds. */
export function deriveFromMtime(mtime: Date): DerivedDate {
  const y = mtime.getFullYear();
  const mo = String(mtime.getMonth() + 1).padStart(2, '0');
  const d = String(mtime.getDate()).padStart(2, '0');
  const hh = String(mtime.getHours()).padStart(2, '0');
  const mm = String(mtime.getMinutes()).padStart(2, '0');
  const ss = String(mtime.getSeconds()).padStart(2, '0');
  return { date: `${y}-${mo}-${d}`, source: 'mtime', time: `${hh}${mm}${ss}` };
}

export interface DeriveOptions {
  /** Skip the mtime fallback so files with no real date signal land in the
   *  unsorted tray instead of being grouped by a copy timestamp. mtime is a
   *  poor session signal for libraries that were moved/copied between drives,
   *  so the UI lets the user turn it off. Default: true (mtime allowed). */
  useMtimeFallback?: boolean;
}

/**
 * Derive a session date for one file, walking the priority chain:
 *   filename timestamp  →  FITS DATE-OBS  →  date in folder path  →  mtime.
 *
 * Filename comes first (see the module doc comment for why): it already
 * carries the local capture date on any SeeStar/Dwarf file, matching the live
 * import path. FITS DATE-OBS — UTC, per the FITS standard — is only consulted
 * when the filename itself carries no date, e.g. an unmodified NINA/SGP
 * export or a raw "light_001.fits".
 *
 * `relPath` is the path of the file relative to its object folder (used for
 * the folder-name heuristic). `stat` is passed in so callers that already
 * stat'd the file don't pay for a second syscall.
 */
export function deriveFileDate(
  absPath: string,
  relPath: string,
  stat: fs.Stats,
  options: DeriveOptions = {},
): DerivedDate {
  const fileName = relPath.replace(/\\/g, '/').split('/').pop() ?? relPath;
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

  const parsed = parseFilename(fileName);
  if (parsed.date) {
    const time = parsed.timestamp ? parsed.timestamp.slice(9, 15) : null;
    return { date: parsed.date, source: 'filename', time };
  }

  if (FITS_EXTENSIONS.has(ext)) {
    const fromFits = deriveFromFits(absPath);
    if (fromFits) return fromFits;
  }

  const fromPath = deriveFromPath(relPath);
  if (fromPath) return fromPath;

  // Try EXIF DateTimeOriginal for JPEG/PNG files (e.g. Dwarf stacked.jpg
  // preview images that have no date in their filename).
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
    const exifDate = exifDateFromFile(absPath);
    if (exifDate) return { date: exifDate, source: 'filename', time: null };
  }

  if (options.useMtimeFallback !== false) {
    return deriveFromMtime(stat.mtime);
  }

  return { date: null, source: 'none', time: null };
}
