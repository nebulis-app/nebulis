/**
 * "Annotate this image": work out where an image sits on the sky and which
 * catalog objects are in it.
 *
 * Quality tiers, best first, and what each rests on:
 *
 *   solved       a plate solution from ASTAP, cached per file.
 *   header       the file's own FITS twin carries a WCS (CRVAL + CD matrix).
 *   approximate  no solution: assume the frame is centred on its target (or on
 *                the RA/DEC its FITS twin recorded) and square to the sky,
 *                with the field of view of the telescope that took it. Right
 *                for a single, centred, unrotated frame; visibly off otherwise.
 *   unavailable  nothing to go on (unknown telescope field, a mosaic, no
 *                position). Better to say so than to draw circles in the wrong
 *                place.
 *
 * Coordinates are returned on the 2048 px preview grid (`imageWidth` x
 * `imageHeight`), the picture the viewers actually display; the client scales.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import sharp from '../sharp-optional.js';
import { resolveLibraryFile } from '../library/fileResolver.js';
import { parseFitsHeader } from '../fitsParser.js';
import { headerNumber, parseDecToDegs, parseRaToDegs, readCdMatrix } from '../fitsWcs.js';
import { KIND_FOV_DEG } from '../companionGeometry.js';
import { getById as getDsoById } from '../dsoCatalog.js';
import { getAllProfiles, getProfileById } from '../telescopes.js';
import { isUnsolvableObject } from './unsolvable.js';
import { isGeometryEdited } from './geometryEdits.js';
import { isTelescopeKind, type TelescopeKind } from '../types/telescopeKind.js';
import { log } from '../logger.js';
import { annotateFrame, type FrameAnnotation } from './catalogQuery.js';
import { getSolverStatus, solve as runSolve, SolveFailedError, type SolveHint, type SolverStatus } from './astap.js';
import { approximateWcs, parseWcs, scaleWcs, wcsFromFitsSolution, type Wcs } from './wcs.js';

export type AnnotateQuality = 'solved' | 'header' | 'approximate' | 'unavailable';

export interface SolveJobState {
  state: 'idle' | 'running' | 'failed';
  message: string | null;
}

/** Why no estimate could be made. A code, not prose, so the client can translate it. */
export type UnavailableReason = 'mosaic' | 'no-position' | 'unknown-field' | 'no-sky' | 'edited';

export interface AnnotationResult {
  quality: AnnotateQuality;
  /** Set only when `quality` is 'unavailable'. */
  reason: UnavailableReason | null;
  imageWidth: number;
  imageHeight: number;
  pixelScaleArcsec: number | null;
  annotations: FrameAnnotation[];
  solver: SolverStatus;
  solve: SolveJobState;
}

export class AnnotateInputError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 415) {
    super(message);
    this.name = 'AnnotateInputError';
  }
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff']);
/** Matches the thumbnail route's ceiling, so our grid is the displayed grid. */
const PREVIEW_MAX_PX = 2048;
const FITS_EXTS = ['.fit', '.fits', '.fts'];

const stmts = {
  file: db.prepare<[string], { objectId: string; telescopeId: string | null }>(
    'SELECT objectId, telescopeId FROM libraryFiles WHERE relPath = ?',
  ),
  objectScope: db.prepare<[string], { telescopeId: string }>(
    'SELECT telescopeId FROM libraryFiles WHERE objectId = ? AND telescopeId IS NOT NULL LIMIT 1',
  ),
  getWcs: db.prepare<[string], { mtimeMs: number; source: string; wcsJson: string }>(
    'SELECT mtimeMs, source, wcsJson FROM fileWcs WHERE relPath = ?',
  ),
  getFailure: db.prepare<[string], { mtimeMs: number; message: string }>(
    'SELECT mtimeMs, message FROM fileSolveFailures WHERE relPath = ?',
  ),
  putFailure: db.prepare(
    `INSERT INTO fileSolveFailures (relPath, mtimeMs, message, failedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(relPath) DO UPDATE SET mtimeMs = excluded.mtimeMs, message = excluded.message, failedAt = excluded.failedAt`,
  ),
  clearFailure: db.prepare('DELETE FROM fileSolveFailures WHERE relPath = ?'),
  putWcs: db.prepare(
    `INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(relPath) DO UPDATE SET mtimeMs = excluded.mtimeMs, source = excluded.source,
       wcsJson = excluded.wcsJson, solvedAt = excluded.solvedAt`,
  ),
};

