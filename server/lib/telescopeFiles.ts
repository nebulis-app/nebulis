/**
 * File-name parsing for all supported smart telescopes.
 *
 * ── SeeStar S50 / S30 ──────────────────────────────────────────────────────
 * Share root: \\<ip>\EMMC Images\MyWorks\
 * Layout: one folder per target; a companion <target>_sub/ holds raw frames.
 *
 *   M42/
 *     Stacked_150_M42_10.0s_IRCUT_20241015-210530A.jpg   ← stacked preview
 *     Stacked_150_M42_10.0s_IRCUT_20241015-210530A.fit   ← stacked FITS
 *     Stacked_150_M42_10.0s_IRCUT_20241015-210530A_thn.jpg
 *   M42_sub/
 *     sub_00001_M42_10.0s_IRCUT_20241015-205200.fit      ← raw sub-frame
 *
 * ── Dwarf II / Dwarf 3 (Astronomy/, over FTP or a USB mount) ───────────────
 * Each session gets its own date-stamped folder under Astronomy/:
 *
 *   DWARF_ASTRO_NGC_1647_EXP_15_GAIN_60_2026-03-18_20-13-22/
 *     001-DWARF3_NGC_1647_2026-03-18_20-15-22-115.fits   ← raw sub (Dwarf 3)
 *     DWARF3_NGC_1647_2026-03-18_20-15-22-115.fits       ← stack (Dwarf II)
 *     DWARF3_NGC_1647_2026-03-18_20-15-22-115.jpg        ← preview
 *     stacked-16_NGC 1647_...tro_20260318-201525066.fits  ← rolling stack
 *     stacked.jpg / stacked_thumbnail.jpg                 ← preview / thumb
 *     img_reference.png / img_stacked_counter.png        ← internal (skip)
 *     shotsInfo.json                                      ← metadata (skip)
 *
 * ── Dwarf II / Dwarf 3 (RAW TELE / USB path) ───────────────────────────────
 * Raw sub-frames are stored in a separate DWARF_RAW_TELE_* folder using a
 * compact timestamp with milliseconds (no ISO dashes in the date part):
 *
 *   DWARF_RAW_TELE_NGC 1647_EXP_15_GAIN_60_.../
 *     NGC 1647_15s60_Astro_20260318-201554115_26C.fits   ← raw sub-frame
 *     failed_NGC 1647_15s60_Astro_20260318-201539097_26C.fits  ← rejected (skip)
 *
 *   Pattern: <object>_<exp>s<count>_<mode>_<YYYYMMDD>-<HHMMSS>[mmm]_<temp>C.<ext>
 *   <mode> may contain hyphens (e.g. "Duo-Band", "Astro").
 *   The "failed_" prefix marks frames the telescope rejected during stacking;
 *   shouldImportFile() filters them before they reach parseFilename in most paths.
 */
import { getSettingsData } from './telescopes.js';
import { addDaysToDateKey, localDateKey, localParts, zonedDateTimeToUtc } from './timezone.js';

export interface ParsedFilename {
  type: 'stacked' | 'sub' | 'thumbnail' | 'video' | 'other';
  frameCount?: number;
  subIndex?: number;
  target: string;
  exposure?: string;
  filter?: string;
  timestamp?: string;   // YYYYMMDD-HHMMSS
  date?: string;         // YYYY-MM-DD
  suffix?: string;       // e.g. 'A'
  extension: string;
  isThumbnail: boolean;
  /** Set when the name matched a sub-frame pattern but the extension is not
   *  FITS: this is a device's per-frame preview. `type` reads 'thumbnail',
   *  which is what it is, but the import filter still needs to recognise it as
   *  frame-shaped so it can refuse one preview per sub-frame. */
  framePreview?: boolean;
}

/** A sub-frame is a raw exposure, and every device writes those as FITS. */
export const FITS_EXTENSIONS = new Set(['.fit', '.fits', '.fts']);

