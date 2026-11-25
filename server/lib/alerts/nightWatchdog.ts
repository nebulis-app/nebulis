/**
 * The night watchdog: while a night is being imaged, it looks at the latest frames as they reach the library and
 * alerts when most of them show the same problem (soft focus, clouds, trailing, dew spots), then once more when
 * they are good again. You sleep; Nebulis watches. It needs no device control, only the telescope's automatic
 * import bringing the frames in during the night.
 *
 * Every few minutes, when some channel or phone subscribes to `night.watchdog`:
 *  1. tonight's sessions come from the import history (the sessions each import touched, dated tonight);
 *  2. their frames not measured yet are measured, a few dozen per pass, and never while an import holds the library;
 *  3. per comparison set (filter, exposure, camera, frame size), the latest frames are judged on the flags frame
 *     analysis already gives (ranking.ts);
 *  4. each destination gets a problem once per object, set, problem and night, and one "back to normal" after it.
 *
 * Frame analysis judges a frame against the night's typical frame, so a night that is bad from its very first
 * frame (focus off from the start) does not stand out against itself. That is a known limit.
 */
import db from '../db.js';
import { log } from '../logger.js';
import { activeSiteTimeZone } from '../siteTimeZone.js';
import { observingNightDateKey } from '../telescopeFiles.js';
import { currentLibraryWork } from '../libraryBusy.js';
import { buildSessionReport, measureLibraryFile, type FrameAnalysisRow } from '../frameAnalysis/service.js';
import type { FrameFlag, FrameReason } from '../frameAnalysis/ranking.js';
import { sendToChannel, sendToDevice, type DeliveryResult } from './delivery.js';
import { getAlertState, hasAlertListener, listAlertChannels, listAlertDevices, setAlertState } from './store.js';
import { WATCHDOG_PROBLEMS, type AlertEvent, type WatchdogAlertData, type WatchdogProblem } from './types.js';

/** The latest frames of a set that are judged, and how many of them must share a problem. */
export const WATCHDOG_WINDOW = 5;
export const WATCHDOG_NEEDED = 3;
/** Frames measured per pass, so a pass stays a minute or so even after hours without one. */
export const WATCHDOG_MEASURE_PER_PASS = 30;
/** Imports finished this long ago or less can bring tonight's sessions. */
const IMPORT_LOOKBACK_MS = 18 * 3600_000;
const TICK_MS = 5 * 60_000;
const RETRY_MS = 15 * 60_000;

// ─── Judging the latest frames ───────────────────────────────────────────────

/** One measured frame of tonight, as the watchdog needs it. */
export interface WatchFrame {
  name: string;
  /** Frames are compared only within a set taken the same way. */
  set: string;
  filter: string | null;
  flags: FrameFlag[];
  reasons: FrameReason[];
  /** Arcseconds per pixel, when the header gave the optics. */
  scale: number | null;
}

