import { describe, it, expect, afterEach } from 'vitest';
import {
  parseFilename,
  getSessionKey,
  isObjectFolder,
  isSubFolder,
  getObjectFromSubFolder,
  normalizeCatalogId,
  getFileCategory,
  isRealFile,
  observingNightDate,
  sessionNightFor,
  clampToNightSafeTime,
} from '../../server/lib/telescopeFiles';
import { updateSettingsData } from '../../server/lib/telescopes';

// ─── parseFilename ──────────────────────────────────────────────

describe('parseFilename', () => {
  describe('stacked images', () => {
    it('parses a standard stacked JPG', () => {
      const result = parseFilename('Stacked_150_M42_10.0s_IRCUT_20241015-210530A.jpg');
      expect(result.type).toBe('stacked');
      expect(result.frameCount).toBe(150);
      expect(result.target).toBe('M42');
      expect(result.exposure).toBe('10.0s');
      expect(result.filter).toBe('IRCUT');
      expect(result.timestamp).toBe('20241015-210530');
      expect(result.date).toBe('2024-10-15');
      expect(result.suffix).toBe('A');
      expect(result.extension).toBe('.jpg');
      expect(result.isThumbnail).toBe(false);
    });

    it('parses a stacked FITS file', () => {
      const result = parseFilename('Stacked_150_M42_10.0s_IRCUT_20241015-210530A.fit');
      expect(result.type).toBe('stacked');
      expect(result.extension).toBe('.fit');
    });

    it('parses stacked with no suffix letter', () => {
      const result = parseFilename('Stacked_50_NGC7000_15s_LP_20240820-220100.jpg');
      expect(result.type).toBe('stacked');
      expect(result.frameCount).toBe(50);
      expect(result.target).toBe('NGC7000');
      expect(result.exposure).toBe('15s');
      expect(result.filter).toBe('LP');
      expect(result.suffix).toBeUndefined();
    });

    it('identifies thumbnail variants', () => {
      const result = parseFilename('Stacked_150_M42_10.0s_IRCUT_20241015-210530A_thn.jpg');
      expect(result.type).toBe('thumbnail');
      expect(result.isThumbnail).toBe(true);
      expect(result.target).toBe('M42');
    });

    it('should parse target name with spaces from stacked filename', () => {
      const result = parseFilename('Stacked_80_IC 1318_10.0s_IRCUT_20240901-213000A.jpg');
      expect(result.type).toBe('stacked');
      expect(result.target).toBe('IC 1318');
    });

    it('parses solar and lunar photo stacks with millisecond exposures', () => {
      const solar = parseFilename('Stacked_12_solar_photo_1.0ms_SOLAR_20260520-120000.jpg');
      expect(solar.type).toBe('stacked');
      expect(solar.target).toBe('solar_photo');
      expect(solar.exposure).toBe('1.0ms');
      expect(solar.date).toBe('2026-05-20');

      const lunar = parseFilename('Stacked_20_lunar_photo_5ms_IRCUT_20260521-210000.jpg');
      expect(lunar.type).toBe('stacked');
      expect(lunar.target).toBe('lunar_photo');
      expect(lunar.exposure).toBe('5ms');
      expect(lunar.date).toBe('2026-05-21');
    });

    it('parses date-first solar photo exports', () => {
      const result = parseFilename('2025-10-02-202949-Solar.jpg');
      expect(result.type).toBe('stacked');
      expect(result.target).toBe('Solar');
      expect(result.timestamp).toBe('20251002-202949');
      expect(result.date).toBe('2025-10-02');
    });

    it('parses DSO_Stacked filename without mode field', () => {
      const result = parseFilename('DSO_Stacked_1318_M 81_30.0s_20250323_060820.jpg');
      expect(result.type).toBe('stacked');
      expect(result.frameCount).toBe(1318);
      expect(result.target).toBe('M 81');
      expect(result.exposure).toBe('30.0s');
      expect(result.date).toBe('2025-03-23');
      expect(result.timestamp).toBe('20250323-060820');
    });

    it('parses DSO_Stacked filename with mode field between target and exposure', () => {
      const result = parseFilename('DSO_Stacked_1387_IC 5070_mosaic_20.0s_20250715_133040.jpg');
      expect(result.type).toBe('stacked');
      expect(result.frameCount).toBe(1387);
      expect(result.exposure).toBe('20.0s');
      expect(result.date).toBe('2025-07-15');
      expect(result.timestamp).toBe('20250715-133040');
    });
  });

  describe('sub-frames', () => {
    it('parses a standard sub-frame FITS', () => {
      const result = parseFilename('sub_00001_M42_10.0s_IRCUT_20241015-205200.fit');
      expect(result.type).toBe('sub');
      expect(result.subIndex).toBe(1);
      expect(result.target).toBe('M42');
      expect(result.exposure).toBe('10.0s');
      expect(result.filter).toBe('IRCUT');
      expect(result.date).toBe('2024-10-15');
    });

    it('parses high sub-frame index', () => {
      const result = parseFilename('sub_00500_M31_10.0s_IRCUT_20241201-190000.fit');
      expect(result.subIndex).toBe(500);
    });

    it('parses sub-frame JPG companion', () => {
      const result = parseFilename('sub_00001_M42_10.0s_IRCUT_20241015-205200.jpg');
      expect(result.type).toBe('sub');
      expect(result.extension).toBe('.jpg');
    });
  });

  describe('simple filenames with timestamps', () => {
    it('parses lunar video', () => {
      const result = parseFilename('Lunar_20241015-193000.avi');
      expect(result.type).toBe('video');
      expect(result.target).toBe('Lunar');
      expect(result.date).toBe('2024-10-15');
      expect(result.extension).toBe('.avi');
    });

    it('parses simple image with timestamp', () => {
      const result = parseFilename('Albireo_20240927-204808A.jpg');
      expect(result.type).toBe('other');
      expect(result.target).toBe('Albireo');
      expect(result.suffix).toBe('A');
    });
  });

  describe('unrecognized filenames', () => {
    it('should return type other when filename matches no known pattern', () => {
      const result = parseFilename('readme.txt');
      expect(result.type).toBe('other');
      expect(result.target).toBe('readme.txt');
      expect(result.extension).toBe('.txt');
      expect(result.isThumbnail).toBe(false);
    });

    it('should parse minimal filename without crashing', () => {
      const result = parseFilename('a.fit');
      expect(result.type).toBe('other');
      expect(result.extension).toBe('.fit');
    });
  });
});

