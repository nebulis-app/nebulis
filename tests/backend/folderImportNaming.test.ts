import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Pure logic only: these modules import telescopeFiles + fitsParser, never the
// database, so this suite runs regardless of the native better-sqlite3 ABI.
// The db-backed scan/commit integration lives in folderImport.test.ts.
import {
  deriveFileDate,
  deriveFromPath,
  deriveFromMtime,
  deriveFromFits,
} from '../../server/lib/library/dateDerivation';
import { canonicalImportName, parsesToDate } from '../../server/lib/library/importNaming';

/** Build a minimal FITS header buffer with the given string cards. */
function fitsBuffer(cards: Record<string, string>): Buffer {
  const lines: string[] = [];
  const card = (key: string, value: string) =>
    (`${key.padEnd(8)}= '${value}'`).padEnd(80).slice(0, 80);
  lines.push(`${'SIMPLE'.padEnd(8)}=                    T`.padEnd(80).slice(0, 80));
  for (const [k, v] of Object.entries(cards)) lines.push(card(k, v));
  lines.push('END'.padEnd(80));
  const buf = Buffer.alloc(2880, ' ');
  buf.write(lines.join(''), 0, 'ascii');
  return buf;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('dateDerivation', () => {
  it('reads DATE-OBS (combined date+time) from a FITS header', () => {
    const file = path.join(tmpDir('fits-'), 'light.fits');
    fs.writeFileSync(file, fitsBuffer({ 'DATE-OBS': '2024-01-15T22:30:45' }));
    expect(deriveFromFits(file)).toEqual({ date: '2024-01-15', source: 'fits', time: '223045' });
  });

  it('reads split DATE-OBS + TIME-OBS', () => {
    const file = path.join(tmpDir('fits-'), 'light.fits');
    fs.writeFileSync(file, fitsBuffer({ 'DATE-OBS': '2024-02-20', 'TIME-OBS': '03:04:05' }));
    expect(deriveFromFits(file)).toEqual({ date: '2024-02-20', source: 'fits', time: '030405' });
  });

  it('returns null for a FITS file with no date card', () => {
    const file = path.join(tmpDir('fits-'), 'nodate.fits');
    fs.writeFileSync(file, fitsBuffer({ OBJECT: 'M31' }));
    expect(deriveFromFits(file)).toBeNull();
  });

  it('finds a dashed date in a folder segment', () => {
    expect(deriveFromPath('2023-09-10/frame.fits')).toEqual({
      date: '2023-09-10', source: 'folder', time: null,
    });
  });

  it('finds a compact date and prefers the closest folder', () => {
    expect(deriveFromPath('2020-01-01/20231225/sub.fit')).toEqual({
      date: '2023-12-25', source: 'folder', time: null,
    });
  });

  it('ignores implausible date-like numbers', () => {
    expect(deriveFromPath('99999999/x.fit')).toBeNull();
  });

  it('derives date + time from mtime', () => {
    const d = new Date(2024, 2, 4, 21, 5, 9);
    expect(deriveFromMtime(d)).toEqual({ date: '2024-03-04', source: 'mtime', time: '210509' });
  });

  it('walks the priority chain: FITS DATE-OBS beats the filename date', () => {
    const file = path.join(tmpDir('chain-'), 'Stacked_10_M42_30.0s_IRCUT_20240115-235000.fits');
    fs.writeFileSync(file, fitsBuffer({ 'DATE-OBS': '2024-01-16T00:10:00' }));
    const derived = deriveFileDate(file, path.basename(file), fs.statSync(file));
    expect(derived).toMatchObject({ date: '2024-01-16', source: 'fits' });
  });

  it('falls back to filename for a non-FITS file', () => {
    const file = path.join(tmpDir('chain-'), 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg');
    fs.writeFileSync(file, 'x');
    const derived = deriveFileDate(file, path.basename(file), fs.statSync(file));
    expect(derived).toMatchObject({ date: '2024-01-15', source: 'filename', time: '220000' });
  });

  it('returns no date when mtime fallback is disabled and nothing else matches', () => {
    const file = path.join(tmpDir('chain-'), 'random.jpg');
    fs.writeFileSync(file, 'x');
    expect(deriveFileDate(file, 'random.jpg', fs.statSync(file), { useMtimeFallback: false }))
      .toEqual({ date: null, source: 'none', time: null });
  });
});

describe('importNaming', () => {
  it('keeps a name that already parses to the assigned date', () => {
    const name = 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg';
    expect(parsesToDate(name, '2024-01-15')).toBe(true);
    expect(canonicalImportName(name, '2024-01-15', '220000', new Set())).toBe(name);
  });

  it('keeps an undated .fits file unchanged (no timestamp rename for telescope extensions)', () => {
    // .fit/.fits/.jpg/.jpeg are never date-stamp renamed — telescope files already
    // have proper names; renaming them would mangle the embedded metadata.
    const out = canonicalImportName('light_001.fits', '2024-01-16', '010000', new Set());
    expect(out).toBe('light_001.fits');
  });

  it('keeps a .jpg with the wrong date unchanged (no rename for telescope extensions)', () => {
    // Merge/split overrides the session date but do not rewrite the filename for .jpg.
    const name = 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg';
    const out = canonicalImportName(name, '2024-01-20', '220000', new Set());
    expect(out).toBe(name);
  });

  it('avoids collisions for .fit files with a numeric suffix (not a timestamp)', () => {
    const used = new Set<string>();
    const a = canonicalImportName('frame.fit', '2024-01-15', '120000', used);
    used.add(a);
    const b = canonicalImportName('frame.fit', '2024-01-15', '120000', used);
    expect(a).toBe('frame.fit');
    expect(b).toBe('frame-2.fit');
  });

  it('preserves the thumbnail marker so classification holds', () => {
    expect(canonicalImportName('preview_thn.jpg', '2024-01-15', null, new Set())).toContain('_thn.jpg');
  });
});
