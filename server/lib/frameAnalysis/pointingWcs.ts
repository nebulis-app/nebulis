/**
 * A plate solution for a frame that has none, so the Object metric can find the object in it (field.ts).
 *
 * Without a solution the object is only found when the frame was pointed at it (it is then taken to be at the
 * centre). A mosaic panel, or a frame framed off-centre on purpose, gets nothing. But frames of one night that point
 * at the same place show the same field (a dither moves it a few pixels), so one solution serves them all:
 *
 *   1. a frame that carries a solution in its header leaves it here for its neighbours;
 *   2. a frame without one borrows the solution of a frame of the same night, camera, frame size and pier side,
 *      pointed within POINTING_TOLERANCE_DEG of it and taken within TIME_WINDOW_MS. The pier side matters: a meridian
 *      flip turns the picture by 180° at the same pointing;
 *   3. when there is none and the object cannot be found otherwise (the frame was not pointed at it), one frame of
 *      that pointing is solved with ASTAP, when it is installed, and the answer is kept for the others.
 *
 * Nothing changes for a frame that carries its own solution.
 */
import fs from 'fs';
import db from '../db.js';
import { parseFitsHeader } from '../fitsParser.js';
import { headerNumber } from '../fitsWcs.js';
import { pointedAtTarget, type TargetSpec } from './field.js';
import type { FileWcs } from './measure.js';

/** Two pointings this close are the same field (dithers, guiding drift). */
export const POINTING_TOLERANCE_DEG = 0.1;
/** A solution is lent only to frames taken this close in time: a rotator or camera can be turned between sessions. */
export const TIME_WINDOW_MS = 4 * 3_600_000;
/** After a failed solve, that pointing is not solved again for this long. */
const FAILED_RETRY_MS = 24 * 3_600_000;
const HEADER_BYTES = 28_800;