describe('parseFilename — Dwarf', () => {
  it('parses Dwarf 3 subframe with numbered prefix', () => {
    const result = parseFilename('001-DWARF3_M31_2026-05-13_22-15-08-421.fits');
    expect(result.type).toBe('sub');
    expect(result.subIndex).toBe(1);
    expect(result.target).toBe('M31');
    expect(result.date).toBe('2026-05-13');
  });

  it('parses Dwarf preview JPG (no numbered prefix → stacked)', () => {
    const result = parseFilename('DWARF3_M31_2026-05-13_22-15-08-421.jpg');
    expect(result.type).toBe('stacked');
    expect(result.target).toBe('M31');
    expect(result.date).toBe('2026-05-13');
  });

  it('parses a renamed Dwarf 3 rolling stack with the known `_stacked-NNNN` suffix', () => {
    // dwarfLocalName produces these on import. See server/lib/library/import.ts.
    const result = parseFilename('DWARF3_M31_2026-05-13_22-15-08_stacked-0001.fits');
    expect(result.type).toBe('stacked');
    expect(result.target).toBe('M31');
    expect(result.date).toBe('2026-05-13');
  });

  it('rejects arbitrary suffixes that previously round-tripped (audit 1.32)', () => {
    // The old regex accepted `_<anything>` here. Tightened to `_stacked-\d+`
    // only; arbitrary user-renames now fall through to the `other` branch
    // rather than re-parsing as a fresh import-able record.
    const result = parseFilename('DWARF3_M31_2026-05-13_22-15-08_userrename.fits');
    expect(result.type).toBe('other');
  });

  it('parses Dwarf II USB subframe name produced by dwarfLocalName', () => {
    // dwarfLocalName rewrites HD 279230_15s60_Astro_20260403-234251929_22C.fits
    // (DWARF_RAW_TELE_ session folder) into this form so parseFilename can
    // extract the date and classify it as a sub for the subframes section.
    const result = parseFilename('DWARF3_HD_279230_2026-04-03_23-42-51-929_sub.fits');
    expect(result.type).toBe('sub');
    expect(result.target).toBe('HD 279230');
    expect(result.date).toBe('2026-04-03');
    expect(result.extension).toBe('.fits');
  });

  it('audit 1.44: file date comes from the file timestamp, not the folder', () => {
    // Multi-night Dwarf session: folder named for 2026-05-12 contains files
    // captured after midnight UTC dated 2026-05-13. The file's `date` must
    // reflect its actual capture night so subframe sync sorts it onto the
    // right session date.
    const earlyEvening = parseFilename('001-DWARF3_M31_2026-05-12_23-59-30-100.fits');
    expect(earlyEvening.date).toBe('2026-05-12');
    const afterMidnight = parseFilename('120-DWARF3_M31_2026-05-13_00-02-15-100.fits');
    expect(afterMidnight.date).toBe('2026-05-13');
    expect(earlyEvening.target).toBe(afterMidnight.target);
  });
});