/** Where one problem stands in one set: most latest frames show it, none do, or in between. */
export interface WatchFinding {
  set: string;
  problem: WatchdogProblem;
  state: 'problem' | 'clear' | 'mixed';
  count: number;
  window: number;
  filter: string | null;
  lastFrame: string;
  value: number | null;
  typical: number | null;
  unit: WatchdogAlertData['unit'];
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** The measure behind a problem, over the frames that show it. */
function measureOf(problem: WatchdogProblem, flagged: WatchFrame[]): Pick<WatchFinding, 'value' | 'typical' | 'unit'> {
  const reasons = flagged.flatMap(f => f.reasons.map(r => ({ r, scale: f.scale })));
  switch (problem) {
    case 'soft': {
      const soft = reasons.flatMap(({ r, scale }) => (r.flag === 'soft' ? [{ fwhm: r.fwhm, typical: r.typical, scale }] : []));
      const scale = median(soft.flatMap(s => (s.scale !== null ? [s.scale] : [])));
      const k = scale ?? 1;
      const value = median(soft.map(s => s.fwhm));
      const typical = median(soft.map(s => s.typical));
      return { value: value !== null ? value * k : null, typical: typical !== null ? typical * k : null, unit: scale !== null ? 'arcsec' : 'px' };
    }
    case 'clouds':
      return { value: median(reasons.flatMap(({ r }) => (r.flag === 'clouds' ? [r.percentFewer] : []))), typical: null, unit: 'percent' };
    case 'trails':
      return { value: median(reasons.flatMap(({ r }) => (r.flag === 'trails' ? [r.ratio] : []))), typical: null, unit: 'ratio' };
    case 'spots':
      return { value: median(reasons.flatMap(({ r }) => (r.flag === 'spots' ? [r.count] : []))), typical: null, unit: 'count' };
  }
}

/**
 * Where each watched problem stands in each set, from its latest frames. `frames` are tonight's measured frames
 * in capture order. A set with fewer than `window` frames is not judged yet.
 */
export function evaluateFrames(frames: WatchFrame[], window = WATCHDOG_WINDOW, needed = WATCHDOG_NEEDED): WatchFinding[] {
  const bySet = new Map<string, WatchFrame[]>();
  for (const f of frames) bySet.set(f.set, [...(bySet.get(f.set) ?? []), f]);

  const findings: WatchFinding[] = [];
  for (const [set, all] of bySet) {
    if (all.length < window) continue;
    const latest = all.slice(-window);
    for (const problem of WATCHDOG_PROBLEMS) {
      const flagged = latest.filter(f => f.flags.includes(problem));
      const count = flagged.length;
      findings.push({
        set,
        problem,
        state: count >= needed ? 'problem' : count === 0 ? 'clear' : 'mixed',
        count,
        window,
        filter: latest[latest.length - 1].filter,
        lastFrame: latest[latest.length - 1].name,
        ...(count > 0 ? measureOf(problem, flagged) : { value: null, typical: null, unit: null }),
      });
    }
  }
  return findings;
}

// ─── Tonight's sessions and frames ───────────────────────────────────────────

export interface WatchedSession {
  objectId: string;
  objectName: string;
  findings: WatchFinding[];
}

export interface Tonight {
  night: string;
  sessions: WatchedSession[];
}

const recentImports = db.prepare<[string], { sessionsTouched: string | null }>(
  'SELECT sessionsTouched FROM importHistory WHERE finishedAt >= ? AND sessionsTouched IS NOT NULL',
);

/** Sessions dated tonight that an import touched recently. */
export function tonightSessions(now: Date, night: string): Array<{ objectId: string; objectName: string }> {
  const since = new Date(now.getTime() - IMPORT_LOOKBACK_MS).toISOString();
  const seen = new Map<string, { objectId: string; objectName: string }>();
  for (const row of recentImports.all(since)) {
    let entries: unknown;
    try {
      entries = JSON.parse(row.sessionsTouched ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (typeof e !== 'object' || e === null) continue;
      const { objectId, objectName, date } = e as Record<string, unknown>;
      if (typeof objectId !== 'string' || typeof date !== 'string' || date !== night) continue;
      seen.set(objectId, { objectId, objectName: typeof objectName === 'string' ? objectName : objectId });
    }
  }
  return [...seen.values()];
}

function watchFrame(row: FrameAnalysisRow): WatchFrame | null {
  if (!row.metrics || !row.verdict) return null;
  const m = row.metrics;
  return {
    name: row.name,
    set: [(row.file.filter ?? '').toLowerCase(), row.file.exposure ?? '', (m.rig.camera ?? '').toLowerCase(), `${m.width}x${m.height}`].join('|'),
    filter: row.file.filter ?? null,
    flags: row.verdict.flags,
    reasons: row.verdict.reasons,
    scale: m.rig.scale,
  };
}

/** Measures what tonight's sessions still lack, a few dozen frames per pass, newest first. */
async function measureMissing(objectIds: string[], night: string): Promise<void> {
  // An import or a library move holds the library: measuring then would slow it down. The next pass catches up.
  if (currentLibraryWork() !== null) return;
  let budget = WATCHDOG_MEASURE_PER_PASS;
  for (const objectId of objectIds) {
    const missing = buildSessionReport([objectId], night).frames.filter(r => r.metrics === null).reverse();
    for (const row of missing) {
      if (budget-- <= 0) return;
      try {
        await measureLibraryFile(row.path);
      } catch (err) {
        log.debug({ err: err instanceof Error ? err.message : String(err), file: row.path }, '[watchdog] frame not measured');
      }
    }
  }
}

/** Tonight as the watchdog sees it: each session with where its latest frames stand. */
export async function loadTonight(now: Date): Promise<Tonight> {
  const night = observingNightDateKey(now, activeSiteTimeZone());
  const sessions = tonightSessions(now, night);
  await measureMissing(sessions.map(s => s.objectId), night);
  return {
    night,
    sessions: sessions.map(s => {
      const frames = buildSessionReport([s.objectId], night).frames
        .map(watchFrame)
        .filter((f): f is WatchFrame => f !== null);
      return { ...s, findings: evaluateFrames(frames) };
    }),
  };
}

// ─── Sending ─────────────────────────────────────────────────────────────────

interface DestinationState {
  night: string;
  /** Per `objectId|set|problem`: alerted, then recovered (nothing more that night). */
  sent: Record<string, 'alerted' | 'recovered'>;
}

interface Destination {
  id: string;
  send: (event: AlertEvent) => Promise<DeliveryResult>;
}

const stateKey = (id: string) => `watchdog.${id}`;
const retryAfter = new Map<string, number>();

function destinations(): Destination[] {
  return [
    ...listAlertChannels().filter(c => c.enabled && c.events.includes('night.watchdog'))
      .map(c => ({ id: c.id, send: (e: AlertEvent) => sendToChannel(c, e) })),
    ...listAlertDevices().filter(d => d.enabled && d.events.includes('night.watchdog'))
      .map(d => ({ id: d.id, send: (e: AlertEvent) => sendToDevice(d, e) })),
  ];
}

/**
 * Sends what has come due: a problem not sent yet tonight, or "back to normal" after one. Returns how many
 * messages went out. `load` is replaceable so tests can hand in a night without frames on disk.
 */
export async function runNightWatchdog(now: Date, load: (now: Date) => Promise<Tonight> = loadTonight): Promise<number> {
  const targets = destinations();
  if (targets.length === 0) return 0;
  const tonight = await load(now);
  if (tonight.sessions.length === 0) return 0;

  let sent = 0;
  for (const dest of targets) {
    if ((retryAfter.get(dest.id) ?? 0) > now.getTime()) continue;
    const stored = getAlertState<DestinationState>(stateKey(dest.id));
    const state: DestinationState = stored && stored.night === tonight.night ? stored : { night: tonight.night, sent: {} };
    let failed = false;

    for (const session of tonight.sessions) {
      for (const f of session.findings) {
        const key = `${session.objectId}|${f.set}|${f.problem}`;
        const before = state.sent[key];
        const kind = f.state === 'problem' && before === undefined ? 'problem'
          : f.state === 'clear' && before === 'alerted' ? 'recovered'
            : null;
        if (!kind || failed) continue;
        const outcome = await dest.send({
          type: 'night.watchdog',
          occurredAt: now.toISOString(),
          data: {
            kind, problem: f.problem, objectId: session.objectId, objectName: session.objectName, night: tonight.night,
            window: f.window, count: f.count, filter: f.filter, lastFrame: f.lastFrame, value: f.value, typical: f.typical, unit: f.unit,
          },
        });
        if (outcome.ok) {
          state.sent[key] = kind === 'problem' ? 'alerted' : 'recovered';
          sent++;
        } else {
          failed = true;
        }
      }
    }
    setAlertState(stateKey(dest.id), state);
    if (failed) retryAfter.set(dest.id, now.getTime() + RETRY_MS);
    else retryAfter.delete(dest.id);
  }
  return sent;
}

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running || !hasAlertListener('night.watchdog')) return;
  running = true;
  try {
    await runNightWatchdog(new Date());
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] night watchdog check failed');
  } finally {
    running = false;
  }
}

export function startNightWatchdogScheduler(): void {
  stopNightWatchdogScheduler();
  interval = setInterval(() => { void tick(); }, TICK_MS);
}

export function stopNightWatchdogScheduler(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

/** Tests drive the check directly. */
export function _resetNightWatchdogForTests(): void {
  retryAfter.clear();
}
