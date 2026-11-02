/**
 * Sub-frame analysis for a library night: measure each raw FITS frame once (cached in `frameMetrics`), then rank
 * the frames of the night against each other. The measuring is in `measure.ts`, the judging in `ranking.ts`.
 */
import fs from 'fs';
import db from '../db.js';
import { resolveLibraryFile } from '../library/fileResolver.js';
import { getLocalFiles } from '../library/observations.js';
import { isRecord } from '../typeGuards.js';
import { getCatalogEntry } from '../../data/catalog.js';
import { parseDecToDegs, parseRaToDegs } from '../fitsWcs.js';
import { getLibraryObjectNames } from '../library/objects.js';
import { normalizeCatalogId, parseFilename } from '../telescopeFiles.js';
import { FRAME_METRICS_VERSION, FrameDecodeError, type FrameMetrics, type TargetSpec } from './measure.js';
import { coerceMetrics } from './metricsRecord.js';
import { measureOffThread } from './measureOffThread.js';
import { rankFrames, isFrameKept, type FrameReference, type FrameVerdict } from './ranking.js';

export class FrameFileError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'UNREADABLE', message: string) {
    super(message);
  }
}

// ─── Stored measurements ──────────────────────────────────────────────────

function readStored(relPath: string, size: number, mtimeMs: number): FrameMetrics | null {
  const row = db.prepare('SELECT size, mtimeMs, version, metricsJson FROM frameMetrics WHERE relPath = ?').get(relPath);
  if (!isRecord(row)) return null;
  if (row.size !== size || row.mtimeMs !== mtimeMs || row.version !== FRAME_METRICS_VERSION) return null;
  if (typeof row.metricsJson !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.metricsJson); } catch { return null; }
  return coerceMetrics(parsed);
}

function writeStored(relPath: string, size: number, mtimeMs: number, metrics: FrameMetrics): void {
  db.prepare(`
    INSERT INTO frameMetrics (relPath, size, mtimeMs, version, metricsJson, measuredAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(relPath) DO UPDATE SET size = excluded.size, mtimeMs = excluded.mtimeMs,
      version = excluded.version, metricsJson = excluded.metricsJson, measuredAt = excluded.measuredAt
  `).run(relPath, size, Math.round(mtimeMs), FRAME_METRICS_VERSION, JSON.stringify(metrics), new Date().toISOString());
}

// ─── Measuring ────────────────────────────────────────────────────────────

function statLibraryFile(relPath: string): { abs: string; size: number; mtimeMs: number } {
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) throw new FrameFileError('FORBIDDEN', 'Invalid file path');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.abs);
  } catch {
    throw new FrameFileError('NOT_FOUND', 'File not found');
  }
  if (!stat.isFile()) throw new FrameFileError('NOT_FOUND', 'File not found');
  return { abs: resolved.abs, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

/**
 * Where the object a library file belongs to sits on the sky, from the catalogue: the object is the one whose folder
 * holds the file. Null for an object the catalogue does not place or size (a comet, a custom name), which then gets
 * no target measurement.
 */
export function targetForFile(relPath: string): TargetSpec | null {
  const norm = relPath.replace(/\\/g, '/');
  let best: { objectId: string; folderName: string } | null = null;
  for (const o of getLibraryObjectNames()) {
    const folder = o.folderName.replace(/\\/g, '/').replace(/\/+$/, '');
    if (folder && norm.startsWith(`${folder}/`) && (!best || folder.length > best.folderName.length)) best = { objectId: o.objectId, folderName: folder };
  }
  if (!best) return null;
  const entry = getCatalogEntry(normalizeCatalogId(best.objectId)) ?? getCatalogEntry(best.objectId);
  if (!entry?.ra || !entry.dec || !entry.majorAxisArcmin || !(entry.majorAxisArcmin > 0)) return null;
  const ra = parseRaToDegs(entry.ra, { decimalIsHours: true });
  const dec = parseDecToDegs(entry.dec);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || (ra === 0 && dec === 0)) return null;
  return { ra, dec, radiusArcmin: entry.majorAxisArcmin / 2 };
}