/**
 * Parse a SeeStar filename into structured metadata.
 *
 * Examples:
 *   Stacked_150_M42_10.0s_IRCUT_20241015-210530A.jpg
 *   sub_00001_M42_10.0s_IRCUT_20241015-205200.fit
 *   Stacked_150_M42_10.0s_IRCUT_20241015-210530A_thn.jpg
 *   Lunar_20241015-193000.avi
 *
 * Several of the sub-frame patterns below match a device's per-frame *preview*
 * as readily as the frame itself, because the two share a stem and differ only
 * by extension. Dwarf is the clearest case: a RAW_TELE session folder holds
 *
 *   IC 1396_60s60_Duo-Band_20260704-235645742_34C.fits    (16 MB, the frame)
 *   Thumbnail/IC 1396_60s60_Duo-Band_20260704-235645742_34C.jpg   (45 KB)
 *
 * and only the directory tells them apart, which this function never sees.
 * So the rule is enforced once, on the way out: a sub-frame is FITS. Anything
 * else that matched a sub-frame pattern is that frame's preview and is
 * reclassified as a thumbnail, which is what it is.
 */
export function parseFilename(filename: string): ParsedFilename {
  const parsed = parseFilenameFormat(filename);
  if (parsed.type === 'sub' && !FITS_EXTENSIONS.has(parsed.extension)) {
    // subIndex is dropped with it: an index only means something for a frame
    // in the capture sequence, and keeping it would let a preview sort itself
    // in among the real ones.
    return { ...parsed, type: 'thumbnail', isThumbnail: true, subIndex: undefined, framePreview: true };
  }
  return parsed;
}

/** Pattern matching only. Call `parseFilename`, which applies the rules that
 *  hold regardless of which pattern a name happened to match. */