// ─── Inputs read from the file and its FITS twin ────────────────────────────

/** A Dwarf names its stack render `stacked.jpg` (or a thumbnail / TIFF / PNG of
 *  it) while the FITS carries the frame count and target in its name. */
const DWARF_STACK_IMAGE = /^(stacked(_thumbnail)?|img_stacked_all|stacked-\d+_.*)\.(jpe?g|png|tiff?)$/i;
const DWARF_STACK_FITS = /^stacked-(\d+)_.*\.(fit|fits|fts)$/i;

/**
 * The FITS file an image was made from, as an absolute path, or null.
 *
 * Same name with a FITS extension is the SeeStar pairing. A Dwarf's pairing is
 * by role instead: its `stacked.jpg` sits beside `stacked-<N>_<target>….fits`,
 * where N is the frame count of a rolling stack, so the highest N (then the
 * newest file) is the final stack.
 */
export function findFitsTwin(absImage: string): string | null {
  const stem = absImage.replace(/\.[^.]+$/, '');
  for (const ext of FITS_EXTS) {
    for (const candidate of [stem + ext, stem + ext.toUpperCase()]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (!DWARF_STACK_IMAGE.test(path.basename(absImage))) return null;
  const dir = path.dirname(absImage);
  let best: { file: string; n: number; mtime: number } | null = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = DWARF_STACK_FITS.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      const cand = { file, n: Number(m[1]), mtime: fs.statSync(file).mtimeMs };
      if (!best || cand.n > best.n || (cand.n === best.n && cand.mtime > best.mtime)) best = cand;
    }
  } catch {
    return null;
  }
  return best?.file ?? null;
}