/**
 * The measurement of one library file, from the store when the file is unchanged, otherwise read and stored.
 * The reading and the star search run on a worker thread; this thread only touches the database.
 */
export async function measureLibraryFile(relPath: string, force = false): Promise<{ metrics: FrameMetrics; cached: boolean }> {
  const file = statLibraryFile(relPath);
  if (!force) {
    const hit = readStored(relPath, file.size, file.mtimeMs);
    if (hit) return { metrics: hit, cached: true };
  }
  let metrics: FrameMetrics;
  try {
    let target: TargetSpec | null = null;
    try { target = targetForFile(relPath); } catch { /* no catalogue place: measured without a target */ }
    metrics = await measureOffThread(file.abs, target);
  } catch (err) {
    if (err instanceof FrameDecodeError) throw new FrameFileError('UNREADABLE', err.message);
    throw err;
  }
  writeStored(relPath, file.size, file.mtimeMs, metrics);
  return { metrics, cached: false };
}

// ─── Keep / reject overrides ──────────────────────────────────────────────

export type FrameReview = 'keep' | 'reject';

function readReviews(paths: string[]): Map<string, FrameReview> {
  const out = new Map<string, FrameReview>();
  if (paths.length === 0) return out;
  const stmt = db.prepare('SELECT keep FROM frameReview WHERE relPath = ?');
  for (const p of paths) {
    const row = stmt.get(p);
    if (isRecord(row) && typeof row.keep === 'number') out.set(p, row.keep === 1 ? 'keep' : 'reject');
  }
  return out;
}

/** Records the user's call on a frame, or clears it (`null`) so the frame follows its grade again. */
export function setFrameReview(relPath: string, review: FrameReview | null): void {
  statLibraryFile(relPath); // same path checks as measuring: inside the library, a real file
  if (review === null) {
    db.prepare('DELETE FROM frameReview WHERE relPath = ?').run(relPath);
    return;
  }
  db.prepare(`
    INSERT INTO frameReview (relPath, keep, decidedAt) VALUES (?, ?, ?)
    ON CONFLICT(relPath) DO UPDATE SET keep = excluded.keep, decidedAt = excluded.decidedAt
  `).run(relPath, review === 'keep' ? 1 : 0, new Date().toISOString());
}

// ─── A night's report ─────────────────────────────────────────────────────

type SessionFileRecord = ReturnType<typeof getLocalFiles>[number];

export interface FrameAnalysisRow {
  path: string;
  name: string;
  timestamp: string | null;
  /** Server-rendered preview and the raw download, for the list's thumbnail. */
  thumbUrl: string | null;
  downloadUrl: string;
  /** The library's own record of the file, so a viewer can open it without a second lookup. */
  file: SessionFileRecord;
  /** Null until the frame has been measured. */
  metrics: FrameMetrics | null;
  verdict: FrameVerdict | null;
  /** The user's own call, or null to follow the grade. */
  review: FrameReview | null;
  /** Whether the frame belongs in a stack: the review if there is one, else not graded bad. */
  kept: boolean;
}

export interface FrameAnalysisReport {
  objectId: string;
  date: string;
  frames: FrameAnalysisRow[];
  reference: FrameReference | null;
  measured: number;
  total: number;
}

/**
 * Frames are compared only with frames taken the same way: the same filter and exposure, through the same camera at
 * the same focal length (a library can hold one object shot with several telescopes, or a smart telescope and a
 * rig), at the same frame size (binning, crop). Focal lengths within 5 % are the same train: FOCALLEN is often
 * rounded or entered by hand.
 */
function setKey(filter: string | null, exposure: string | null, m: FrameMetrics): string {
  const focal = m.rig.focal !== null ? Math.round(Math.log(m.rig.focal) / Math.log(1.05)) : '';
  return [(filter ?? '').trim().toLowerCase(), (exposure ?? '').trim(), (m.rig.camera ?? '').toLowerCase(), focal, `${m.width}x${m.height}`].join('|');
}

/**
 * The stored measurements of the objects' frames from other nights, by filter and exposure, read straight from the
 * store (no file is opened). A frame measured by an older analyzer is left out, as it would be re-measured.
 */
