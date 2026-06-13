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
 * ── Dwarf II / Dwarf 3 (Astronomy / SMB path) ──────────────────────────────
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
}

/**
 * Parse a SeeStar filename into structured metadata.
 *
 * Examples:
 *   Stacked_150_M42_10.0s_IRCUT_20241015-210530A.jpg
 *   sub_00001_M42_10.0s_IRCUT_20241015-205200.fit
 *   Stacked_150_M42_10.0s_IRCUT_20241015-210530A_thn.jpg
 *   Lunar_20241015-193000.avi
 */
export function parseFilename(filename: string): ParsedFilename {
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

  // Dwarf II USB rolling stacks. Same compact timestamp as the raw sub-frames
  // below but prefixed stacked-<N>_ (lowercase dash) and no temperature suffix.
  //   stacked-16_Barnard 33_15s60_Duo-Band_20260325-200347458.fits
  //   Pattern: stacked-<N>_<target>_<exp>s<gain>_<mode>_<YYYYMMDD>-<HHMMSS>[mmm].<ext>
  const dwarfRollingStackMatch = filename.match(
    /^stacked-(\d+)_(.+?)_\d+\.?\d*s\d+_[^_]+_(\d{4})(\d{2})(\d{2})-(\d{6})\d*\.(fits?|png|jpe?g)$/i,
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
  const dwarfRawTeleMatch = filename.match(
    /^(?:failed_)?(.+?)_(\d+\.?\d*s\d*)_([A-Za-z0-9-]+)_(\d{4})(\d{2})(\d{2})-(\d{6})\d*_\d+C\.(fits?|jpe?g|png)$/i,
  );
  if (dwarfRawTeleMatch) {
    const [, target, , , y, mo, d, hms] = dwarfRawTeleMatch;
    const ts = `${y}${mo}${d}-${hms}`;
    return {
      type: 'sub',
      target,
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
    const isFits = ext === '.fit' || ext === '.fits';
    return {
      type: ext === '.avi' ? 'video' : isThumbnail ? 'thumbnail' : isFits ? 'sub' : 'other',
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
  const dwarfMatch = filename.match(
    /^(?:(\d{3,4})[-_])?DWARF3?_(.+?)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?(?:_(stacked-\d+|sub|thn))?\.(?:fits?|jpe?g|png|tiff?)$/i,
  );
  if (dwarfMatch) {
    const [, idx, target, y, mo, d, hh, mm, ss, suffix] = dwarfMatch;
    // Numeric prefix (Dwarf 3) or explicit `_sub` suffix (Dwarf II USB, written
    // by dwarfLocalName) both indicate an individual raw exposure.
    const isSub = !!idx || suffix === 'sub';
    // Dwarf has no separate `_thn` variant — the single .jpg per session is
    // the rendered preview, equivalent to SeeStar's main stacked JPG. Classify
    // it as 'stacked' so it shows up alongside the .fits in session views.
    return {
      type: isSub ? 'sub' : 'stacked',
      subIndex: idx ? parseInt(idx) : undefined,
      target: target.replace(/_/g, ' '),
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
  return folderId
    .replace(/[_\s]+(mosai[ck]|mosiac|panel\d*|ha|oiii|sii|sho|hoo|rgb|lrgb|nb|narrowband|broadband|luminance|lum|bicolor|tricolor|hargb|photo|video)\s*\d*$/i, '')
    .replace(/\s+/g, '');
}

/** Strip spaces from a folder name to produce the normalized DB primary key.
 *  "M 16" → "M16", "IC 1318" → "IC1318". Unlike normalizeCatalogId this does
 *  NOT strip variant suffixes, so "M16_Ha" stays "M16_Ha". */
export function normalizeObjectId(folderName: string): string {
  return folderName.replace(/\s+/g, '');
}

export function getFileCategory(name: string): 'image' | 'fits' | 'video' | 'thumbnail' | 'other' {
  const lower = name.toLowerCase();
  if (lower.includes('_thn.')) return 'thumbnail';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')) return 'image';
  if (lower.endsWith('.fit') || lower.endsWith('.fits')) return 'fits';
  if (lower.endsWith('.avi') || lower.endsWith('.mp4')) return 'video';
  return 'other';
}

const REAL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.fit', '.fits', '.avi', '.mp4']);

/**
 * Returns true only for real image/data files.
 * Rejects macOS resource-fork files (._*), hidden files (.*),
 * and anything without a recognized extension.
 */
export function isRealFile(name: string): boolean {
  if (name.startsWith('._') || name.startsWith('.')) return false;
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  return REAL_EXTENSIONS.has(ext);
}