function readFitsHeaderValues(absFits: string): Record<string, string | number | boolean> | null {
  try {
    const fd = fs.openSync(absFits, 'r');
    try {
      const buf = Buffer.alloc(2880 * 20);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return parseFitsHeader(buf.subarray(0, n)).values;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** WCS carried by the FITS twin, if it has one that fits this picture. */
function wcsFromFitsHeader(values: Record<string, unknown>): Wcs | null {
  const crval1 = headerNumber(values, 'CRVAL1');
  const crval2 = headerNumber(values, 'CRVAL2');
  const crpix1 = headerNumber(values, 'CRPIX1');
  const crpix2 = headerNumber(values, 'CRPIX2');
  const w = headerNumber(values, 'NAXIS1');
  const h = headerNumber(values, 'NAXIS2');
  const cd = readCdMatrix(values);
  if (
    crval1 === undefined || crval2 === undefined || crpix1 === undefined || crpix2 === undefined ||
    w === undefined || h === undefined || !cd
  ) return null;
  if (String(values.CTYPE1 ?? 'RA---TAN').toUpperCase().includes('SIP')) return null;
  // Row direction is not guaranteed by the file: see wcsFromFitsSolution.
  return wcsFromFitsSolution({
    crval1, crval2, crpix1, crpix2, cd, width: w, height: h,
  });
}

function centreFromFitsHeader(values: Record<string, unknown>): { raDeg: number; decDeg: number } | null {
  const objRa = values.OBJCTRA;
  const objDec = values.OBJCTDEC;
  if (typeof objRa === 'string' && typeof objDec === 'string') {
    return { raDeg: parseRaToDegs(objRa, { decimalIsHours: true }), decDeg: parseDecToDegs(objDec) };
  }
  const ra = headerNumber(values, 'RA');
  const dec = headerNumber(values, 'DEC');
  if (ra !== undefined && dec !== undefined && ra >= 0 && ra <= 360 && Math.abs(dec) <= 90) {
    return { raDeg: ra, decDeg: dec };
  }
  return null;
}

function fovFromFitsOptics(values: Record<string, unknown>): { longSideDeg: number } | null {
  const focal = headerNumber(values, 'FOCALLEN');
  // XPIXSZ is the pixel size "with binning" (the MaxIm DL / NINA / Dwarf
  // convention; Dwarf's own comment says so), so it is not multiplied again.
  const pix = headerNumber(values, 'XPIXSZ');
  const w = headerNumber(values, 'NAXIS1');
  const h = headerNumber(values, 'NAXIS2');
  if (!focal || !pix || !w || !h) return null;
  const arcsecPerPx = (206.265 * pix) / focal;
  return { longSideDeg: (Math.max(w, h) * arcsecPerPx) / 3600 };
}

type Family = 'seestar' | 'dwarf' | null;

function inferFamily(fileName: string, values: Record<string, unknown> | null): Family {
  const id = `${values?.TELESCOP ?? ''} ${values?.INSTRUME ?? ''}`.toLowerCase();
  if (id.includes('seestar')) return 'seestar';
  if (id.includes('dwarf')) return 'dwarf';
  if (/dwarf/i.test(fileName)) return 'dwarf';
  if (/^(dso_)?stacked_\d+_|_(ircut|lp)_/i.test(fileName)) return 'seestar';
  return null;
}

/** The telescope behind a file: its recorded profile, else another file of the
 *  same object, else (for a recognisable family) the owned profile of that
 *  family. The last step is a guess and is reported as one. */
function resolveKind(
  row: { objectId: string; telescopeId: string | null } | undefined,
  fileName: string,
  values: Record<string, unknown> | null,
  /** The file's own pixel size, which tells one sensor from another. */
  dims: { width: number; height: number },
): { kind: TelescopeKind | null; assumed: boolean } {
  const fromProfile = (id: string | null | undefined): TelescopeKind | null => {
    const kind = id ? getProfileById(id)?.kind : null;
    return kind && isTelescopeKind(kind) ? kind : null;
  };
  const recorded = fromProfile(row?.telescopeId)
    ?? (row ? fromProfile(stmts.objectScope.get(row.objectId)?.telescopeId) : null);
  if (recorded) return { kind: recorded, assumed: false };

  const family = inferFamily(fileName, values);
  if (!family) return { kind: null, assumed: false };
  const owned = new Set(
    getAllProfiles()
      .map(p => p.kind)
      .filter((k): k is TelescopeKind => isTelescopeKind(k) && (family === 'seestar' ? k.startsWith('seestar') : k.startsWith('dwarf'))),
  );
  // The one telescope of that family the user owns is strong evidence.
  if (owned.size === 1) return { kind: [...owned][0], assumed: true };
  // Otherwise only a frame we recognise by its sensor. A SeeStar S50 stack is
  // 1080 px on its short side; a 4K frame (S30 Pro, S50 Pro) is a different
  // field of view, and assuming an S50 there would put every ring in the wrong
  // place. Better to say the field is unknown.
  if (family === 'seestar' && Math.min(dims.width, dims.height) === 1080) return { kind: 'seestar-s50', assumed: true };
  return { kind: null, assumed: false };
}

// ─── Solve jobs ─────────────────────────────────────────────────────────────

const solveJobs = new Map<string, SolveJobState>();

function jobState(relPath: string): SolveJobState {
  return solveJobs.get(relPath) ?? { state: 'idle', message: null };
}

interface FrameContext {
  abs: string;
  mtimeMs: number;
  objectId: string | null;
  previewW: number;
  previewH: number;
  hint: SolveHint;
  /** The FITS this image was made from, if one sits beside it. */
  twinAbs: string | null;
  twinValues: Record<string, unknown> | null;
  kind: TelescopeKind | null;
  kindAssumed: boolean;
}

async function buildContext(relPath: string): Promise<FrameContext> {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (!IMAGE_EXTS.has(ext)) throw new AnnotateInputError('Only image files can be annotated', 415);
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) throw new AnnotateInputError('File not found', 404);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved.abs);
  } catch {
    throw new AnnotateInputError('File not found', 404);
  }
  const meta = await sharp(resolved.abs).metadata();
  if (!meta.width || !meta.height) throw new AnnotateInputError('Could not read the image size', 400);
  const k = Math.min(1, PREVIEW_MAX_PX / Math.max(meta.width, meta.height));
  const previewW = Math.max(1, Math.round(meta.width * k));
  const previewH = Math.max(1, Math.round(meta.height * k));

  const row = stmts.file.get(relPath);
  const twinAbs = findFitsTwin(resolved.abs);
  const twinValues = twinAbs ? readFitsHeaderValues(twinAbs) : null;
  const { kind, assumed } = resolveKind(row, path.basename(relPath), twinValues, { width: meta.width, height: meta.height });

  // Where the frame probably points: its twin's recorded position, else the
  // target's catalog position.
  const objectId = row?.objectId ?? null;
  let centre = twinValues ? centreFromFitsHeader(twinValues) : null;
  // A mosaic's object is recorded as e.g. "IC1805_mosaic", which the catalog does not know; its target is the part before.
  const isMosaic = /mosaic/i.test(relPath);
  if (!centre && objectId) {
    const entry = getDsoById(objectId) ?? (isMosaic ? getDsoById(objectId.replace(/_mosaic$/i, '')) : null);
    if (entry) centre = { raDeg: entry.ra * 15, decDeg: entry.dec };
  }
  // The file's own optics are exact; the per-telescope table is the fallback, except for a mosaic, which is
  // wider than one frame: a wrong scale costs a whole failed search before the solver is left to find it.
  const fov = kind && !isMosaic ? KIND_FOV_DEG[kind] : undefined;
  const longSideDeg = (twinValues ? fovFromFitsOptics(twinValues)?.longSideDeg : undefined)
    ?? (fov ? Math.max(fov.widthDeg, fov.heightDeg) : undefined);

  return {
    abs: resolved.abs,
    mtimeMs: stat.mtimeMs,
    objectId,
    previewW,
    previewH,
    hint: { raDeg: centre?.raDeg, decDeg: centre?.decDeg, longSideDeg },
    twinAbs,
    twinValues,
    kind,
    kindAssumed: assumed,
  };
}