// ─── getSessionKey ──────────────────────────────────────────────

describe('getSessionKey', () => {
  it('returns the date from a parsed filename', () => {
    const parsed = parseFilename('Stacked_150_M42_10.0s_IRCUT_20241015-210530A.jpg');
    expect(getSessionKey(parsed)).toBe('2024-10-15');
  });

  it('returns "unknown" when no date is available', () => {
    const parsed = parseFilename('readme.txt');
    expect(getSessionKey(parsed)).toBe('unknown');
  });
});

// ─── observingNightDate / sessionNightFor ───────────────────────

describe('observingNightDate', () => {
  it('rolls a pre-rollover-hour capture back to the previous calendar date', () => {
    expect(observingNightDate('2024-01-16', '003000')).toBe('2024-01-15');
    expect(observingNightDate('2024-01-16', '065959')).toBe('2024-01-15');
  });

  it('leaves a post-rollover-hour capture on its own calendar date', () => {
    expect(observingNightDate('2024-01-16', '070000')).toBe('2024-01-16');
    expect(observingNightDate('2024-01-16', '223000')).toBe('2024-01-16');
  });

  it('handles month and year rollover', () => {
    expect(observingNightDate('2024-03-01', '010000')).toBe('2024-02-29'); // leap year
    expect(observingNightDate('2024-01-01', '010000')).toBe('2023-12-31');
  });

  it('returns the date unchanged when no time is available', () => {
    expect(observingNightDate('2024-01-16', null)).toBe('2024-01-16');
    expect(observingNightDate('2024-01-16', undefined)).toBe('2024-01-16');
  });
});

describe('sessionNightFor', () => {
  it('merges an 11pm-1am session under the evening it started', () => {
    const evening = parseFilename('Stacked_10_M42_30.0s_IRCUT_20240115-230000.jpg');
    const pastMidnight = parseFilename('sub_00001_M42_10.0s_IRCUT_20240116-003000.fit');
    expect(sessionNightFor(evening)).toBe('2024-01-15');
    expect(sessionNightFor(pastMidnight)).toBe('2024-01-15');
  });

  it('returns null when no date could be parsed at all', () => {
    expect(sessionNightFor(parseFilename('readme.txt'))).toBeNull();
  });
});

describe('clampToNightSafeTime', () => {
  it('bumps an early-morning time up to the rollover hour', () => {
    expect(clampToNightSafeTime('003045')).toBe('073045');
  });

  it('leaves a time at or after the rollover hour unchanged', () => {
    expect(clampToNightSafeTime('070000')).toBe('070000');
    expect(clampToNightSafeTime('220000')).toBe('220000');
  });
});

// ─── Settings > General > "Group sessions by observing night" toggle ────
// This is the single gate that observingNightDate/clampToNightSafeTime (and
// therefore sessionNightFor, and every caller across the app) consult. These
// tests flip the real appSettings row, so every test restores it afterward —
// vitest runs backend test files sequentially against one shared DB, and a
// leaked `false` here would silently break every other suite's assumption
// that grouping defaults on.
describe('observing-night grouping toggle', () => {
  afterEach(() => {
    updateSettingsData({ groupObservingNights: true });
  });

  it('disables the rollover when turned off', () => {
    updateSettingsData({ groupObservingNights: false });
    expect(observingNightDate('2024-01-16', '003000')).toBe('2024-01-16');
    const pastMidnight = parseFilename('sub_00001_M42_10.0s_IRCUT_20240116-003000.fit');
    expect(sessionNightFor(pastMidnight)).toBe('2024-01-16');
  });

  it('makes clampToNightSafeTime a no-op when turned off', () => {
    updateSettingsData({ groupObservingNights: false });
    expect(clampToNightSafeTime('003045')).toBe('003045');
  });

  it('re-enabling restores the rollover', () => {
    updateSettingsData({ groupObservingNights: false });
    updateSettingsData({ groupObservingNights: true });
    expect(observingNightDate('2024-01-16', '003000')).toBe('2024-01-15');
  });
});

// ─── isObjectFolder ─────────────────────────────────────────────

