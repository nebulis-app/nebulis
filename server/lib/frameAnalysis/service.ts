/**
 * Sub-frame analysis for a library night: measure each raw FITS frame once (cached in `frameMetrics`), then rank
 * the frames of the night against each other. The measuring is in `measure.ts`, the judging in `ranking.ts`.
 */
import fs from 'fs';
import db from '../db.js';
import { resolveLibraryFile } from '../library/fileResolver.js';
import { getLocalFiles } from '../library/observations.js';
import { isRecord } from '../typeGuards.js';
import { FRAME_METRICS_VERSION, FrameDecodeError, type FrameMetrics } from './measure.js';
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
    metrics = await measureOffThread(file.abs);
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
  const { verdicts, reference } = rankFrames(measuredRows.flatMap(r => (r.metrics ? [r.metrics] : [])));
  measuredRows.forEach((row, i) => { row.verdict = verdicts[i]; });
  const reviews = readReviews(frames.map(r => r.path));
  for (const row of frames) {
    row.review = reviews.get(row.path) ?? null;
    row.kept = isFrameKept(row.review, row.verdict);
  }

  return { objectId: objectIds[0] ?? '', date, frames, reference, measured: measuredRows.length, total: frames.length };
}