function cachedWcs(relPath: string, mtimeMs: number): Wcs | null {
  const row = stmts.getWcs.get(relPath);
  if (!row || row.mtimeMs !== mtimeMs) return null;
  try {
    return parseWcs(JSON.parse(row.wcsJson));
  } catch {
    return null;
  }
}

export async function getAnnotations(relPath: string): Promise<AnnotationResult> {
  const ctx = await buildContext(relPath);
  const solver = getSolverStatus();
  if (isUnsolvableObject(ctx.objectId)) {
    const idle = { state: 'idle' as const, message: null };
    return { imageWidth: ctx.previewW, imageHeight: ctx.previewH, solver, solve: idle, quality: 'unavailable', reason: 'no-sky', pixelScaleArcsec: null, annotations: [] };
  }
  let solve = jobState(relPath);
  if (solve.state === 'idle') {
    const failure = stmts.getFailure.get(relPath);
    if (failure && failure.mtimeMs === ctx.mtimeMs) solve = { state: 'failed', message: failure.message };
  }
  const base = { imageWidth: ctx.previewW, imageHeight: ctx.previewH, solver, solve };

  let wcs: Wcs | null = null;
  let quality: AnnotateQuality = 'unavailable';
  let reason: UnavailableReason | null = null;

  const solved = cachedWcs(relPath, ctx.mtimeMs);
  if (solved) {
    wcs = scaleWcs(solved, ctx.previewW, ctx.previewH);
    if (wcs) quality = 'solved';
  }
  // The header and the telescope's field describe the frame as captured; once it was cropped or rotated only a
  // solve of the picture itself can place objects.
  const edited = !wcs && isGeometryEdited(relPath, ctx.mtimeMs);
  if (edited) reason = 'edited';
  if (!wcs && !edited && ctx.twinValues) {
    const header = wcsFromFitsHeader(ctx.twinValues);
    const scaled = header ? scaleWcs(header, ctx.previewW, ctx.previewH) : null;
    if (scaled) {
      wcs = scaled;
      quality = 'header';
    }
  }
  if (!wcs && !edited) {
    const { raDeg, decDeg, longSideDeg } = ctx.hint;
    if (/mosaic/i.test(relPath)) {
      reason = 'mosaic';
    } else if (raDeg == null || decDeg == null) {
      reason = 'no-position';
    } else if (!longSideDeg) {
      reason = 'unknown-field';
    } else {
      wcs = approximateWcs({ raDeg, decDeg, width: ctx.previewW, height: ctx.previewH, longSideDeg });
      quality = 'approximate';
    }
  }

  if (!wcs) return { ...base, quality: 'unavailable', reason, pixelScaleArcsec: null, annotations: [] };

  // A mosaic's object id ("IC1805_mosaic") is not a catalog id; its target is the part before the suffix.
  const annotations = annotateFrame(wcs, { targetId: ctx.objectId?.replace(/_mosaic$/i, '') ?? null });
  const det = Math.abs(wcs.cd.cd11 * wcs.cd.cd22 - wcs.cd.cd12 * wcs.cd.cd21);
  return { ...base, quality, reason: null, pixelScaleArcsec: Math.sqrt(det) * 3600, annotations };
}