function parseFilenameFormat(filename: string): ParsedFilename {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  const isThumbnail = filename.includes('_thn.') || /thumbnail/i.test(filename);

  // Exposure tokens may be seconds (`10.0s`) or milliseconds (`1.0ms` for
  // bright solar/lunar captures).
  const exposurePattern = String.raw`\d+(?:\.\d+)?m?s`;

  // Try stacked pattern: Stacked_<count>_<target>_<exposure>_<filter>_<timestamp><suffix>
  const stackedMatch = filename.match(
    new RegExp(`^Stacked_(\\d+)_(.+?)_(${exposurePattern})_([A-Z0-9]+)_(\\d{8}-\\d{6})([A-Z])?(?:_thn)?\\.`, 'i')
  );
  if (stackedMatch) {
    const ts = stackedMatch[5];
    return {
      type: isThumbnail ? 'thumbnail' : 'stacked',
      frameCount: parseInt(stackedMatch[1]),
      target: stackedMatch[2],
      exposure: stackedMatch[3],
      filter: stackedMatch[4],
      timestamp: ts,
      date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
      suffix: stackedMatch[6] || undefined,
      extension: ext,
      isThumbnail,
    };
  }

  // DSO_Stacked variant: same structure as Stacked_* but with a `DSO_` prefix
  // and an underscore (not dash) between the YYYYMMDD date and HHMMSS time.
  // An optional mode token (e.g. "mosaic") may appear between target and exposure.
  //   DSO_Stacked_1318_M 81_30.0s_20250323_060820.jpg
  //   DSO_Stacked_1387_IC 5070_mosaic_20.0s_20250715_133040.jpg
  const dsoStackedMatch = filename.match(
    new RegExp(`^DSO_Stacked_(\\d+)_(.+?)_(${exposurePattern})_(\\d{8})_(\\d{6})(?:_thn)?\\.`, 'i')
  );
  if (dsoStackedMatch) {
    const [, countStr, target, exposure, datePart, timePart] = dsoStackedMatch;
    return {
      type: isThumbnail ? 'thumbnail' : 'stacked',
      frameCount: parseInt(countStr),
      target,
      exposure,
      timestamp: `${datePart}-${timePart}`,
      date: `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`,
      extension: ext,
      isThumbnail,
    };
  }

  // macOS Finder appends " copy" or " copy N" when duplicating a file.
  // Strip it before pattern matching so copies are still recognised.
  const withoutCopySuffix = filename.replace(/ copy(?: \d+)?(\.[^.]+)$/, '$1');

  // Try sub-frame pattern: sub_<index>_<target>_<exposure>_<filter>_<timestamp>
  const subMatch = withoutCopySuffix.match(
    new RegExp(`^sub_(\\d+)_(.+?)_(${exposurePattern})_([A-Z0-9]+)_(\\d{8}-\\d{6})\\.`, 'i')
  );
  if (subMatch) {
    const ts = subMatch[5];
    return {
      type: 'sub',
      subIndex: parseInt(subMatch[1]),
      target: subMatch[2],
      exposure: subMatch[3],
      filter: subMatch[4],
      timestamp: ts,
      date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
      extension: ext,
      isThumbnail: false,
    };
  }

  // ZWO ASIAIR frames. BEST-EFFORT, UNVERIFIED — built from ZWO's transfer
  // guide and community tooling, not from a device (see walkers/asiairWalker.ts).
  //   Light_M42_10.0s_Bin1_S_gain360_20240320-203324_-10.0C_0001.fit
  //   Light_M42_240.0s_Bin1_ISO1600_20230212-195555_0001.FIT   (no temperature, ISO gain)
  //   Dark_60s_Bin1_20250723-13073265_0018.fit                  (no target, no filter/gain)
  //   Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit
  //
  // `_Bin<n>_` is the discriminator: no SeeStar or Dwarf name carries it, and
  // every ASIAIR name does. Everything else is optional because firmware
  // versions differ in which fields they emit, so the pattern locates the
  // timestamp positionally rather than demanding a full field list. This sits
  // ahead of the SeeStar Light_* rule below: that rule cannot currently match
  // an ASIAIR name (it requires the timestamp to end the stem, and ASIAIR
  // appends temperature and a sequence number), but the two share a prefix and
  // ordering them explicitly keeps a later widening of either one honest.
  //
  // The middle chunk between Bin and the timestamp holds the filter and the
  // gain in either order-of-presence, so it is captured whole and split below
  // rather than guessed at with alternation.
  const asiairMatch = withoutCopySuffix.match(
    /^(Light|Dark|Flat|Bias)_(?:(.+?)_)?(\d+(?:\.\d+)?m?s)_Bin\d+((?:_[A-Za-z0-9+-]+)*?)_(\d{8})-(\d{6})\d*(?:_[^_]*C)?(?:_(\d+))?\.[^.]+$/i,
  );
  if (asiairMatch) {
    const [, frameType, target, exposure, middle, datePart, timePart, seq] = asiairMatch;
    // gain360 / ISO1600 are the exposure settings, not a filter. Whatever else
    // sits in there is the filter name (L, R, G, B, Ha, S, O, Duo-Band...).
    const filter = middle
      .split('_')
      .filter(Boolean)
      .find(token => !/^(?:gain\d+|ISO\d+)$/i.test(token));
    return {
      type: 'sub',
      // ASIAIR writes calibration frames with no target token. They are
      // archived rather than imported (see import.ts's calibration pass), so
      // naming them after the frame type is only ever a display fallback.
      target: target ?? frameType,
      subIndex: seq ? parseInt(seq, 10) : undefined,
      exposure,
      filter,
      timestamp: `${datePart}-${timePart}`,
      date: `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`,
      extension: ext,
      isThumbnail: false,
    };
  }

  // Try Light-frame pattern: Light_<id>_<exposure>_<filter>_<timestamp>
  // e.g. Light_10P_10.0s_IRCUT_20260407-043257.fit
  // Target is lazy (.+?) not \w+ because real object names carry spaces
  // ("M 16", "C 30"). With \w+ those names fell through to the generic
  // pattern and a Light_*.jpg was misclassified 'other' instead of 'sub'.
  const lightMatch = withoutCopySuffix.match(
    new RegExp(`^Light_(.+?)_(${exposurePattern})_([A-Z0-9]+)_(\\d{8}-\\d{6})\\.`, 'i')
  );
  if (lightMatch) {
    const ts = lightMatch[4];
    return {
      type: 'sub',
      target: lightMatch[1],
      exposure: lightMatch[2],
      filter: lightMatch[3],
      timestamp: ts,
      date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
      extension: ext,
      isThumbnail: false,
    };
  }

  // Solar/lunar photo export pattern:
  //   2025-10-02-202949-Solar.jpg
  //   2025-10-02-202949-Lunar.jpg
  const dateFirstMatch = filename.match(
    /^(\d{4})-(\d{2})-(\d{2})-(\d{6})-(.+?)\.(?:jpe?g|png|tiff?|fits?)$/i
  );
  if (dateFirstMatch) {
    const [, y, mo, d, hms, target] = dateFirstMatch;
    return {
      type: 'stacked',
      target,
      timestamp: `${y}${mo}${d}-${hms}`,
      date: `${y}-${mo}-${d}`,
      extension: ext,
      isThumbnail,
    };
  }

  // Solar/lunar/planetary video export pattern — same date-first shape as the
  // photo export above, with an optional `-timelapse` marker and a video
  // extension. SeeStar writes these into a `<target>_video` folder:
  //   2026-08-27-202843-Lunar-timelapse.mp4
  //   2026-08-27-202843-Solar.mp4
  // Without this branch the name reaches the fallback below undated, and an
  // undated file attaches to no observation (see getLocalObservations). The
  // `-timelapse` suffix is stripped from the target so it groups with the
  // object's stills; the file itself is never renamed.
  const dateFirstVideoMatch = filename.match(
    /^(\d{4})-(\d{2})-(\d{2})-(\d{6})-(.+?)(-timelapse)?\.(?:mp4|mov|avi)$/i
  );
  if (dateFirstVideoMatch) {
    const [, y, mo, d, hms, target] = dateFirstVideoMatch;
    return {
      type: 'video',
      target,
      timestamp: `${y}${mo}${d}-${hms}`,
      date: `${y}-${mo}-${d}`,
      extension: ext,
      isThumbnail: false,
    };
  }

  // Dwarf II USB rolling stacks. Same compact timestamp as the raw sub-frames
  // below but prefixed stacked-<N>_ (lowercase dash) and no temperature suffix.
  //   stacked-16_Barnard 33_15s60_Duo-Band_20260325-200347458.fits
  //   Pattern: stacked-<N>_<target>_<exp>s<gain>_<mode>_<YYYYMMDD>-<HHMMSS>[mmm].<ext>
  //
  // The exposure token uses the same (?:\.\d+)? shape as exposurePattern above
  // (not a bare \d+\.?\d* — that leaves \.? and \d* both optional and adjacent
  // over the same digit class, which a crafted filename can use for polynomial
  // backtracking) rather than reusing exposurePattern itself, since Dwarf's
  // format has no SeeStar-style `ms` unit to allow for.
  const dwarfRollingStackMatch = filename.match(
    /^stacked-(\d+)_(.+?)_\d+(?:\.\d+)?s\d+_[^_]+_(\d{4})(\d{2})(\d{2})-(\d{6})\d*\.(fits?|png|jpe?g)$/i,
  );
  if (dwarfRollingStackMatch) {
    const [, , target, y, mo, d, hms] = dwarfRollingStackMatch;
    return {
      type: 'stacked',
      target,
      timestamp: `${y}${mo}${d}-${hms}`,
      date: `${y}-${mo}-${d}`,
      extension: ext,
      isThumbnail: false,
    };
  }

  // Dwarf RAW TELE / USB raw sub-frames. These live in DWARF_RAW_TELE_* folders
  // and use a compact timestamp with optional milliseconds appended (no ISO dashes
  // in the date/time portion, unlike the Astronomy-path Dwarf format above).
  //
  //   NGC 1647_15s60_Astro_20260318-201554115_26C.fits
  //   Pattern: <object>_<exp>s<count>_<mode>_<YYYYMMDD>-<HHMMSS>[mmm]_<temp>C.<ext>
  //
  // "failed_" prefixed variants are identical in structure but are rejected frames;
  // shouldImportFile() drops them before import so they are rarely parsed.
  // Same (?:\.\d+)? shape as the rolling-stack pattern above, for the same
  // reason: \d+\.?\d*s\d* left two independently-optional digit runs adjacent
  // to each other, which is the classic shape a static analyzer (and a
  // crafted filename) can turn into polynomial-time backtracking.
  const dwarfRawTeleMatch = filename.match(
    /^(?:failed_)?(.+?)_(\d+(?:\.\d+)?s\d*)_([A-Za-z0-9-]+)_(\d{4})(\d{2})(\d{2})-(\d{6})\d*_\d+C\.(fits?|jpe?g|png)$/i,
  );
  if (dwarfRawTeleMatch) {
    const [, target, , mode, y, mo, d, hms] = dwarfRawTeleMatch;
    const ts = `${y}${mo}${d}-${hms}`;
    return {
      type: 'sub',
      target,
      filter: mode || undefined,
      timestamp: ts,
      date: `${y}-${mo}-${d}`,
      extension: ext,
      isThumbnail: false,
    };
  }

  // Try simple pattern with timestamp: <Name>_<YYYYMMDD>[- _]<HHMMSS>
  // Accepts both dash (SeeStar: 20241015-210530) and underscore (DSO exports:
  // 20250323_060820) as the separator between date and time portions.
  const simpleMatch = filename.match(/^(.+?)_(\d{8})[-_](\d{6})([A-Z])?(?:_thn)?\./i);
  if (simpleMatch) {
    const [, target, datePart, timePart, suffix] = simpleMatch;
    const ts = `${datePart}-${timePart}`;
    // Any unrecognized .fit/.fits file is a raw sub-frame — stacked FITS always
    // start with "Stacked_" and are caught above, so anything reaching here is a
    // raw individual exposure from older firmware or non-standard naming.
    const isFits = ext === '.fit' || ext === '.fits' || ext === '.fts';
    const isVideo = ext === '.avi' || ext === '.mp4' || ext === '.mov';
    return {
      type: isVideo ? 'video' : isThumbnail ? 'thumbnail' : isFits ? 'sub' : 'other',
      target,
      timestamp: ts,
      date: `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`,
      suffix: suffix || undefined,
      extension: ext,
      isThumbnail,
    };
  }

  // Dwarf naming. Dwarf splits the timestamp with dashes between Y-M-D and
  // H-M-S and adds an optional millisecond tail — different shape from the
  // SeeStar `YYYYMMDD-HHMMSS` token, so the simple regex above misses these.
  //
  //   001-DWARF3_M31_2026-05-13_22-15-08-421.fits   ← subframe
  //   DWARF3_M31_2026-05-13_22-15-08-421.jpg        ← preview
  //   DWARF3_M31_2026-05-13_22-15-08-421.fits       ← stack (Dwarf II)
  //
  // The numbered prefix marks a subframe. Targets may contain underscores
  // (e.g. NGC_7000); we restore them to spaces for display, matching how the
  // session-folder target is decoded in dwarfWalker.
  // The trailing `(?:_stacked-\d+)?` lets us absorb the only known suffix the
  // import pipeline bakes into rolling-stack filenames
  // (`DWARF3_<target>_<ts>_stacked-NNNN.fits`, see `dwarfLocalName` in
  // server/lib/library/import.ts). Audit 1.32: the previous wildcard
  // `(?:_[^.]+?)?` accepted arbitrary content between the timestamp and the
  // extension, so a hand-renamed `..._foo.fits` would parse as the same logical
  // file as the original and clobber it during re-import. Tightened to the
  // known suffix list — currently just `stacked-\d+`.
  // Two suffix alternatives:
  //   1. _<mode>_sub  — Dwarf II USB sub-frames renamed by dwarfLocalName; mode
  //      is preserved so the filter can be recovered (e.g. _Duo-Band_sub).
  //   2. _stacked-N | _sub | _thn  — bare suffix, no mode.
  // Splitting into two alternatives (rather than making mode optional before a
  // shared suffix group) prevents arbitrary user-renames like _userrename from
  // being swallowed as mode tokens (audit 1.32 guard preserved).
  const dwarfMatch = filename.match(
    /^(?:(\d{3,4})[-_])?DWARF3?_(.+?)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?(?:_([A-Za-z][A-Za-z0-9-]*)_(sub)|_(stacked-\d+|sub|thn))?\.(?:fits?|jpe?g|png|tiff?)$/i,
  );
  if (dwarfMatch) {
    const [, idx, target, y, mo, d, hh, mm, ss, mode, subWithMode, suffix] = dwarfMatch;
    // Numeric prefix (Dwarf 3) or explicit `_sub` suffix (Dwarf II USB, written
    // by dwarfLocalName) both indicate an individual raw exposure.
    const isSub = !!idx || !!subWithMode || suffix?.toLowerCase() === 'sub';
    // Dwarf has no separate `_thn` variant — the single .jpg per session is
    // the rendered preview, equivalent to SeeStar's main stacked JPG. Classify
    // it as 'stacked' so it shows up alongside the .fits in session views.
    return {
      type: isSub ? 'sub' : 'stacked',
      subIndex: idx ? parseInt(idx) : undefined,
      target: target.replace(/_/g, ' '),
      filter: mode || undefined,
      timestamp: `${y}${mo}${d}-${hh}${mm}${ss}`,
      date: `${y}-${mo}-${d}`,
      extension: ext,
      isThumbnail: false,
    };
  }

  // Right-anchored date extraction: find _YYYYMMDD[_-]HHMMSS anywhere near the
  // end of the filename. Changes to the prefix never affect this — the date is
  // always at a fixed distance from the extension.
  const rightAnchorMatch = filename.match(/_(\d{8})[-_](\d{6})(?:_thn)?\.[^.]+$/i);
  if (rightAnchorMatch) {
    const [, datePart, timePart] = rightAnchorMatch;
    return {
      type: isThumbnail ? 'thumbnail' : 'other',
      target: filename.substring(0, filename.lastIndexOf('.')),
      timestamp: `${datePart}-${timePart}`,
      date: `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`,
      extension: ext,
      isThumbnail,
    };
  }

  return {
    type: 'other',
    target: filename,
    extension: ext,
    isThumbnail,
  };
}

