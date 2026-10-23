/**
 * Library — integration per filter, and per-filter integration goals.
 *
 * Multi-night campaigns are planned per filter ("10 h Ha, 6 h OIII"), but the
 * existing integration stats (`getLocalIntegrationStats`, the reports route)
 * sum exposure per night only and never group by the FITS `FILTER` keyword.
 * This module adds the missing axis:
 *
 *   object → filter → night  (frames, exposure seconds)
 *
 * plus a goal per filter, so the object page can show done / goal.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────
 * The authority on which files belong to an object, and to which night, is the
 * `libraryFiles` table (`role = 'sub'`), resolved through `fileResolver` so
 * linked-folder files (`@src/<id>/…`) count the same as managed ones. For each
 * sub, the FITS header gives FILTER and EXPTIME. Fallbacks, in order:
 *
 *   filter:   FITS FILTER → the night's `captureInfo.filter` when every
 *             capture run that night agrees → "no filter" bucket ('')
 *   exposure: FITS EXPTIME / EXPOSURE → the night's `captureInfo.exposureSec`
 *             when unambiguous → DEFAULT_EXPOSURE_SEC (same default the
 *             existing stats use)
 *
 * Headers are read up to MAX_HEADER_BLOCKS blocks (not just the first 2880
 * bytes) because capture software that writes many cards can push FILTER past
 * the first block. Results are cached per file in `subFrameHeaderCache`,
 * invalidated by size/mtime, with the filter stored RAW so alias edits apply
 * immediately without re-reading anything.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { parseFitsHeader } from '../fitsParser.js';
import { getLibraryFilesForObject, sessionDateForRow, resolverFor } from './libraryFiles.js';
import { listObjectFiles, getObjectLayout } from './libraryLayout.js';
import { getLibraryDir } from '../libraryPath.js';
import { parseFilename, FITS_EXTENSIONS } from '../telescopeFiles.js';
import { resolveLibraryFile } from './fileResolver.js';
import { getCaptureInfoForObject } from './captureInfo.js';

/** FITS headers are 2880-byte blocks; 10 blocks = 360 cards, far beyond any
 *  capture app's header, while keeping a single bounded read per file. */
export const MAX_HEADER_BLOCKS = 10;
const FITS_BLOCK = 2880;

/** Used when neither the header nor the capture sidecar gives an exposure —
 *  kept identical to the existing integration stats so totals agree. */
export const DEFAULT_EXPOSURE_SEC = 10;

/** Upper bound for a goal: 1000 hours. Anything above is a typo. */
export const MAX_GOAL_SEC = 1000 * 3600;
/** Filter names are short labels; this only stops abuse. */
export const MAX_FILTER_NAME_LENGTH = 64;

/** The "no filter" bucket: OSC cameras without a wheel, or frames whose header
 *  and sidecar carry no filter at all. Stored as '' in the database; exposed
 *  as `null` by the API. */
export const NO_FILTER = '';

// ─── Filter names ────────────────────────────────────────────────────────────

/** Built-in aliases, matched on a key with case, spaces, hyphens and
 *  underscores removed. Deliberately conservative: only spellings that cannot
 *  mean two different filters. Bandwidth variants ("Ha 3nm" vs "Ha 7nm") are
 *  left alone on purpose — merging them is the user's call, via a user alias. */
const BUILTIN_ALIASES: Record<string, string> = {
  ha: 'Ha', halpha: 'Ha', 'hα': 'Ha', hydrogenalpha: 'Ha',
  hb: 'Hb', hbeta: 'Hb', 'hβ': 'Hb',
  oiii: 'OIII', o3: 'OIII',
  sii: 'SII', s2: 'SII',
  l: 'L', lum: 'L', luminance: 'L',
  r: 'R', red: 'R',
  g: 'G', green: 'G',
  b: 'B', blue: 'B',
};

/** Raw values that mean "no filter". */
const NO_FILTER_KEYS = new Set(['', 'none', 'nofilter', 'na', 'n/a', 'null']);

function aliasKey(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]+/g, '');
}

/** Collapse whitespace and trim, without changing case. */
function cleanFilterName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Canonical filter name for a raw FITS/sidecar value, or NO_FILTER.
 * User aliases win over built-ins; unknown names come back cleaned but
 * otherwise as written.
 */