describe('isObjectFolder', () => {
  it('accepts normal object names', () => {
    expect(isObjectFolder('M42')).toBe(true);
    expect(isObjectFolder('NGC7000')).toBe(true);
    expect(isObjectFolder('IC 1318')).toBe(true);
    expect(isObjectFolder('Lunar')).toBe(true);
  });

  it('rejects dot entries', () => {
    expect(isObjectFolder('.')).toBe(false);
    expect(isObjectFolder('..')).toBe(false);
  });

  it('rejects Samples folder', () => {
    expect(isObjectFolder('Samples')).toBe(false);
  });

  it('rejects sub-frame folders', () => {
    expect(isObjectFolder('M42_sub')).toBe(false);
    expect(isObjectFolder('M42_subs')).toBe(false);
  });

  it('rejects hidden folders', () => {
    expect(isObjectFolder('.hidden')).toBe(false);
  });
});

// ─── isSubFolder ────────────────────────────────────────────────

describe('isSubFolder', () => {
  it('identifies _sub folders', () => {
    expect(isSubFolder('M42_sub')).toBe(true);
    expect(isSubFolder('IC 1318_subs')).toBe(true);
  });

  it('rejects non-sub folders', () => {
    expect(isSubFolder('M42')).toBe(false);
    expect(isSubFolder('Samples')).toBe(false);
    expect(isSubFolder('subscribe')).toBe(false);
  });
});

// ─── getObjectFromSubFolder ─────────────────────────────────────

describe('getObjectFromSubFolder', () => {
  it('strips _sub suffix', () => {
    expect(getObjectFromSubFolder('M42_sub')).toBe('M42');
  });

  it('strips _subs suffix', () => {
    expect(getObjectFromSubFolder('IC 1318_subs')).toBe('IC 1318');
  });
});

// ─── normalizeCatalogId ─────────────────────────────────────────

describe('normalizeCatalogId', () => {
  it('removes spaces', () => {
    expect(normalizeCatalogId('IC 1318')).toBe('IC1318');
    expect(normalizeCatalogId('M 42')).toBe('M42');
    expect(normalizeCatalogId('NGC 7000')).toBe('NGC7000');
  });

  it('leaves already normalized IDs unchanged', () => {
    expect(normalizeCatalogId('M42')).toBe('M42');
  });
});

// ─── getFileCategory ────────────────────────────────────────────

describe('getFileCategory', () => {
  it('categorizes images', () => {
    expect(getFileCategory('photo.jpg')).toBe('image');
    expect(getFileCategory('photo.jpeg')).toBe('image');
    expect(getFileCategory('photo.png')).toBe('image');
    expect(getFileCategory('PHOTO.JPG')).toBe('image');
  });

  it('categorizes FITS files', () => {
    expect(getFileCategory('data.fit')).toBe('fits');
    expect(getFileCategory('data.fits')).toBe('fits');
    expect(getFileCategory('DATA.FIT')).toBe('fits');
  });

  it('categorizes videos', () => {
    expect(getFileCategory('lunar.avi')).toBe('video');
    expect(getFileCategory('clip.mp4')).toBe('video');
  });

  it('categorizes thumbnails', () => {
    expect(getFileCategory('Stacked_thn.jpg')).toBe('thumbnail');
  });

  it('returns other for unknown', () => {
    expect(getFileCategory('readme.txt')).toBe('other');
    expect(getFileCategory('data.csv')).toBe('other');
  });
});

// ─── isRealFile ────────────────────────────────────────────────

describe('isRealFile', () => {
  it('accepts real image files', () => {
    expect(isRealFile('image.jpg')).toBe(true);
    expect(isRealFile('image.jpeg')).toBe(true);
    expect(isRealFile('image.png')).toBe(true);
  });

  it('accepts FITS files', () => {
    expect(isRealFile('data.fit')).toBe(true);
    expect(isRealFile('data.fits')).toBe(true);
  });

  it('accepts video files', () => {
    expect(isRealFile('lunar.avi')).toBe(true);
    expect(isRealFile('clip.mp4')).toBe(true);
  });

  it('rejects macOS resource fork files', () => {
    expect(isRealFile('._DSStore')).toBe(false);
    expect(isRealFile('._image.jpg')).toBe(false);
  });

  it('rejects hidden files', () => {
    expect(isRealFile('.hidden')).toBe(false);
    expect(isRealFile('.DS_Store')).toBe(false);
  });

  it('rejects files with unrecognized extensions', () => {
    expect(isRealFile('readme.txt')).toBe(false);
    expect(isRealFile('data.csv')).toBe(false);
    expect(isRealFile('notes.json')).toBe(false);
  });
});