db.exec(`CREATE TABLE IF NOT EXISTS framePointingWcs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  camera    TEXT NOT NULL,
  size      TEXT NOT NULL,
  side      TEXT NOT NULL,
  ra        REAL NOT NULL,
  dec       REAL NOT NULL,
  takenAt   REAL NOT NULL,
  wcsJson   TEXT,
  source    TEXT NOT NULL,
  savedAt   REAL NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_framePointingWcs_camera ON framePointingWcs(camera, size, side)');
const nearby = db.prepare<[string, string, string, number, number], { ra: number; dec: number; takenAt: number; wcsJson: string | null; source: string; savedAt: number }>(
  `SELECT ra, dec, takenAt, wcsJson, source, savedAt FROM framePointingWcs
    WHERE camera = ? AND size = ? AND side = ? AND takenAt BETWEEN ? AND ?`,
);
const insert = db.prepare<[string, string, string, number, number, number, string | null, string, number]>(
  'INSERT INTO framePointingWcs (camera, size, side, ra, dec, takenAt, wcsJson, source, savedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);

/** What the header says about where and when a frame was taken, and whether it carries a solution. */
export interface FramePointing {
  camera: string;
  /** NAXIS1 × NAXIS2. */
  size: string;
  width: number;
  height: number;
  /** PIERSIDE, else ROTATOR rounded to the nearest 90° (a flip turns the camera by 180°), else empty. */
  side: string;
  ra: number;
  dec: number;
  takenAt: number;
  /** Arcseconds per file pixel, from FOCALLEN and XPIXSZ, when they are there. */
  scale: number | null;
  /** The header's own solution, when it has one. */
  wcs: FileWcs | null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function readPointing(abs: string): FramePointing | null {
  let values: Record<string, string | number | boolean>;
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const read = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
      values = parseFitsHeader(read === HEADER_BYTES ? buf : buf.subarray(0, read)).values;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return pointingFromHeader(values);
}

export function pointingFromHeader(v: Record<string, string | number | boolean>): FramePointing | null {
  const width = headerNumber(v, 'NAXIS1');
  const height = headerNumber(v, 'NAXIS2');
  const ra = headerNumber(v, 'RA') ?? headerNumber(v, 'CRVAL1');
  const dec = headerNumber(v, 'DEC') ?? headerNumber(v, 'CRVAL2');
  const dateObs = text(v['DATE-OBS']);
  const takenAt = dateObs ? Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(dateObs) ? dateObs : `${dateObs}Z`) : NaN;
  if (!width || !height || ra === undefined || dec === undefined || !Number.isFinite(takenAt)) return null;
  const pier = text(v['PIERSIDE']).toUpperCase();
  const rotator = headerNumber(v, 'ROTATOR');
  const side = pier || (rotator !== undefined ? `rot${((Math.round(rotator / 90) * 90) % 360 + 360) % 360}` : '');
  const focal = headerNumber(v, 'FOCALLEN');
  const pixel = headerNumber(v, 'XPIXSZ');
  const scale = focal && pixel && focal > 0 && pixel > 0 ? (206.265 * pixel) / focal : null;
  return {
    camera: text(v['INSTRUME']) || text(v['TELESCOP']),
    size: `${width}x${height}`, width, height, side, ra, dec, takenAt, scale,
    wcs: headerWcs(v),
  };
}

function headerWcs(v: Record<string, string | number | boolean>): FileWcs | null {
  const crval1 = headerNumber(v, 'CRVAL1'), crval2 = headerNumber(v, 'CRVAL2');
  const crpix1 = headerNumber(v, 'CRPIX1'), crpix2 = headerNumber(v, 'CRPIX2');
  const cd11 = headerNumber(v, 'CD1_1'), cd22 = headerNumber(v, 'CD2_2');
  if ([crval1, crval2, crpix1, crpix2, cd11, cd22].some(x => x === undefined)) return null;
  return { crval1: crval1!, crval2: crval2!, crpix1: crpix1!, crpix2: crpix2!, cd: [cd11!, headerNumber(v, 'CD1_2') ?? 0, headerNumber(v, 'CD2_1') ?? 0, cd22!] };
}

function separationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180;
  const s = Math.sin((dec2 - dec1) * r / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin((ra2 - ra1) * r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / r;
}

/** The nearest kept solution (or failed attempt) for a frame's field, or undefined. */
function kept(p: FramePointing): { wcs: FileWcs | null; failedRecently: boolean } | undefined {
  const rows = nearby.all(p.camera, p.size, p.side, p.takenAt - TIME_WINDOW_MS, p.takenAt + TIME_WINDOW_MS)
    .filter(r => separationDeg(r.ra, r.dec, p.ra, p.dec) <= POINTING_TOLERANCE_DEG)
    .sort((a, b) => Math.abs(a.takenAt - p.takenAt) - Math.abs(b.takenAt - p.takenAt));
  const solved = rows.find(r => r.wcsJson);
  if (solved) {
    try { return { wcs: JSON.parse(solved.wcsJson!) as FileWcs, failedRecently: false }; } catch { /* treated as none */ }
  }
  const failed = rows.find(r => !r.wcsJson && r.source === 'failed' && Date.now() - r.savedAt < FAILED_RETRY_MS);
  return failed ? { wcs: null, failedRecently: true } : undefined;
}

export type PointingSolver = (abs: string, p: FramePointing) => Promise<FileWcs | null>;

const inFlight = new Map<string, Promise<FileWcs | null>>();

/**
 * The solution a frame should be measured with when it carries none, or null. Records a frame's own solution for its
 * neighbours as a side effect. `solver` is only called when the object could not be found otherwise.
 */
export async function borrowedWcsFor(abs: string, target: TargetSpec | null, solver: PointingSolver | null): Promise<FileWcs | null> {
  const p = readPointing(abs);
  if (!p) return null;
  if (p.wcs) {
    // Keep one solution per field per stretch of night: a neighbour within the window is already enough.
    if (!kept(p)?.wcs) insert.run(p.camera, p.size, p.side, p.ra, p.dec, p.takenAt, JSON.stringify(p.wcs), 'header', Date.now());
    return null;
  }
  const hit = kept(p);
  if (hit?.wcs) return hit.wcs;
  // Solving costs seconds: only when the frame cannot be measured otherwise, and not again after a failure.
  if (!target || !solver || hit?.failedRecently) return null;
  if (p.scale !== null && pointedAtTarget(p.scale, p.ra, p.dec, target)) return null;
  const key = `${p.camera}|${p.size}|${p.side}|${p.ra.toFixed(1)}|${p.dec.toFixed(1)}`;
  let job = inFlight.get(key);
  if (!job) {
    job = solver(abs, p).catch(() => null).then(wcs => {
      insert.run(p.camera, p.size, p.side, p.ra, p.dec, p.takenAt, wcs ? JSON.stringify(wcs) : null, wcs ? 'solved' : 'failed', Date.now());
      return wcs;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}