/**
 * Extract a session key from a parsed filename.
 * Sessions are grouped by date (YYYY-MM-DD) since the SeeStar
 * doesn't create subdirectories per session.
 */
export function getSessionKey(parsed: ParsedFilename): string {
  return parsed.date || 'unknown';
}

/**
 * Hour (local, 0-23) before which a capture still belongs to the previous
 * night's observing session. Matches the planner's rollover (see
 * `plannerToday` in src/lib/nightWindow.ts) so a session's calendar date and
 * the planner's "tonight" agree, and low enough that a midwinter session
 * running until a late dawn isn't yanked to the next night mid-capture. Keep
 * in sync with nightWindow.ts, NightDate.swift, and server/routes/planner.ts.
 */
export const OBSERVING_NIGHT_ROLLOVER_HOUR = 7;

/**
 * The observing-night date key (`YYYY-MM-DD`, site-local) that `now` belongs to.
 * Before the rollover hour a caller is still mid-session on the night that began
 * the previous evening, so the key rolls back one day. Single home for the rule
 * shared by the forecast hero, the nightly planner prefetch, and the planner
 * route's "tonight" anchor.
 */
export function observingNightDateKey(now: Date, timeZone?: string | null): string {
  const parts = localParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  return parts.hour >= OBSERVING_NIGHT_ROLLOVER_HOUR ? today : addDaysToDateKey(today, -1);
}