/**
 * Start a background plate solve for this file. Returns immediately with the
 * job's state; poll `getAnnotations` for the outcome. Already-running solves are
 * joined, and an already-solved file is a no-op.
 */
export async function startSolve(relPath: string): Promise<SolveJobState> {
  const ctx = await buildContext(relPath);
  if (isUnsolvableObject(ctx.objectId) || cachedWcs(relPath, ctx.mtimeMs)) return { state: 'idle', message: null };
  const running = solveJobs.get(relPath);
  if (running?.state === 'running') return running;

  solveJobs.set(relPath, { state: 'running', message: null });
  void solveFrame(ctx)
    .then(({ wcs, source }) => {
      stmts.putWcs.run(relPath, ctx.mtimeMs, source, JSON.stringify(wcs), new Date().toISOString());
      stmts.clearFailure.run(relPath);
      solveJobs.delete(relPath);
      log.info(`[annotate] solved ${path.basename(relPath)} (${source})`);
    })
    .catch(err => {
      const message = err instanceof SolveFailedError || err instanceof Error ? err.message : String(err);
      if (err instanceof SolveFailedError && err.reason === 'no-solution') {
        stmts.putFailure.run(relPath, ctx.mtimeMs, message, new Date().toISOString());
      }
      solveJobs.set(relPath, { state: 'failed', message });
    });
  return { state: 'running', message: null };
}

/** True when this file already has an answer for its current bytes: a solution, or a solve that found nothing. */
export function hasSolveOutcome(relPath: string, mtimeMs: number): boolean {
  return cachedWcs(relPath, mtimeMs) !== null || stmts.getFailure.get(relPath)?.mtimeMs === mtimeMs;
}

/** Solve one file now and wait for it. Used by the background job; `startSolve` is the request-driven form. */
export async function solveAndStore(relPath: string): Promise<'solved' | 'failed' | 'skipped'> {
  const ctx = await buildContext(relPath);
  if (isUnsolvableObject(ctx.objectId) || hasSolveOutcome(relPath, ctx.mtimeMs)) return 'skipped';
  try {
    const { wcs, source } = await solveFrame(ctx);
    stmts.putWcs.run(relPath, ctx.mtimeMs, source, JSON.stringify(wcs), new Date().toISOString());
    stmts.clearFailure.run(relPath);
    log.info(`[annotate] auto-solved ${path.basename(relPath)} (${source})`);
    return 'solved';
  } catch (err) {
    if (err instanceof SolveFailedError && err.reason === 'no-solution') {
      stmts.putFailure.run(relPath, ctx.mtimeMs, err.message, new Date().toISOString());
      return 'failed';
    }
    throw err;
  }
}

/**
 * Solve the frame, preferring the FITS it was made from: the data is linear and
 * full resolution, and the header's position and optics make the search
 * tighter. When that cannot be used (no FITS beside the image, no solution, or
 * a FITS that is not the same picture) the image itself is solved, which works
 * on its own and is the path every JPG-only night takes.
 */
async function solveFrame(ctx: FrameContext): Promise<{ wcs: Wcs; source: 'astap-fits' | 'astap' }> {
  if (ctx.twinAbs && ctx.twinValues) {
    const w = headerNumber(ctx.twinValues, 'NAXIS1');
    const h = headerNumber(ctx.twinValues, 'NAXIS2');
    if (w && h) {
      try {
        const raw = await runSolve({ kind: 'fits', abs: ctx.twinAbs, width: w, height: h }, ctx.hint);
        const wcs = wcsFromFitsSolution(raw);
        // Only trust it if it describes this picture's shape.
        if (scaleWcs(wcs, ctx.previewW, ctx.previewH)) return { wcs, source: 'astap-fits' };
      } catch (err) {
        if (!(err instanceof SolveFailedError) || err.reason === 'not-installed') throw err;
        log.info(`[annotate] FITS solve failed for ${path.basename(ctx.twinAbs)}, trying the image`);
      }
    }
  }
  return { wcs: await runSolve({ kind: 'image', abs: ctx.abs }, ctx.hint), source: 'astap' };
}
