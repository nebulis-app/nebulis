/**
 * Capture info parsed from a device's own per-session sidecar.
 *
 * A Dwarf writes `shotsInfo.json` next to each session's frames:
 *
 *   {
 *     "DEC": 57.487057326572625,   ← degrees
 *     "RA": 21.65051251668246,     ← HOURS, not degrees
 *     "binning": "1*1",
 *     "exp": "60",                 ← seconds, as a string
 *     "format": "FITS",
 *     "gain": 60,
 *     "ir": "Duo-Band",            ← filter
 *     "maxTemp": 37, "minTemp": 31,
 *     "shotsStacked": 209, "shotsTaken": 215, "shotsToTake": 300,
 *     "target": "IC 1396"
 *   }
 *
 * This is the authoritative record of what the device actually did. Nebulis used
 * to throw all of it away and reconstruct a weaker version by parsing filenames
 * and FITS headers, which is why exposure and gain were guesses and integration
 * completeness ("209 kept of 300 planned") was not available at all.
 *
 * ── Why rows are keyed on the session folder, not the night ─────────────────
 * Two capture runs can land on one observing night with different settings. A
 * real library has C 5 shot at 60s/gain 60 at 21:54 and again at 120s/gain 40 at
 * 23:11 on the same evening. Keying on the night would force one of those to
 * overwrite the other, so the identity is (objectId, sessionFolder) and the
 * night is carried alongside for querying.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { log } from '../logger.js';
import { parseJsonRecord } from '../typeGuards.js';

/** Sidecar filenames this module knows how to read. `meta.json` is Nebulis's
 *  own field, documented as part of the Generic SMB Layout (Help page,
 *  Add Telescope modal) for custom SMB sources that have no vendor sidecar
 *  of their own. */
const KNOWN_SIDECARS = new Set(['shotsinfo.json', 'meta.json']);

export function isCaptureInfoSidecar(fileName: string): boolean {
  return KNOWN_SIDECARS.has(fileName.toLowerCase());
}

export interface CaptureInfo {
  objectId: string;
  sessionFolder: string;
  sessionDate: string | null;
  exposureSec: number | null;
  gain: number | null;
  filter: string | null;
  binning: string | null;
  framesStacked: number | null;
  framesTaken: number | null;
  framesPlanned: number | null;
  minTempC: number | null;
  maxTempC: number | null;
  /** RA in hours, as the device reports it. */
  raHours: number | null;
  decDeg: number | null;
  target: string | null;
  sourceRelPath: string | null;
}

/** Parsed shape of the sidecar, before it becomes a row. */
export interface ParsedCaptureInfo {
  exposureSec: number | null;
  gain: number | null;
  filter: string | null;
  binning: string | null;
  framesStacked: number | null;
  framesTaken: number | null;
  framesPlanned: number | null;
  minTempC: number | null;
  maxTempC: number | null;
  raHours: number | null;
  decDeg: number | null;
  target: string | null;
}

/** Read a number that the device may write as either a number or a string
 *  (`exp` is a string, `gain` is a number, and that is not guaranteed stable
 *  across firmware). Returns null for anything not finite. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * `meta.json` — Nebulis's own generic sidecar, not a device vendor's. Field
 * names already match ParsedCaptureInfo's units, so there is no RA-in-hours
 * style ambiguity to resolve like shotsInfo.json needs below.
 *
 * `frameCount` and `integrationSec` are both optional and either can be given
 * alone. When only the total is known, a synthetic per-frame `exposureSec` is
 * derived (`integrationSec / frameCount`, or `integrationSec` itself with a
 * frame count of 1) so the existing `exposureSec * framesStacked` total
 * (summarizeSessionCapture) reproduces the documented integrationSec without
 * a schema change.
 */
function parseGenericMeta(o: Record<string, unknown>): ParsedCaptureInfo {
  const exposureSecGiven = num(o.exposureSec);
  const frameCount = int(o.frameCount);
  const integrationSec = num(o.integrationSec);
  const exposureSec = exposureSecGiven
    ?? (integrationSec !== null && frameCount ? integrationSec / frameCount : integrationSec);
  const framesStacked = frameCount ?? (integrationSec !== null ? 1 : null);

  return {
    exposureSec,
    gain: int(o.gain),
    filter: str(o.filter),
    binning: null,
    framesStacked,
    framesTaken: null,
    framesPlanned: null,
    minTempC: null,
    maxTempC: null,
    raHours: null,
    decDeg: null,
    target: null,
  };
}