export function normalizeFilterName(
  raw: string | null | undefined,
  userAliases: ReadonlyMap<string, string> = new Map(),
): string {
  if (raw === null || raw === undefined) return NO_FILTER;
  const cleaned = cleanFilterName(String(raw));
  const key = aliasKey(cleaned);
  if (NO_FILTER_KEYS.has(key)) return NO_FILTER;

  const user = userAliases.get(cleaned.toLowerCase());
  if (user !== undefined) return cleanFilterName(user);

  return BUILTIN_ALIASES[key] ?? cleaned;
}

export interface FilterAlias {
  alias: string;
  canonical: string;
}

const aliasStmts = {
  all: db.prepare<[], FilterAlias>('SELECT alias, canonical FROM filterAliases ORDER BY alias COLLATE NOCASE'),
  clear: db.prepare('DELETE FROM filterAliases'),
  insert: db.prepare('INSERT OR REPLACE INTO filterAliases (alias, canonical) VALUES (?, ?)'),
};

export function getFilterAliases(): FilterAlias[] {
  return aliasStmts.all.all();
}

/** Lower-cased alias → canonical, the shape normalizeFilterName expects. */
export function getFilterAliasMap(): Map<string, string> {
  return new Map(getFilterAliases().map(a => [a.alias.toLowerCase(), a.canonical]));
}

/** Replace the whole alias list. Entries are cleaned; empty or self-mapping
 *  entries are dropped. Throws on names over MAX_FILTER_NAME_LENGTH. */
export function setFilterAliases(aliases: FilterAlias[]): FilterAlias[] {
  const cleaned: FilterAlias[] = [];
  for (const a of aliases) {
    const alias = cleanFilterName(a.alias);
    const canonical = cleanFilterName(a.canonical);
    if (!alias || !canonical) continue;
    if (alias.length > MAX_FILTER_NAME_LENGTH || canonical.length > MAX_FILTER_NAME_LENGTH) {
      throw new RangeError(`Filter names are limited to ${MAX_FILTER_NAME_LENGTH} characters`);
    }
    if (alias.toLowerCase() === canonical.toLowerCase()) continue;
    cleaned.push({ alias, canonical });
  }
  db.transaction(() => {
    aliasStmts.clear.run();
    for (const a of cleaned) aliasStmts.insert.run(a.alias, a.canonical);
  })();
  invalidateIntegrationProgress();
  return getFilterAliases();
}

// ─── Header reading + cache ──────────────────────────────────────────────────

export interface SubFrameHeaderValues {
  rawFilter: string | null;
  exposureSec: number | null;
}

/** Read FILTER and exposure from a FITS file, across up to MAX_HEADER_BLOCKS
 *  header blocks. Returns null when the file can't be read. */
