import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Isolated DATA_DIR before any server module loads (paths.ts reads it at import).
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-integration-test-'));
});

import {
  normalizeFilterName,
  readSubFrameHeader,
  getSubFrameHeader,
  getIntegrationBreakdown,
  setIntegrationGoals,
  getIntegrationGoals,
  getIntegrationProgressForGoalObjects,
  setFilterAliases,
  getFilterAliases,
  DEFAULT_EXPOSURE_SEC,
  MAX_GOAL_SEC,
} from '../../server/lib/library/integration';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { saveCaptureInfo } from '../../server/lib/library/captureInfo';
import { rekeyLibraryObject } from '../../server/lib/library/libraryRekey';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

const OBJECT_ID = 'Sh2-105';
const FOLDER = 'Sh2-105';

// ─── FITS helpers ────────────────────────────────────────────────────────────

function card(key: string, value: string | number): string {
  const v = typeof value === 'number' ? String(value).padStart(20) : `'${value}'`;
  return `${key.padEnd(8)}= ${v}`.padEnd(80);
}

/** A minimal FITS file: header cards (optionally padded with filler cards so
 *  the interesting ones land past the first 2880-byte block) + a data block. */
function fitsBuffer(cards: [string, string | number][], fillerCards = 0): Buffer {
  const lines: string[] = [
    `SIMPLE  = ${'T'.padStart(20)}`.padEnd(80),
    card('BITPIX', 16),
    card('NAXIS', 0),
  ];
  for (let i = 0; i < fillerCards; i++) lines.push(card(`HIST${String(i).padStart(4, '0')}`, i));
  for (const [k, v] of cards) lines.push(card(k, v));
  lines.push('END'.padEnd(80));
  let header = lines.join('');
  const pad = (2880 - (header.length % 2880)) % 2880;
  header += ' '.repeat(pad);
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.alloc(2880)]);
}

function seedObject(): void {
  stmts.upsertObject.run(
    OBJECT_ID, FOLDER, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
}

function addSub(
  fileName: string,
  night: string,
  cards: [string, string | number][],
  fillerCards = 0,
): string {
  const dir = path.join(LIBRARY_DIR, FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), fitsBuffer(cards, fillerCards));
  recordLibraryFile({
    objectId: OBJECT_ID,
    folderName: FOLDER,
    fileName,
    role: 'sub',
    captureDate: night,
    captureTime: '230000',
    sessionDateOverride: night,
  });
  return `${FOLDER}/${fileName}`;
}

