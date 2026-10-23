/**
 * Plan vs actual: what a planned imaging block actually produced.
 *
 * Planned blocks (plannedSessions) and captured frames (the library) used to
 * live side by side without ever meeting: once a night was over the timeline
 * kept showing the plan with no outcome. This module matches a past block
 * against the light sub-frames of its object and reports
 *
 *   status:      upcoming | in_progress | awaiting_import | done | partial | missed | skipped
 *   achievedSec: summed exposure of the matched subs
 *   frames:      how many subs matched
 *
 * ── Matching ────────────────────────────────────────────────────────────────
 * A block's object id is a catalog id (what the Planner schedules); the
 * library may hold it under that id, or under a folder id whose `catalogId` is
 * it (mosaics and variants included). Subs are attributed to a block like so:
 *
 *   - The block's observing night is computed in the observer's time zone.
 *   - When the object has a single block that night, every sub of that object
 *     on that night counts. The plan's question is "did I image it that
 *     night", and this survives capture software writing UTC or local times.
 *   - When the object has several blocks that night (split sessions), subs are
 *     split by capture time: a sub counts for a block if it started within
 *     [start − 15 min, end + 15 min]. Subs with no capture time are ignored.
 *
 * Nothing here is persisted except the user's own "skipped" mark: outcomes are
 * computed on read, so a late import or a reclassification is reflected the
 * next time the planner loads. FITS headers are cached per file (size + mtime)
 * so repeated reads only stat files.
 */
import fs from 'fs';
import path from 'path';
import db from './db.js';
import { getLibraryDir } from './libraryPath.js';
import { parseFitsHeader } from './fitsParser.js';
import { parseFilename, FITS_EXTENSIONS, OBSERVING_NIGHT_ROLLOVER_HOUR } from './telescopeFiles.js';
import { addDaysToDateKey, localDateKey, localParts, zonedDateTimeToUtc } from './timezone.js';
import { getLibraryFilesForObject, resolverFor } from './library/libraryFiles.js';
import { listObjectFiles, getObjectLayout } from './library/libraryLayout.js';
import { resolveLibraryFile } from './library/fileResolver.js';
import type { PlannedSession } from './plannedSessions.js';

/** `awaiting_import`: the block has ended but nothing of it is in the library yet, within AWAITING_IMPORT_MS. The
 *  telescope usually syncs hours later, so calling it "missed" straight away would be wrong. */
export type PlanOutcomeStatus = 'upcoming' | 'in_progress' | 'awaiting_import' | 'done' | 'partial' | 'missed' | 'skipped';

export interface PlanOutcome {
  status: PlanOutcomeStatus;
  /** Planned duration of the block, seconds. */
  plannedSec: number;
  /** Summed exposure of the matched subs, seconds (0 for upcoming). */
  achievedSec: number;
  frames: number;
}

/** Achieved / planned at or above this counts as done. Below 1 because a
 *  block's wall-clock time includes downloads, dithering and refocusing. */
export const DONE_RATIO = 0.75;
/** Slack around a block when splitting subs between several blocks. */
/** How long after a block ends an empty result is still "awaiting import" rather than "missed". */
export const AWAITING_IMPORT_MS = 24 * 3_600_000;
export const MATCH_TOLERANCE_MS = 15 * 60_000;
/** Used when a sub carries no EXPTIME/EXPOSURE. Same default as the library stats. */
export const DEFAULT_EXPOSURE_SEC = 10;

const HEADER_READ_BYTES = 2880 * 10;

// ─── Library side ────────────────────────────────────────────────────────────

interface SubFrame {
  /** Observing night, YYYY-MM-DD, or null when the sub has no capture date. */
  night: string | null;
  /** Capture instant, or null when the sub has no capture time. */
  at: number | null;
  exposureSec: number;
}

const objectStmts = {
  byCatalog: db.prepare<[string, string], { objectId: string; folderName: string }>(
    'SELECT objectId, folderName FROM libraryObjects WHERE deleted = 0 AND (objectId = ? OR catalogId = ?)',
  ),
  deletedSessions: db.prepare<[string], { date: string }>('SELECT date FROM libraryDeletedSessions WHERE objectId = ?'),
};

const exposureCache = new Map<string, { size: number; mtimeMs: number; exposureSec: number | null }>();
const EXPOSURE_CACHE_MAX = 50_000;

function readExposure(absPath: string): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  const cached = exposureCache.get(absPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.exposureSec;

  let exposureSec: number | null = null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const header = parseFitsHeader(buf.subarray(0, n - (n % 80)));
    const raw = header.values['EXPTIME'] ?? header.values['EXPOSURE'];
    const num = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    exposureSec = Number.isFinite(num) && num > 0 ? num : null;
  } catch {
    exposureSec = null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  if (exposureCache.size >= EXPOSURE_CACHE_MAX) exposureCache.clear();
  exposureCache.set(absPath, { size: stat.size, mtimeMs: stat.mtimeMs, exposureSec });
  return exposureSec;
}