export function readSubFrameHeader(absPath: string): SubFrameHeaderValues | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(FITS_BLOCK * MAX_HEADER_BLOCKS);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    // Only whole cards: parseFitsHeader bails on a short tail, and a file
    // shorter than one block is not a FITS file worth counting.
    if (bytesRead < FITS_BLOCK) return null;
    const header = parseFitsHeader(buf.subarray(0, bytesRead - (bytesRead % 80)));
    const filter = header.values['FILTER'];
    const exp = header.values['EXPTIME'] ?? header.values['EXPOSURE'];
    const expNum = typeof exp === 'number' ? exp : Number.parseFloat(String(exp ?? ''));
    return {
      rawFilter: filter === undefined || filter === null ? null : String(filter),
      exposureSec: Number.isFinite(expNum) && expNum > 0 ? expNum : null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

interface HeaderCacheRow extends SubFrameHeaderValues {
  relPath: string;
  bytes: number;
  mtimeMs: number;
}

const cacheStmts = {
  get: db.prepare<[string], HeaderCacheRow>(
    'SELECT relPath, bytes, mtimeMs, rawFilter, exposureSec FROM subFrameHeaderCache WHERE relPath = ?',
  ),
  put: db.prepare(
    `INSERT OR REPLACE INTO subFrameHeaderCache (relPath, bytes, mtimeMs, rawFilter, exposureSec, cachedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ),
};

/** Header values for a library file, from the cache when size and mtime still
 *  match, otherwise read from disk and cached. Null when the file is gone or
 *  unreadable. */
export function getSubFrameHeader(relPath: string): SubFrameHeaderValues | null {
  const resolved = resolveLibraryFile(relPath);
  if (!resolved) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.abs);
  } catch {
    return null;
  }
  const mtimeMs = Math.floor(stat.mtimeMs);
  const cached = cacheStmts.get.get(relPath);
  if (cached && cached.bytes === stat.size && cached.mtimeMs === mtimeMs) {
    return { rawFilter: cached.rawFilter, exposureSec: cached.exposureSec };
  }
  const values = readSubFrameHeader(resolved.abs);
  if (!values) return null;
  cacheStmts.put.run(relPath, stat.size, mtimeMs, values.rawFilter, values.exposureSec, new Date().toISOString());
  return values;
}

// ─── Goals ───────────────────────────────────────────────────────────────────

export interface IntegrationGoal {
  /** Canonical filter name, or null for the "no filter" bucket. */
  filter: string | null;
  goalSec: number;
}

const goalStmts = {
  forObject: db.prepare<[string], { filter: string; goalSec: number }>(
    'SELECT filter, goalSec FROM objectIntegrationGoals WHERE objectId = ? ORDER BY filter',
  ),
  clear: db.prepare('DELETE FROM objectIntegrationGoals WHERE objectId = ?'),
  insert: db.prepare(
    'INSERT OR REPLACE INTO objectIntegrationGoals (objectId, filter, goalSec, updatedAt) VALUES (?, ?, ?, ?)',
  ),
};

export function getIntegrationGoals(objectId: string): IntegrationGoal[] {
  return goalStmts.forObject.all(objectId).map(r => ({
    filter: r.filter === NO_FILTER ? null : r.filter,
    goalSec: r.goalSec,
  }));
}

/**
 * Replace every goal on an object. Filter names go through the same
 * normalisation as frames, so a goal set on "H-alpha" lands on "Ha". A goal of
 * 0 removes that filter's goal. Throws RangeError on invalid input.
 */
export function setIntegrationGoals(objectId: string, goals: IntegrationGoal[]): IntegrationGoal[] {
  const aliases = getFilterAliasMap();
  const byFilter = new Map<string, number>();
  for (const g of goals) {
    if (g.filter !== null && String(g.filter).length > MAX_FILTER_NAME_LENGTH) {
      throw new RangeError(`Filter names are limited to ${MAX_FILTER_NAME_LENGTH} characters`);
    }
    if (!Number.isFinite(g.goalSec) || g.goalSec < 0 || g.goalSec > MAX_GOAL_SEC) {
      throw new RangeError(`goalSec must be between 0 and ${MAX_GOAL_SEC}`);
    }
    const filter = normalizeFilterName(g.filter, aliases);
    const sec = Math.round(g.goalSec);
    if (sec === 0) byFilter.delete(filter);
    else byFilter.set(filter, sec);
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    goalStmts.clear.run(objectId);
    for (const [filter, sec] of byFilter) goalStmts.insert.run(objectId, filter, sec, now);
  })();
  invalidateIntegrationProgress();
  return getIntegrationGoals(objectId);
}

// ─── Breakdown ───────────────────────────────────────────────────────────────

export interface NightIntegration {
  /** Observing night (YYYY-MM-DD), or 'unknown' for subs with no capture date. */
  date: string;
  frames: number;
  exposureSec: number;
}

export interface FilterIntegration {
  /** Canonical filter name, or null for the "no filter" bucket. */
  filter: string | null;
  frames: number;
  exposureSec: number;
  /** Goal for this filter, or null when none is set. */
  goalSec: number | null;
  nights: NightIntegration[];
}

export interface IntegrationBreakdown {
  objectId: string;
  totalFrames: number;
  totalExposureSec: number;
  /** Subs listed in the library but unreadable right now (missing linked
   *  file, permission error). Not counted in the totals. */
  unreadableFrames: number;
  /** Filters with frames, then filters that only have a goal; each group
   *  sorted by name with the "no filter" bucket last. */
  filters: FilterIntegration[];
}

function isFits(fileName: string): boolean {
  return FITS_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

const objectStmts = {
  folder: db.prepare<[string], { folderName: string }>('SELECT folderName FROM libraryObjects WHERE objectId = ?'),
  deletedSessions: db.prepare<[string], { date: string }>('SELECT date FROM libraryDeletedSessions WHERE objectId = ?'),
};

interface SubFrameRef {
  /** Library-relative path (`<folder>/…` or `@src/<id>/…`), as fileResolver expects. */
  relPath: string;
  night: string;
}

/**
 * The light subs of an object, enumerated exactly like the observation cards
 * count them (getLocalObservations): managed files are walked off disk and
 * attributed through resolverFor (libraryFiles row when there is one, else
 * the filename), linked files come from their libraryFiles rows. Reading only
 * libraryFiles would miss managed subs that have no row (objects imported
 * before the per-file table, or files dropped in by hand), which made the
 * integration total disagree with the object's sub-frame count.
 */
function listSubFrames(objectId: string): SubFrameRef[] {
  const deleted = new Set(objectStmts.deletedSessions.all(objectId).map(r => r.date));
  const out: SubFrameRef[] = [];
  const keep = (relPath: string, night: string | null) => {
    const n = night ?? 'unknown';
    if (!deleted.has(n)) out.push({ relPath, night: n });
  };

  const folderName = objectStmts.folder.get(objectId)?.folderName;
  if (folderName) {
    const objDir = path.join(getLibraryDir(), folderName);
    if (fs.existsSync(objDir)) {
      const identity = resolverFor(objectId);
      for (const entry of listObjectFiles(objDir, getObjectLayout(objectId))) {
        if (!isFits(entry.fileName)) continue;
        const isSub = identity.role(entry.relPath) === 'sub' || parseFilename(entry.fileName).type === 'sub';
        if (!isSub) continue;
        keep(`${folderName}/${entry.relPath}`, identity.session(entry.relPath));
      }
    }
  }

  for (const row of getLibraryFilesForObject(objectId)) {
    if (!row.sourceId || row.missingSince || !isFits(row.fileName)) continue;
    if (row.role !== 'sub' && parseFilename(row.fileName).type !== 'sub') continue;
    keep(row.relPath, sessionDateForRow(row));
  }
  return out;
}

/** A capture-sidecar value for a night, only when every run that night agrees. */
function unanimous<T>(values: (T | null)[]): T | null {
  const present = values.filter((v): v is T => v !== null && v !== undefined);
  if (present.length === 0) return null;
  return present.every(v => v === present[0]) ? present[0] : null;
}

function compareFilters(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

export function getIntegrationBreakdown(objectId: string): IntegrationBreakdown {
  const aliases = getFilterAliasMap();

  // Night-level fallbacks from capture sidecars (Dwarf/SeeStar shotsInfo etc.)
  const captureByNight = new Map<string, { filter: string | null; exposureSec: number | null }>();
  {
    const grouped = new Map<string, { filters: (string | null)[]; exposures: (number | null)[] }>();
    for (const row of getCaptureInfoForObject(objectId)) {
      if (!row.sessionDate) continue;
      const g = grouped.get(row.sessionDate) ?? { filters: [], exposures: [] };
      g.filters.push(row.filter);
      g.exposures.push(row.exposureSec);
      grouped.set(row.sessionDate, g);
    }
    for (const [date, g] of grouped) {
      captureByNight.set(date, { filter: unanimous(g.filters), exposureSec: unanimous(g.exposures) });
    }
  }

  const byFilter = new Map<string, Map<string, NightIntegration>>();
  let totalFrames = 0;
  let totalExposureSec = 0;
  let unreadableFrames = 0;

  for (const { relPath, night } of listSubFrames(objectId)) {
    const header = getSubFrameHeader(relPath);
    if (!header) {
      unreadableFrames++;
      continue;
    }
    const capture = captureByNight.get(night);

    const filter = normalizeFilterName(header.rawFilter ?? capture?.filter ?? null, aliases);
    const exposureSec = header.exposureSec ?? capture?.exposureSec ?? DEFAULT_EXPOSURE_SEC;

    let nights = byFilter.get(filter);
    if (!nights) {
      nights = new Map();
      byFilter.set(filter, nights);
    }
    const n = nights.get(night) ?? { date: night, frames: 0, exposureSec: 0 };
    n.frames++;
    n.exposureSec += exposureSec;
    nights.set(night, n);

    totalFrames++;
    totalExposureSec += exposureSec;
  }

  const goals = new Map(getIntegrationGoals(objectId).map(g => [g.filter ?? NO_FILTER, g.goalSec]));

  const withFrames: FilterIntegration[] = [];
  for (const [filter, nights] of byFilter) {
    const nightList = [...nights.values()]
      .map(n => ({ ...n, exposureSec: Math.round(n.exposureSec) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    withFrames.push({
      filter: filter === NO_FILTER ? null : filter,
      frames: nightList.reduce((s, n) => s + n.frames, 0),
      exposureSec: nightList.reduce((s, n) => s + n.exposureSec, 0),
      goalSec: goals.get(filter) ?? null,
      nights: nightList,
    });
  }
  withFrames.sort((a, b) => compareFilters(a.filter, b.filter));

  const goalOnly: FilterIntegration[] = [];
  for (const [filter, goalSec] of goals) {
    if (byFilter.has(filter)) continue;
    goalOnly.push({ filter: filter === NO_FILTER ? null : filter, frames: 0, exposureSec: 0, goalSec, nights: [] });
  }
  goalOnly.sort((a, b) => compareFilters(a.filter, b.filter));

  return {
    objectId,
    totalFrames,
    totalExposureSec: Math.round(totalExposureSec),
    unreadableFrames,
    filters: [...withFrames, ...goalOnly],
  };
}

// ─── Remaining time across objects (Planner / Wishlist) ─────────────────────

export interface FilterRemaining {
  /** Canonical filter name, or null for the "no filter" bucket. */
  filter: string | null;
  goalSec: number;
  exposureSec: number;
  /** goalSec − exposureSec, floored at 0. */
  remainingSec: number;
}

export interface ObjectIntegrationProgress {
  objectId: string;
  /** Filters with a goal, in the same order as the breakdown. */
  filters: FilterRemaining[];
  /** True when every goal on the object is reached. */
  complete: boolean;
}

const goalObjectsStmt = db.prepare<[], { objectId: string }>(
  'SELECT DISTINCT objectId FROM objectIntegrationGoals ORDER BY objectId',
);

/**
 * Progress toward goals for every object that has at least one, for the
 * Planner and Wishlist ("4h left D2"). Objects without goals are left out, so
 * the list stays small. Header reads go through the per-file cache, so after
 * the first visit of each object this only stats files.
 */
/** Library, Planner and Wishlist all ask for this on load; the walk is synchronous disk work, so a short memo keeps
 *  a burst of page loads from repeating it. Goal and alias edits drop it at once. */
const PROGRESS_MEMO_MS = 30_000;
let progressMemo: { at: number; value: ObjectIntegrationProgress[] } | null = null;

export function invalidateIntegrationProgress(): void {
  progressMemo = null;
}

export function getIntegrationProgressForGoalObjects(): ObjectIntegrationProgress[] {
  if (progressMemo && Date.now() - progressMemo.at < PROGRESS_MEMO_MS) return progressMemo.value;
  const value = computeIntegrationProgressForGoalObjects();
  progressMemo = { at: Date.now(), value };
  return value;
}

function computeIntegrationProgressForGoalObjects(): ObjectIntegrationProgress[] {
  const out: ObjectIntegrationProgress[] = [];
  for (const { objectId } of goalObjectsStmt.all()) {
    const filters: FilterRemaining[] = getIntegrationBreakdown(objectId).filters
      .filter((f): f is FilterIntegration & { goalSec: number } => f.goalSec !== null)
      .map(f => ({
        filter: f.filter,
        goalSec: f.goalSec,
        exposureSec: f.exposureSec,
        remainingSec: Math.max(0, f.goalSec - f.exposureSec),
      }));
    if (filters.length === 0) continue;
    out.push({ objectId, filters, complete: filters.every(f => f.remainingSec === 0) });
  }
  return out;
}