/**
 * Parse sidecar JSON text. Returns null when the text is not an object at all;
 * individual missing or malformed fields become null rather than failing the
 * whole parse, because a partially-readable record is still worth keeping.
 *
 * `fileName` picks the field-name mapping: Nebulis's own `meta.json` versus a
 * Dwarf's `shotsInfo.json`. Omit it (or pass any other known sidecar name) to
 * get the shotsInfo.json mapping, the original and still most common case.
 */
export function parseCaptureInfo(text: string, fileName?: string): ParsedCaptureInfo | null {
  // Sidecar JSON written by the telescope (or, for meta.json, by the user or
  // their own tooling), so treat it as untrusted: the helper rejects bad
  // JSON, arrays, and non-objects in one step, and every field below is
  // still coerced individually by num()/int()/str().
  const o = parseJsonRecord(text);
  if (!o) return null;

  const parsed = fileName?.toLowerCase() === 'meta.json'
    ? parseGenericMeta(o)
    : {
        exposureSec: num(o.exp),
        gain: int(o.gain),
        // `ir` is the filter/IR-cut selection ("Astro", "Duo-Band", "IRCut").
        filter: str(o.ir),
        binning: str(o.binning),
        framesStacked: int(o.shotsStacked),
        framesTaken: int(o.shotsTaken),
        framesPlanned: int(o.shotsToTake),
        minTempC: num(o.minTemp),
        maxTempC: num(o.maxTemp),
        raHours: num(o.RA),
        decDeg: num(o.DEC),
        target: str(o.target),
      };

  // Require at least one field to have landed. An empty object, or JSON that
  // happens to be an object of unrelated keys, should not produce a row.
  const hasAny = Object.values(parsed).some(v => v !== null);
  return hasAny ? parsed : null;
}

const upsertStmt = db.prepare(
  `INSERT INTO captureInfo
     (objectId, sessionFolder, sessionDate, exposureSec, gain, filter, binning,
      framesStacked, framesTaken, framesPlanned, minTempC, maxTempC,
      raHours, decDeg, target, sourceRelPath, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(objectId, sessionFolder) DO UPDATE SET
     sessionDate = excluded.sessionDate,
     exposureSec = excluded.exposureSec,
     gain = excluded.gain,
     filter = excluded.filter,
     binning = excluded.binning,
     -- Frame counts move as a session progresses (a later sync sees more
     -- stacked frames), so the newest read wins rather than first-write.
     framesStacked = excluded.framesStacked,
     framesTaken = excluded.framesTaken,
     framesPlanned = excluded.framesPlanned,
     minTempC = excluded.minTempC,
     maxTempC = excluded.maxTempC,
     raHours = excluded.raHours,
     decDeg = excluded.decDeg,
     target = excluded.target,
     sourceRelPath = excluded.sourceRelPath,
     updatedAt = excluded.updatedAt`,
);

export function captureInfoSessionKey(
  relPath: string,
  sessionFolder: string,
  sessionDate: string | null,
): string {
  if (sessionFolder) return sessionFolder;
  const baseName = path.posix.basename(relPath.replace(/\\/g, '/'));
  const date = sessionDate ?? 'unknown-date';
  return `flat:${date}:${baseName}`;
}

export function saveCaptureInfo(info: CaptureInfo): void {
  upsertStmt.run(
    info.objectId, info.sessionFolder, info.sessionDate,
    info.exposureSec, info.gain, info.filter, info.binning,
    info.framesStacked, info.framesTaken, info.framesPlanned,
    info.minTempC, info.maxTempC, info.raHours, info.decDeg,
    info.target, info.sourceRelPath, new Date().toISOString(),
  );
}

/**
 * Read a sidecar off disk and record it.
 *
 * `relPath` is library-relative (`<folder>/<session>/shotsInfo.json`). Failure
 * is logged and swallowed: capture info is enrichment, and an unreadable
 * sidecar must never fail the import that already put the file on disk.
 */