function otherNightsMetrics(objectIds: string[], exclude: Set<string>): Map<string, FrameMetrics[]> {
  const out = new Map<string, FrameMetrics[]>();
  const folders = new Set<string>();
  const wanted = new Set(objectIds);
  for (const o of getLibraryObjectNames()) if (wanted.has(o.objectId) && o.folderName) folders.add(o.folderName.replace(/\\/g, '/').replace(/\/+$/, ''));
  const stmt = db.prepare("SELECT relPath, version, metricsJson FROM frameMetrics WHERE relPath LIKE ? ESCAPE '\\'");
  for (const folder of folders) {
    const like = `${folder.replace(/[\\%_]/g, c => `\\${c}`)}/%`;
    for (const row of stmt.all(like)) {
      if (!isRecord(row) || typeof row.relPath !== 'string' || row.version !== FRAME_METRICS_VERSION || typeof row.metricsJson !== 'string') continue;
      if (exclude.has(row.relPath)) continue;
      const parsed = parseFilename(row.relPath.split('/').pop() ?? '');
      if (parsed.type !== 'sub') continue;
      let metrics: FrameMetrics | null = null;
      try { metrics = coerceMetrics(JSON.parse(row.metricsJson)); } catch { metrics = null; }
      if (!metrics) continue;
      const key = setKey(parsed.filter || null, parsed.exposure || null, metrics);
      const list = out.get(key);
      if (list) list.push(metrics); else out.set(key, [metrics]);
    }
  }
  return out;
}

/**
 * Every raw FITS sub-frame of a night in capture order, with whatever has been measured so far and a verdict for
 * each measured frame. Nothing is measured here: the caller asks for the missing ones one at a time.
 */
export function buildSessionReport(objectIds: string[], date: string): FrameAnalysisReport {
  const files = objectIds.flatMap(id => getLocalFiles(id, date))
    .filter(f => f.fileType === 'sub' && f.type === 'fits' && !f.isThumbnail)
    .sort((a, b) => (a.timestamp ?? a.name).localeCompare(b.timestamp ?? b.name));

  const frames: FrameAnalysisRow[] = files.map(f => {
    let metrics: FrameMetrics | null = null;
    try {
      const file = statLibraryFile(f.path);
      metrics = readStored(f.path, file.size, file.mtimeMs);
    } catch {
      // A file that cannot be read has nothing to show; it stays unmeasured and the measure call explains why.
    }
    return { path: f.path, name: f.name, timestamp: f.timestamp, thumbUrl: f.thumbUrl ?? null, downloadUrl: f.downloadUrl, file: f, metrics, verdict: null, review: null, kept: true };
  });

  const measuredRows = frames.filter(r => r.metrics !== null);
  const history = otherNightsMetrics(objectIds, new Set(frames.map(f => f.path)));
  // Frames are only comparable through the same filter for the same time: a D2 frame brings far less light than
  // a D1 one, a 60 s frame less than a 180 s one, and judged together the weaker set would read as clouded.
  const groups = new Map<string, FrameAnalysisRow[]>();
  for (const row of measuredRows) {
    const key = setKey(row.file.filter, row.file.exposure, row.metrics!);
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }
  let reference: FrameReference | null = null;
  let largest = 0;
  for (const rows of groups.values()) {
    const key = setKey(rows[0].file.filter, rows[0].file.exposure, rows[0].metrics!);
    const ranked = rankFrames(rows.flatMap(r => (r.metrics ? [r.metrics] : [])), history.get(key) ?? []);
    rows.forEach((row, i) => { row.verdict = ranked.verdicts[i]; });
    // The summary line describes the night's main set.
    if (rows.length > largest) { largest = rows.length; reference = ranked.reference; }
  }
  const reviews = readReviews(frames.map(r => r.path));
  for (const row of frames) {
    row.review = reviews.get(row.path) ?? null;
    row.kept = isFrameKept(row.review, row.verdict);
  }

  return { objectId: objectIds[0] ?? '', date, frames, reference, measured: measuredRows.length, total: frames.length };
}