/** Local capture date + HHMMSS → instant, in the observer's zone. */
function captureInstant(date: string | null | undefined, hms: string | null | undefined, timeZone: string): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !hms || !/^\d{6}$/.test(hms)) return null;
  const t = zonedDateTimeToUtc(date, {
    hour: Number(hms.slice(0, 2)),
    minute: Number(hms.slice(2, 4)),
    second: Number(hms.slice(4, 6)),
  }, timeZone).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Observing night of a local capture date/time (rolls early-morning back). */
function nightOf(date: string | null | undefined, hms: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!hms || hms.length < 2) return date;
  const hour = Number(hms.slice(0, 2));
  return Number.isFinite(hour) && hour < OBSERVING_NIGHT_ROLLOVER_HOUR ? addDaysToDateKey(date, -1) : date;
}

/**
 * Light subs of every library object filed under `catalogId`, enumerated the
 * same way the observation cards count them: managed files walked off disk
 * (row when there is one, filename otherwise), linked files from their rows.
 */
function subFramesForCatalogId(catalogId: string, timeZone: string): SubFrame[] {
  const out: SubFrame[] = [];
  for (const { objectId, folderName } of objectStmts.byCatalog.all(catalogId, catalogId)) {
    const deleted = new Set(objectStmts.deletedSessions.all(objectId).map(r => r.date));
    const rowsByRel = new Map(getLibraryFilesForObject(objectId).map(r => [r.relPath, r]));
    const push = (abs: string, date: string | null | undefined, hms: string | null | undefined, override: string | null | undefined) => {
      const night = override ?? nightOf(date, hms);
      if (night && deleted.has(night)) return;
      out.push({
        night,
        at: captureInstant(date, hms, timeZone),
        exposureSec: readExposure(abs) ?? DEFAULT_EXPOSURE_SEC,
      });
    };

    const objDir = path.join(getLibraryDir(), folderName);
    if (fs.existsSync(objDir)) {
      const identity = resolverFor(objectId);
      for (const entry of listObjectFiles(objDir, getObjectLayout(objectId))) {
        if (!FITS_EXTENSIONS.has(path.extname(entry.fileName).toLowerCase())) continue;
        const parsed = parseFilename(entry.fileName);
        if (identity.role(entry.relPath) !== 'sub' && parsed.type !== 'sub') continue;
        const row = rowsByRel.get(`${folderName}/${entry.relPath}`);
        push(
          path.join(objDir, entry.relPath),
          row ? row.captureDate : parsed.date,
          row ? row.captureTime : parsed.timestamp?.slice(-6),
          row?.sessionDateOverride,
        );
      }
    }

    for (const row of rowsByRel.values()) {
      if (!row.sourceId || row.missingSince) continue;
      if (!FITS_EXTENSIONS.has(path.extname(row.fileName).toLowerCase())) continue;
      if (row.role !== 'sub' && parseFilename(row.fileName).type !== 'sub') continue;
      const resolved = resolveLibraryFile(row.relPath);
      if (!resolved) continue;
      push(resolved.abs, row.captureDate, row.captureTime, row.sessionDateOverride);
    }
  }
  return out;
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

/** Observing night (YYYY-MM-DD) an instant belongs to, in `timeZone`. */
export function observingNightOfInstant(at: Date, timeZone: string): string {
  const parts = localParts(at, timeZone);
  const day = localDateKey(at, timeZone);
  return parts.hour >= OBSERVING_NIGHT_ROLLOVER_HOUR ? day : addDaysToDateKey(day, -1);
}

export interface OutcomeOptions {
  now?: Date;
  /** IANA zone of the observer, for nights and capture times. */
  timeZone: string;
  /** Ids the user marked as skipped. */
  skippedIds?: ReadonlySet<number>;
}

/**
 * Outcome for each session, keyed by id. Library reads happen once per
 * object, only for blocks that have started.
 */
export function computePlanOutcomes(sessions: readonly PlannedSession[], opts: OutcomeOptions): Map<number, PlanOutcome> {
  const now = (opts.now ?? new Date()).getTime();
  const result = new Map<number, PlanOutcome>();

  // How many blocks each object has per night, across the sessions given.
  const nightKey = (s: PlannedSession) => `${s.objectId}\u0000${observingNightOfInstant(new Date(s.startTime), opts.timeZone)}`;
  const blocksPerNight = new Map<string, number>();
  for (const s of sessions) blocksPerNight.set(nightKey(s), (blocksPerNight.get(nightKey(s)) ?? 0) + 1);

  const framesByObject = new Map<string, SubFrame[]>();
  const framesFor = (objectId: string) => {
    let f = framesByObject.get(objectId);
    if (!f) {
      f = subFramesForCatalogId(objectId, opts.timeZone);
      framesByObject.set(objectId, f);
    }
    return f;
  };

  for (const s of sessions) {
    const start = Date.parse(s.startTime);
    const end = Date.parse(s.endTime);
    const plannedSec = Math.max(0, Math.round((end - start) / 1000));

    if (start > now) {
      result.set(s.id, { status: opts.skippedIds?.has(s.id) ? 'skipped' : 'upcoming', plannedSec, achievedSec: 0, frames: 0 });
      continue;
    }

    const night = observingNightOfInstant(new Date(start), opts.timeZone);
    const shared = (blocksPerNight.get(nightKey(s)) ?? 1) > 1;
    let frames = 0;
    let exposure = 0;
    for (const f of framesFor(s.objectId)) {
      if (shared) {
        if (f.at === null || f.at < start - MATCH_TOLERANCE_MS || f.at > end + MATCH_TOLERANCE_MS) continue;
      } else if (f.night !== night) {
        continue;
      }
      frames++;
      exposure += f.exposureSec;
    }
    const achievedSec = Math.round(exposure);

    let status: PlanOutcomeStatus;
    if (opts.skippedIds?.has(s.id)) status = 'skipped';
    else if (end > now) status = 'in_progress';
    else if (plannedSec > 0 && achievedSec >= plannedSec * DONE_RATIO) status = 'done';
    else if (frames > 0) status = 'partial';
    else if (now - end < AWAITING_IMPORT_MS) status = 'awaiting_import';
    else status = 'missed';

    result.set(s.id, { status, plannedSec, achievedSec, frames });
  }
  return result;
}

// ─── Per-night summary (Observations page) ──────────────────────────────────

export interface PlanNightSummary {
  /** Observing night, YYYY-MM-DD, in the observer's zone. */
  night: string;
  /** The catalog id the blocks were planned under. */
  objectId: string;
  objectName: string;
  /** Library object ids holding that catalog id, so a client can match the
   *  summary to its observation cards (which use library ids). */
  libraryObjectIds: string[];
  blocks: number;
  plannedSec: number;
  achievedSec: number;
  frames: number;
  status: PlanOutcomeStatus;
}

function aggregateStatus(statuses: PlanOutcomeStatus[], plannedSec: number, achievedSec: number, frames: number): PlanOutcomeStatus {
  if (statuses.every(s => s === 'skipped')) return 'skipped';
  const live = statuses.filter(s => s !== 'skipped');
  if (live.every(s => s === 'upcoming')) return 'upcoming';
  if (live.some(s => s === 'in_progress' || s === 'upcoming')) return 'in_progress';
  if (frames === 0 && live.some(s => s === 'awaiting_import')) return 'awaiting_import';
  if (plannedSec > 0 && achievedSec >= plannedSec * DONE_RATIO) return 'done';
  return frames > 0 ? 'partial' : 'missed';
}

/**
 * Blocks grouped by (object, observing night), with their outcomes summed —
 * "planned 3 h, got 2 h 40" for an observation, or a missed plan on a night
 * with nothing imaged. Skipped blocks don't count toward planned time unless
 * every block of the group is skipped.
 */
export function summarizePlanByNight(
  sessions: readonly PlannedSession[],
  outcomes: ReadonlyMap<number, PlanOutcome>,
  timeZone: string,
): PlanNightSummary[] {
  const groups = new Map<string, { s: PlannedSession; o: PlanOutcome }[]>();
  for (const s of sessions) {
    const o = outcomes.get(s.id);
    if (!o) continue;
    const key = `${s.objectId}\u0000${observingNightOfInstant(new Date(s.startTime), timeZone)}`;
    const g = groups.get(key);
    if (g) g.push({ s, o });
    else groups.set(key, [{ s, o }]);
  }

  const out: PlanNightSummary[] = [];
  for (const [key, items] of groups) {
    const [objectId, night] = key.split('\u0000');
    const counted = items.every(i => i.o.status === 'skipped') ? items : items.filter(i => i.o.status !== 'skipped');
    const plannedSec = counted.reduce((n, i) => n + i.o.plannedSec, 0);
    const achievedSec = counted.reduce((n, i) => n + i.o.achievedSec, 0);
    const frames = counted.reduce((n, i) => n + i.o.frames, 0);
    out.push({
      night,
      objectId,
      objectName: items[0].s.objectName,
      libraryObjectIds: [...new Set(objectStmts.byCatalog.all(objectId, objectId).map(r => r.objectId))],
      blocks: items.length,
      plannedSec,
      achievedSec,
      frames,
      status: aggregateStatus(items.map(i => i.o.status), plannedSec, achievedSec, frames),
    });
  }
  return out.sort((a, b) => a.night.localeCompare(b.night) || a.objectId.localeCompare(b.objectId));
}