/**
 * Local-noon UTC instant of the observing night `now` belongs to. Noon is a
 * safe anchor for downstream dark-window math: it is never near a DST boundary
 * and always lands on the intended calendar day.
 */
export function observingNightAnchor(now: Date, timeZone?: string | null): Date {
  return zonedDateTimeToUtc(observingNightDateKey(now, timeZone), { hour: 12 }, timeZone);
}

/**
 * Whether the observing-night rollover is turned on (Settings > General >
 * "Group sessions by observing night"). This is the single gate every
 * caller — direct or via sessionNightFor/clampToNightSafeTime — inherits
 * automatically, so no call site needs to know about the setting itself.
 * Defaults true (fails open) if the settings row can't be read for any
 * reason, matching the DB column's own default.
 */
function groupingEnabled(): boolean {
  try {
    return getSettingsData().groupObservingNights !== false;
  } catch {
    return true;
  }
}

/**
 * Roll a capture's calendar date back one day when its time-of-day falls
 * before the observing-night rollover hour, so a session that runs past
 * local midnight (e.g. 11pm-1am) groups under one date instead of splitting
 * across two. `hms` is an HHMMSS string; when it's absent (date-only
 * sources — a folder-name hint, a FITS DATE-OBS with no time card) there's no
 * time to test, so `date` is returned unchanged. Returns `date` unchanged
 * outright when the user has turned grouping off in Settings.
 */