export function ingestCaptureInfoFile(
  objectId: string,
  relPath: string,
  sessionFolder: string,
  sessionDate: string | null,
): boolean {
  const abs = path.join(getLibraryDir(), relPath);
  let text: string;
  try {
    // These are a few hundred bytes. A cap guards against a pathological file
    // being read wholesale into memory.
    const stat = fs.statSync(abs);
    if (stat.size > 512 * 1024) {
      log.warn({ objectId, relPath, bytes: stat.size }, '[captureInfo] sidecar too large, skipped');
      return false;
    }
    text = fs.readFileSync(abs, 'utf-8');
  } catch {
    return false;
  }

  const parsed = parseCaptureInfo(text, path.posix.basename(relPath.replace(/\\/g, '/')));
  if (!parsed) return false;

  saveCaptureInfo({
    objectId,
    sessionFolder: captureInfoSessionKey(relPath, sessionFolder, sessionDate),
    sessionDate,
    sourceRelPath: relPath,
    ...parsed,
  });
  return true;
}

export interface CaptureInfoRow extends CaptureInfo {
  id: number;
  updatedAt: string;
}

const byObjectStmt = db.prepare<[string], CaptureInfoRow>(
  'SELECT * FROM captureInfo WHERE objectId = ? ORDER BY sessionDate DESC, sessionFolder ASC',
);
const byObjectDateStmt = db.prepare<[string, string], CaptureInfoRow>(
  'SELECT * FROM captureInfo WHERE objectId = ? AND sessionDate = ? ORDER BY sessionFolder ASC',
);

export function getCaptureInfoForObject(objectId: string): CaptureInfoRow[] {
  return byObjectStmt.all(objectId);
}

/** Every capture run recorded for one observing night. Plural on purpose: a
 *  night can hold several runs at different exposure and gain. */
export function getCaptureInfoForSession(objectId: string, date: string): CaptureInfoRow[] {
  return byObjectDateStmt.all(objectId, date);
}

export function deleteCaptureInfoForObject(objectId: string): void {
  db.prepare('DELETE FROM captureInfo WHERE objectId = ?').run(objectId);
}

export function deleteCaptureInfoForSession(objectId: string, date: string): void {
  db.prepare('DELETE FROM captureInfo WHERE objectId = ? AND sessionDate = ?').run(objectId, date);
}

/**
 * Totals across a night's capture runs, for display.
 *
 * Integration time is summed per run (`exposureSec × framesStacked`) rather than
 * computed from a single exposure value, because runs on one night can use
 * different exposures. `exposureSec`/`gain`/`filter` are returned only when
 * every run agrees; otherwise null, which the UI should read as "mixed" rather
 * than as "unknown".
 */
export interface SessionCaptureSummary {
  runs: number;
  integrationSec: number | null;
  framesStacked: number | null;
  framesTaken: number | null;
  framesPlanned: number | null;
  exposureSec: number | null;
  gain: number | null;
  filter: string | null;
  minTempC: number | null;
  maxTempC: number | null;
}

export function summarizeSessionCapture(rows: readonly CaptureInfoRow[]): SessionCaptureSummary | null {
  if (rows.length === 0) return null;

  const sum = (pick: (r: CaptureInfoRow) => number | null): number | null => {
    const vals = rows.map(pick).filter((v): v is number => v !== null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const agreed = <T>(pick: (r: CaptureInfoRow) => T | null): T | null => {
    const vals = rows.map(pick).filter((v): v is T => v !== null);
    if (vals.length === 0) return null;
    return vals.every(v => v === vals[0]) ? vals[0] : null;
  };
  const minOf = (pick: (r: CaptureInfoRow) => number | null): number | null => {
    const vals = rows.map(pick).filter((v): v is number => v !== null);
    return vals.length > 0 ? Math.min(...vals) : null;
  };
  const maxOf = (pick: (r: CaptureInfoRow) => number | null): number | null => {
    const vals = rows.map(pick).filter((v): v is number => v !== null);
    return vals.length > 0 ? Math.max(...vals) : null;
  };

  const integrationSec = rows.reduce((total, r) => {
    if (r.exposureSec === null || r.framesStacked === null) return total;
    return total + r.exposureSec * r.framesStacked;
  }, 0);

  return {
    runs: rows.length,
    integrationSec: integrationSec > 0 ? integrationSec : null,
    framesStacked: sum(r => r.framesStacked),
    framesTaken: sum(r => r.framesTaken),
    framesPlanned: sum(r => r.framesPlanned),
    exposureSec: agreed(r => r.exposureSec),
    gain: agreed(r => r.gain),
    filter: agreed(r => r.filter),
    minTempC: minOf(r => r.minTempC),
    maxTempC: maxOf(r => r.maxTempC),
  };
}