beforeEach(() => {
  for (const t of ['libraryFiles', 'libraryObjects', 'captureInfo', 'objectIntegrationGoals', 'filterAliases', 'subFrameHeaderCache']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  seedObject();
});

// ─── Filter names ────────────────────────────────────────────────────────────

describe('normalizeFilterName', () => {
  it('maps common spellings to one canonical name', () => {
    for (const raw of ['Ha', 'HA', 'H-alpha', 'h_alpha', ' Halpha ']) {
      expect(normalizeFilterName(raw)).toBe('Ha');
    }
    expect(normalizeFilterName('O-III')).toBe('OIII');
    expect(normalizeFilterName('s2')).toBe('SII');
    expect(normalizeFilterName('Luminance')).toBe('L');
  });

  it('treats empty and "none" values as the no-filter bucket', () => {
    for (const raw of [null, undefined, '', '  ', 'None', 'No Filter', 'N/A']) {
      expect(normalizeFilterName(raw)).toBe('');
    }
  });

  it('keeps unknown names as written (whitespace cleaned) and leaves bandwidth variants apart', () => {
    expect(normalizeFilterName('  L-eXtreme  ')).toBe('L-eXtreme');
    expect(normalizeFilterName('Ha 3nm')).toBe('Ha 3nm');
    expect(normalizeFilterName('Ha 7nm')).toBe('Ha 7nm');
  });

  it('applies user aliases before built-ins, case-insensitively', () => {
    const aliases = new Map([['ha 7nm', 'Ha'], ['l-extreme', 'Dual-band']]);
    expect(normalizeFilterName('Ha 7nm', aliases)).toBe('Ha');
    expect(normalizeFilterName('L-eXtreme', aliases)).toBe('Dual-band');
  });
});

describe('filter aliases storage', () => {
  it('replaces the list, dropping empty and self-mapping entries', () => {
    setFilterAliases([
      { alias: 'Ha 7nm', canonical: 'Ha' },
      { alias: ' ', canonical: 'X' },
      { alias: 'OIII', canonical: 'oiii' },
    ]);
    expect(getFilterAliases()).toEqual([{ alias: 'Ha 7nm', canonical: 'Ha' }]);
    setFilterAliases([]);
    expect(getFilterAliases()).toEqual([]);
  });
});

// ─── Header reading ──────────────────────────────────────────────────────────

describe('readSubFrameHeader', () => {
  it('finds FILTER and EXPTIME past the first 2880-byte block', () => {
    const file = path.join(LIBRARY_DIR, 'long-header.fits');
    // 40 filler cards push FILTER/EXPTIME into the second block.
    fs.writeFileSync(file, fitsBuffer([['FILTER', 'OIII'], ['EXPTIME', 300]], 40));
    expect(readSubFrameHeader(file)).toEqual({ rawFilter: 'OIII', exposureSec: 300 });
  });

  it('returns null for an unreadable or truncated file', () => {
    expect(readSubFrameHeader(path.join(LIBRARY_DIR, 'missing.fits'))).toBeNull();
    const short = path.join(LIBRARY_DIR, 'short.fits');
    fs.writeFileSync(short, 'SIMPLE');
    expect(readSubFrameHeader(short)).toBeNull();
  });
});

describe('getSubFrameHeader cache', () => {
  it('serves from cache while size and mtime match, re-reads when the file changes', () => {
    const rel = addSub('a.fits', '2026-09-20', [['FILTER', 'Ha'], ['EXPTIME', 300]]);
    expect(getSubFrameHeader(rel)?.rawFilter).toBe('Ha');
    expect(db.prepare('SELECT COUNT(*) AS n FROM subFrameHeaderCache').get()).toEqual({ n: 1 });

    // Different content (and size) → cache invalidated.
    const abs = path.join(LIBRARY_DIR, rel);
    fs.writeFileSync(abs, fitsBuffer([['FILTER', 'SII'], ['EXPTIME', 600]], 40));
    expect(getSubFrameHeader(rel)).toEqual({ rawFilter: 'SII', exposureSec: 600 });
  });
});

// ─── Breakdown ───────────────────────────────────────────────────────────────

describe('getIntegrationBreakdown', () => {
  it('splits one night shot in two filters into two totals', () => {
    addSub('ha1.fits', '2026-09-20', [['FILTER', 'Ha'], ['EXPTIME', 300]]);
    addSub('ha2.fits', '2026-09-20', [['FILTER', 'H-alpha'], ['EXPTIME', 300]]);
    addSub('o1.fits', '2026-09-20', [['FILTER', 'OIII'], ['EXPTIME', 300]], 40);
    addSub('o2.fits', '2026-09-21', [['FILTER', 'OIII'], ['EXPTIME', 600]]);

    const b = getIntegrationBreakdown(OBJECT_ID);
    expect(b.totalFrames).toBe(4);
    expect(b.totalExposureSec).toBe(1500);
    expect(b.unreadableFrames).toBe(0);
    expect(b.filters.map(f => [f.filter, f.frames, f.exposureSec])).toEqual([
      ['Ha', 2, 600],
      ['OIII', 2, 900],
    ]);
    expect(b.filters[1].nights).toEqual([
      { date: '2026-09-20', frames: 1, exposureSec: 300 },
      { date: '2026-09-21', frames: 1, exposureSec: 600 },
    ]);
  });

  it('falls back to the capture sidecar, then to the no-filter bucket and the default exposure', () => {
    addSub('dwarf1.fits', '2026-09-22', []);
    saveCaptureInfo({
      objectId: OBJECT_ID, sessionFolder: 'run1', sessionDate: '2026-09-22',
      exposureSec: 60, gain: 60, filter: 'Duo-Band', binning: '1*1',
      framesStacked: null, framesTaken: null, framesPlanned: null,
      minTempC: null, maxTempC: null, raHours: null, decDeg: null, target: null, sourceRelPath: null,
    });
    addSub('osc1.fits', '2026-09-23', []);

    const b = getIntegrationBreakdown(OBJECT_ID);
    expect(b.filters.map(f => [f.filter, f.exposureSec])).toEqual([
      ['Duo-Band', 60],
      [null, DEFAULT_EXPOSURE_SEC],
    ]);
  });

  it('ignores the sidecar filter when runs that night disagree', () => {
    addSub('x.fits', '2026-09-24', [['EXPTIME', 120]]);
    for (const [folder, filter] of [['r1', 'Duo-Band'], ['r2', 'IR-cut']]) {
      saveCaptureInfo({
        objectId: OBJECT_ID, sessionFolder: folder, sessionDate: '2026-09-24',
        exposureSec: 120, gain: null, filter, binning: null,
        framesStacked: null, framesTaken: null, framesPlanned: null,
        minTempC: null, maxTempC: null, raHours: null, decDeg: null, target: null, sourceRelPath: null,
      });
    }
    expect(getIntegrationBreakdown(OBJECT_ID).filters.map(f => f.filter)).toEqual([null]);
  });

  it('counts only FITS subs, including subs on disk with no libraryFiles row', () => {
    addSub('ok.fits', '2026-09-20', [['FILTER', 'Ha'], ['EXPTIME', 300]]);
    recordLibraryFile({ objectId: OBJECT_ID, folderName: FOLDER, fileName: 'stack.jpg', role: 'preview', captureDate: null, captureTime: null });
    // A row whose file is gone: not on disk, so not a sub of this object any more.
    recordLibraryFile({ objectId: OBJECT_ID, folderName: FOLDER, fileName: 'gone.fits', role: 'sub', captureDate: '2026-09-20', captureTime: '230000' });
    // A sub on disk with no row (pre-backfill import): found by name, like the observation cards do.
    fs.writeFileSync(
      path.join(LIBRARY_DIR, FOLDER, 'Light_Sh2-105_180.0s_Bin1_H_gain252_20260905-221500_-10.0C_0001.fit'),
      fitsBuffer([['FILTER', 'H'], ['EXPTIME', 180]]),
    );

    const b = getIntegrationBreakdown(OBJECT_ID);
    expect(b.totalFrames).toBe(2);
    expect(b.unreadableFrames).toBe(0);
    expect(b.filters.map(f => [f.filter, f.frames, f.exposureSec])).toEqual([
      ['H', 1, 180],
      ['Ha', 1, 300],
    ]);
  });

  it('reports truncated subs as unreadable', () => {
    addSub('ok.fits', '2026-09-20', [['FILTER', 'Ha'], ['EXPTIME', 300]]);
    addSub('bad.fits', '2026-09-20', []);
    fs.writeFileSync(path.join(LIBRARY_DIR, FOLDER, 'bad.fits'), 'SIMPLE');
    const b = getIntegrationBreakdown(OBJECT_ID);
    expect(b.totalFrames).toBe(1);
    expect(b.unreadableFrames).toBe(1);
  });

  it('applies user aliases at read time without re-reading headers', () => {
    addSub('a.fits', '2026-09-20', [['FILTER', 'Ha 7nm'], ['EXPTIME', 300]]);
    addSub('b.fits', '2026-09-21', [['FILTER', 'Ha'], ['EXPTIME', 300]]);
    expect(getIntegrationBreakdown(OBJECT_ID).filters.map(f => f.filter)).toEqual(['Ha', 'Ha 7nm']);

    setFilterAliases([{ alias: 'Ha 7nm', canonical: 'Ha' }]);
    const b = getIntegrationBreakdown(OBJECT_ID);
    expect(b.filters.map(f => [f.filter, f.frames])).toEqual([['Ha', 2]]);
  });
});

// ─── Goals ───────────────────────────────────────────────────────────────────

describe('integration goals', () => {
  it('normalises filter names, removes zero goals and lists goal-only filters after the rest', () => {
    addSub('ha.fits', '2026-09-20', [['FILTER', 'Ha'], ['EXPTIME', 300]]);
    setIntegrationGoals(OBJECT_ID, [
      { filter: 'H-alpha', goalSec: 36000 },
      { filter: 'SII', goalSec: 21600 },
      { filter: 'OIII', goalSec: 0 },
      { filter: null, goalSec: 3600 },
    ]);
    expect(getIntegrationGoals(OBJECT_ID)).toEqual([
      { filter: null, goalSec: 3600 },
      { filter: 'Ha', goalSec: 36000 },
      { filter: 'SII', goalSec: 21600 },
    ]);

    const b = getIntegrationBreakdown(OBJECT_ID);
    expect(b.filters.map(f => [f.filter, f.exposureSec, f.goalSec])).toEqual([
      ['Ha', 300, 36000],
      ['SII', 0, 21600],
      [null, 0, 3600],
    ]);
  });

  it('replaces previous goals and rejects out-of-range values', () => {
    setIntegrationGoals(OBJECT_ID, [{ filter: 'Ha', goalSec: 3600 }]);
    setIntegrationGoals(OBJECT_ID, [{ filter: 'OIII', goalSec: 7200 }]);
    expect(getIntegrationGoals(OBJECT_ID)).toEqual([{ filter: 'OIII', goalSec: 7200 }]);

    expect(() => setIntegrationGoals(OBJECT_ID, [{ filter: 'Ha', goalSec: -1 }])).toThrow(RangeError);
    expect(() => setIntegrationGoals(OBJECT_ID, [{ filter: 'Ha', goalSec: MAX_GOAL_SEC + 1 }])).toThrow(RangeError);
    expect(getIntegrationGoals(OBJECT_ID)).toEqual([{ filter: 'OIII', goalSec: 7200 }]);
  });

  it('follows the object when it is rekeyed', () => {
    setIntegrationGoals(OBJECT_ID, [{ filter: 'Ha', goalSec: 3600 }]);
    rekeyLibraryObject(OBJECT_ID, 'SH2-105-renamed', { skipManifest: true });
    expect(getIntegrationGoals(OBJECT_ID)).toEqual([]);
    expect(getIntegrationGoals('SH2-105-renamed')).toEqual([{ filter: 'Ha', goalSec: 3600 }]);
  });
});

describe('getIntegrationProgressForGoalObjects', () => {
  it('lists only objects with goals, largest-first order left to the UI, with remaining time floored at 0', () => {
    addSub('d1a.fits', '2026-09-20', [['FILTER', 'D1'], ['EXPTIME', 3600]]);
    addSub('d1b.fits', '2026-09-21', [['FILTER', 'D1'], ['EXPTIME', 3600]]);
    addSub('d2.fits', '2026-09-21', [['FILTER', 'D2'], ['EXPTIME', 3600]]);
    setIntegrationGoals(OBJECT_ID, [
      { filter: 'D1', goalSec: 3600 },
      { filter: 'D2', goalSec: 5 * 3600 },
    ]);
    stmts.upsertObject.run('M31', 'M31', 0, new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null);

    expect(getIntegrationProgressForGoalObjects()).toEqual([{
      objectId: OBJECT_ID,
      complete: false,
      filters: [
        { filter: 'D1', goalSec: 3600, exposureSec: 7200, remainingSec: 0 },
        { filter: 'D2', goalSec: 18000, exposureSec: 3600, remainingSec: 14400 },
      ],
    }]);
  });

  it('marks an object complete when every goal is reached', () => {
    addSub('d1.fits', '2026-09-20', [['FILTER', 'D1'], ['EXPTIME', 3600]]);
    setIntegrationGoals(OBJECT_ID, [{ filter: 'D1', goalSec: 3600 }]);
    expect(getIntegrationProgressForGoalObjects()[0].complete).toBe(true);
  });
});