export function observingNightDate(date: string, hms: string | null | undefined): string {
  if (!groupingEnabled()) return date;
  return rolloverDateUnconditional(date, hms);
}

/**
 * The rollover math itself, with no Settings check — always rolls back
 * regardless of whether grouping is currently turned on. Exists only so the
 * stale-session reconciliation (see reconcileStaleSessionDates in
 * observations.ts) can recognize a row written under the *other* convention
 * from whichever one is active now (e.g. a night-rolled row left behind after
 * the user turns grouping off, or a raw-date row left behind from before the
 * rollover existed at all) and merge it forward. Every other caller should
 * use observingNightDate, which respects the toggle.
 */
export function rolloverDateUnconditional(date: string, hms: string | null | undefined): string {
  if (!hms || hms.length < 2) return date;
  const hour = parseInt(hms.slice(0, 2), 10);
  if (!Number.isFinite(hour) || hour >= OBSERVING_NIGHT_ROLLOVER_HOUR) return date;
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  // UTC-anchored arithmetic so day rollover (and month/year rollover) is
  // handled by Date itself rather than hand-rolled calendar math; the date
  // is a plain calendar string, not an instant, so UTC vs local doesn't matter.
  const prev = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Session-grouping date for a parsed filename: the observing night the
 * capture belongs to, rather than its raw calendar date. Use this (not
 * `parsed.date`) everywhere session membership is decided, so a session that
 * crosses local midnight doesn't split into two. Returns null when no date
 * could be parsed at all.
 */
export function sessionNightFor(parsed: ParsedFilename): string | null {
  if (!parsed.date) return null;
  const hms = parsed.timestamp ? parsed.timestamp.slice(-6) : null;
  return observingNightDate(parsed.date, hms);
}

/**
 * Clamp an HHMMSS time-of-day into the rollover-safe zone (>= the rollover
 * hour) so it can never trigger `observingNightDate` when paired with an
 * explicitly-chosen calendar date. Needed anywhere a date is assigned
 * out-of-band from the real capture time (a folder-import merge override, a
 * manually-entered observation, a processed-image save) — embedding that
 * date next to an unmodified early-morning time would roll it back a second
 * time the next time the file is read. Only the hour is touched; minutes and
 * seconds are preserved for ordering/uniqueness. No-op when grouping is off
 * in Settings, since nothing rolls over in that mode anyway.
 */
export function clampToNightSafeTime(hms: string): string {
  if (!groupingEnabled()) return hms;
  const hour = parseInt(hms.slice(0, 2), 10);
  if (Number.isFinite(hour) && hour < OBSERVING_NIGHT_ROLLOVER_HOUR) {
    return `${String(OBSERVING_NIGHT_ROLLOVER_HOUR).padStart(2, '0')}${hms.slice(2)}`;
  }
  return hms;
}

/**
 * Determine if a folder name is an object folder (not _sub, Samples, etc.)
 */
export function isObjectFolder(name: string): boolean {
  if (name === '.' || name === '..') return false;
  if (name === 'Samples') return false;
  if (name.endsWith('_sub') || name.endsWith('_subs')) return false;
  if (name.startsWith('.')) return false;
  return true;
}

/**
 * Determine if a folder is a sub-frames companion folder.
 */
export function isSubFolder(name: string): boolean {
  return name.endsWith('_sub') || name.endsWith('_subs');
}

/**
 * Get the base object name from a sub folder name.
 * "M42_sub" -> "M42", "IC 1318_subs" -> "IC 1318"
 */
export function getObjectFromSubFolder(subFolderName: string): string {
  return subFolderName.replace(/_(sub|subs)$/, '');
}

/**
 * Normalize a catalog ID for lookup.
 * - Strips common astrophotography suffixes (Mosaic, Ha, OIII, panel, etc.)
 *   so "M31_Mosiac" and "M31_Ha" both resolve to "M31".
 * - Strips Seestar capture-mode suffixes (_photo, _video) so "lunar_photo"
 *   and "lunar_video" both resolve to "lunar".
 * - Removes spaces: "IC 1318" -> "IC1318", "M 42" -> "M42"
 */
export function normalizeCatalogId(folderId: string): string {
  // `panel` (not `panel\d*`) — the trailing `\s*\d*$` already strips any
  // number after any suffix word, including "panel". Keeping a second,
  // independently-optional \d* directly on "panel" as well made the two
  // adjacent \d* groups ambiguous over the same digits (e.g. "panel12" can
  // split as panel+"12"+"" or panel+"1"+"2"), which is the shape a crafted
  // folder name can turn into polynomial-time backtracking.
  return folderId
    .replace(/[_\s]+(mosai[ck]|mosiac|panel|ha|oiii|sii|sho|hoo|rgb|lrgb|nb|narrowband|broadband|luminance|lum|bicolor|tricolor|hargb|photo|video)\s*\d*$/i, '')
    .replace(/\s+/g, '');
}

/** Strip spaces from a folder name to produce the normalized DB primary key.
 *  "M 16" → "M16", "IC 1318" → "IC1318". Unlike normalizeCatalogId this does
 *  NOT strip variant suffixes, so "M16_Ha" stays "M16_Ha". */
export function normalizeObjectId(folderName: string): string {
  return folderName.replace(/\s+/g, '');
}

export const FILE_CATEGORIES = ['image', 'fits', 'video', 'thumbnail', 'other'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export function getFileCategory(name: string): FileCategory {
  const lower = name.toLowerCase();
  if (lower.includes('_thn.')) return 'thumbnail';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image';
  if (lower.endsWith('.fit') || lower.endsWith('.fits') || lower.endsWith('.fts')) return 'fits';
  if (lower.endsWith('.avi') || lower.endsWith('.mp4') || lower.endsWith('.mov')) return 'video';
  return 'other';
}

const REAL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.fit', '.fits', '.fts', '.avi', '.mp4', '.mov']);

// Single source of truth for extension -> Content-Type. Previously duplicated
// (and drifted — one copy missed .fts, another missed .fts and .mov) across
// routes/library.ts, routes/telescope.ts, and lib/library/dwarfRestack.ts.
const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.fit': 'application/fits', '.fits': 'application/fits', '.fts': 'application/fits',
  '.xisf': 'application/x-xisf',
  '.avi': 'video/x-msvideo', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

/** Takes either a bare filename or an extension-with-dot (e.g. from
 *  path.extname) — both resolve the same way since the lookup is keyed on
 *  whatever follows the last '.'. */
export function mimeTypeForExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Returns true only for real image/data files.
 * Rejects macOS resource-fork files (._*), hidden files (.*),
 * and anything without a recognized extension.
 */
export function isRealFile(name: string): boolean {
  if (isHiddenOrSystemFile(name)) return false;
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  return REAL_EXTENSIONS.has(ext);
}

/**
 * OS bookkeeping rather than anything the user captured: macOS AppleDouble
 * sidecars (`._foo`), `.DS_Store`, `Thumbs.db`, and any dot-prefixed file.
 *
 * Split out of `isRealFile` because archive mode needs the two halves
 * separately. "Unrecognized extension" is a file the user may well want kept;
 * "OS junk" never is, and copying it into an archive would be noise.
 */
export function isHiddenOrSystemFile(name: string): boolean {
  if (name.startsWith('.')) return true;
  return name.toLowerCase() === 'thumbs.db';
}

/**
 * Companion files that describe a capture without being one.
 *
 * Deliberately a SEPARATE predicate from `isRealFile` rather than an addition
 * to `REAL_EXTENSIONS`. `isRealFile` has ~50 call sites and gates the gallery,
 * thumbnail generation, session file counts, and the ZIP export; widening it
 * would surface metadata as broken images throughout the app. Keeping the two
 * apart means a sidecar is stored and downloadable but is automatically absent
 * from every image query, with no extra filtering anywhere.
 *
 * The Dwarf's `shotsInfo.json` is the motivating case: exposure, gain, filter,
 * target coordinates, and frame counts, all previously discarded because the
 * importer only accepted image extensions.
 */
const SIDECAR_EXTENSIONS = new Set(['.json', '.txt']);

export function isSidecarFile(name: string): boolean {
  if (name.startsWith('._') || name.startsWith('.')) return false;
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  return SIDECAR_EXTENSIONS.has(ext);
}
