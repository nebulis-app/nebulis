/**
 * "Clear night ahead": once each evening, at a set local time, look at the
 * hourly forecast for the active site and send `night.clear` when enough of
 * the remaining dark hours are under the cloud limit.
 *
 * The evaluation is pure (evaluateClearNight) so it can be tested on a fixed
 * forecast; the scheduler around it only decides when to run it, fetches the
 * forecast and remembers that tonight was checked.
 */
import SunCalc from 'suncalc';
import { getNightWindow } from '../astroCalc.js';
import {
  buildForecast,
  CACHE_TTL_MS,
  getForecastCacheEntry,
  isUsableForecast,
  setForecastCacheEntry,
  type ForecastHour,
} from '../forecastCache.js';
import { getActiveSite } from '../observingSites.js';
import { getInRange as plannedBetween } from '../plannedSessions.js';
import { addDaysToDateKey, localDateKey, localParts, zonedDateTimeToUtc } from '../timezone.js';
import { log } from '../logger.js';
import { dispatchAlert } from './delivery.js';
import { getAlertConfig, getAlertState, hasAlertListener, setAlertState } from './store.js';
import type { ClearNightAlertData, DewForecast, TonightPlan } from './types.js';

const HOUR_MS = 3_600_000;
/** An hour with a higher chance of rain than this is not clear, whatever the
 *  cloud cover says. */
const MAX_PRECIP_PROB = 40;

export interface ClearNightInput {
  hours: ForecastHour[];
  lat: number;
  lon: number;
  timeZone: string;
  siteName: string;
  /** Observing night, YYYY-MM-DD (the evening's local date). */
  night: string;
  maxCloudCover: number;
  /** Only hours from this moment on count (a check run late in the evening
   *  should not promise hours already gone). */
  from: Date;
  /** What is planned for the night, when it was looked up. Carried through as it is. */
  plan?: TonightPlan | null;
}

/** The air this close to its dew point (°C) dews over optics: within 1.5 it almost certainly does, within 3 it can. */
const DEW_LIKELY_SPREAD_C = 1.5;
const DEW_POSSIBLE_SPREAD_C = 3;

/**
 * Dew over the dark window: the coldest hour, and when the temperature first comes within reach of the dew point. Null with no usable hours.
 * An hour whose temperature and dew point are both exactly 0 is the forecast's stand-in for "no value", not a real foggy night, so it is skipped.
 */
export function evaluateDew(hours: ForecastHour[], startMs: number, endMs: number): DewForecast | null {
  let low: number | null = null;
  let likelyAt: number | null = null;
  let possibleAt: number | null = null;
  for (const h of [...hours].sort((a, b) => a.time.localeCompare(b.time))) {
    const hStart = new Date(h.time).getTime();
    const s = Math.max(hStart, startMs);
    const e = Math.min(hStart + HOUR_MS, endMs);
    if (e <= s || !Number.isFinite(h.temperature) || !Number.isFinite(h.dewPoint)) continue;
    if (h.temperature === 0 && h.dewPoint === 0) continue;
    low = low === null ? h.temperature : Math.min(low, h.temperature);
    const spread = h.temperature - h.dewPoint;
    if (spread <= DEW_LIKELY_SPREAD_C && likelyAt === null) likelyAt = s;
    if (spread <= DEW_POSSIBLE_SPREAD_C && possibleAt === null) possibleAt = s;
  }
  if (low === null) return null;
  const level = likelyAt !== null ? 'likely' : possibleAt !== null ? 'possible' : 'none';
  const at = level === 'likely' ? likelyAt : level === 'possible' ? possibleAt : null;
  return { level, from: at === null ? null : new Date(at).toISOString(), lowTempC: Math.round(low * 10) / 10 };
}

/** Tonight's blocks as the alert shows them: objects in the order they start, blocks the person skipped left out. */
export function summarizePlan(sessions: { objectName: string; startTime: string; skipped: number }[]): TonightPlan {
  const live = sessions.filter(s => !s.skipped).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const objects: string[] = [];
  for (const s of live) if (!objects.includes(s.objectName)) objects.push(s.objectName);
  return { objects, blocks: live.length };
}

/** Dark window of a night: astronomical, or nautical where the sky never gets
 *  astronomically dark (high-latitude summer). Null when neither exists. */
export function darkWindow(night: string, lat: number, lon: number, timeZone: string): { start: Date; end: Date } | null {
  const anchor = zonedDateTimeToUtc(night, { hour: 12 }, timeZone);
  const w = getNightWindow(anchor, lat, lon);
  const start = w.astronomicalDusk ?? w.nauticalDusk;
  const end = w.astronomicalDawn ?? w.nauticalDawn;
  if (!start || !end || end <= start) return null;
  return { start, end };
}

function moonAltitude(t: Date, lat: number, lon: number): number {
  return SunCalc.getMoonPosition(t, lat, lon).altitude;
}

/** Moonrise / moonset inside the window, from a 10-minute altitude scan. */
function moonCrossings(start: Date, end: Date, lat: number, lon: number): { rise: string | null; set: string | null } {
  let rise: string | null = null;
  let set: string | null = null;
  let prev = moonAltitude(start, lat, lon);
  for (let t = start.getTime() + 600_000; t <= end.getTime(); t += 600_000) {
    const alt = moonAltitude(new Date(t), lat, lon);
    if (prev < 0 && alt >= 0 && !rise) rise = new Date(t).toISOString();
    if (prev >= 0 && alt < 0 && !set) set = new Date(t).toISOString();
    prev = alt;
  }
  return { rise, set };
}

export function evaluateClearNight(input: ClearNightInput): ClearNightAlertData | null {
  const win = darkWindow(input.night, input.lat, input.lon, input.timeZone);
  if (!win) return null;
  const start = Math.max(win.start.getTime(), input.from.getTime());
  const end = win.end.getTime();
  if (end <= start) return null;

  let clearMs = 0;
  let moonDownMs = 0;
  const seeing: number[] = [];
  let run: { start: number; end: number } | null = null;
  let best: { start: number; end: number } | null = null;
  const closeRun = () => {
    if (run && (!best || run.end - run.start > best.end - best.start)) best = run;
    run = null;
  };

  const hours = [...input.hours].sort((a, b) => a.time.localeCompare(b.time));
  for (const h of hours) {
    const hStart = new Date(h.time).getTime();
    const s = Math.max(hStart, start);
    const e = Math.min(hStart + HOUR_MS, end);
    if (e <= s) continue;
    const clear = h.cloudCover <= input.maxCloudCover && h.precipProb < MAX_PRECIP_PROB;
    if (!clear) {
      closeRun();
      continue;
    }
    clearMs += e - s;
    if (moonAltitude(new Date((s + e) / 2), input.lat, input.lon) < 0) moonDownMs += e - s;
    if (h.seeing !== null) seeing.push(h.seeing);
    if (run && run.end === s) run.end = e;
    else {
      closeRun();
      run = { start: s, end: e };
    }
  }
  closeRun();
  const longest = best as { start: number; end: number } | null;

  const round1 = (ms: number) => Math.round((ms / HOUR_MS) * 10) / 10;
  const mid = new Date((start + end) / 2);
  const crossings = moonCrossings(new Date(start), new Date(end), input.lat, input.lon);
  return {
    siteName: input.siteName,
    night: input.night,
    timeZone: input.timeZone,
    clearHours: round1(clearMs),
    darkHours: round1(end - start),
    longestStart: new Date(longest?.start ?? start).toISOString(),
    longestEnd: new Date(longest?.end ?? start).toISOString(),
    maxCloudCover: input.maxCloudCover,
    seeing: seeing.length > 0 ? Math.round((seeing.reduce((a, b) => a + b, 0) / seeing.length) * 10) / 10 : null,
    moonIllumination: Math.round(SunCalc.getMoonIllumination(mid).fraction * 100),
    moonDownHours: round1(moonDownMs),
    moonRise: crossings.rise,
    moonSet: crossings.set,
    dew: evaluateDew(input.hours, start, end),
    plan: input.plan ?? null,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

export interface ClearNightCheck {
  night: string;
  checkedAt: string;
  /** Null when there was no forecast or no dark window. */
  result: ClearNightAlertData | null;
  sent: boolean;
  reason: 'sent' | 'not_clear_enough' | 'no_forecast' | 'no_dark_window' | 'no_site' | 'preview';
}

const LAST_CHECK_KEY = 'clearNight.lastCheck';
const RETRY_MS = 15 * 60_000;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;
let retryAfter = 0;

export function lastClearNightCheck(): ClearNightCheck | null {
  return getAlertState<ClearNightCheck>(LAST_CHECK_KEY);
}

export async function forecastHours(lat: number, lon: number): Promise<ForecastHour[] | null> {
  const cached = getForecastCacheEntry(lat, lon);
  const hoursOf = (data: unknown) => (data as { hourly: ForecastHour[] }).hourly;
  if (cached && isUsableForecast(cached.data) && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return hoursOf(cached.data);
  try {
    const data = await buildForecast(lat, lon);
    if (isUsableForecast(data)) {
      setForecastCacheEntry({ data, fetchedAt: Date.now(), lat, lon });
      return hoursOf(data);
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] forecast unavailable for the clear-night check');
  }
  return cached && isUsableForecast(cached.data) ? hoursOf(cached.data) : null;
}

/**
 * Evaluate tonight for the active site. With `send`, the alert goes out when
 * the night qualifies and tonight is recorded as checked; without it, this is
 * a preview for the settings page.
 */
export async function runClearNightCheck(now: Date, send: boolean): Promise<ClearNightCheck> {
  const site = getActiveSite();
  const tz = site.timezone;
  const night = localDateKey(now, tz);
  const base = { night, checkedAt: now.toISOString(), sent: false };
  if (site.latitude == null || site.longitude == null) return { ...base, result: null, reason: 'no_site' };

  const hours = await forecastHours(site.latitude, site.longitude);
  if (!hours) return { ...base, result: null, reason: 'no_forecast' };

  const config = getAlertConfig();
  // Blocks that overlap the dark window, with an hour either side so one planned a little before dusk or after dawn still counts.
  const dark = darkWindow(night, site.latitude, site.longitude, tz);
  const plan = dark
    ? summarizePlan(plannedBetween(new Date(dark.start.getTime() - HOUR_MS).toISOString(), new Date(dark.end.getTime() + HOUR_MS).toISOString()))
    : null;
  const result = evaluateClearNight({
    hours,
    lat: site.latitude,
    lon: site.longitude,
    timeZone: tz,
    siteName: site.name,
    night,
    maxCloudCover: config.clearNight.maxCloudCover,
    from: now,
    plan,
  });
  if (!result) return { ...base, result: null, reason: 'no_dark_window' };
  if (!send) return { ...base, result, reason: 'preview' };

  const qualifies = result.clearHours >= config.clearNight.minClearHours;
  if (qualifies) await dispatchAlert({ type: 'night.clear', occurredAt: now.toISOString(), data: result });
  return { ...base, result, sent: qualifies, reason: qualifies ? 'sent' : 'not_clear_enough' };
}

/** Due: someone listens, the local clock has passed the check time, and
 *  tonight has not been checked yet. */
export function isClearNightCheckDue(now: Date, checkTime: string, timeZone: string, lastNight: string | null): boolean {
  const [hh, mm] = checkTime.split(':').map(Number);
  const p = localParts(now, timeZone);
  return lastNight !== localDateKey(now, timeZone) && p.hour * 60 + p.minute >= hh * 60 + mm;
}

export interface NextClearNightCheck {
  /** When the evening check will run (or ran, for `now`), as an instant. */
  at: string;
  /** `now`: it is past the check time and tonight has not been checked, so it runs within the minute. */
  when: 'now' | 'today' | 'tomorrow';
}

/**
 * When the next evening check happens, by the same rule the scheduler uses: once a local calendar day, at the check time, in the active site's
 * time zone. Tonight's check counts as done once it has run, whether or not it sent anything.
 */
export function nextClearNightCheck(now: Date, checkTime: string, timeZone: string, lastNight: string | null): NextClearNightCheck {
  const [hour, minute] = checkTime.split(':').map(Number);
  const today = localDateKey(now, timeZone);
  if (isClearNightCheckDue(now, checkTime, timeZone, lastNight)) return { at: now.toISOString(), when: 'now' };
  const checked = lastNight === today;
  const day = checked ? addDaysToDateKey(today, 1) : today;
  return { at: zonedDateTimeToUtc(day, { hour: hour!, minute: minute! }, timeZone).toISOString(), when: checked ? 'tomorrow' : 'today' };
}

async function tick(): Promise<void> {
  if (running || Date.now() < retryAfter) return;
  if (!hasAlertListener('night.clear')) return;
  const site = getActiveSite();
  const now = new Date();
  const config = getAlertConfig();
  if (!isClearNightCheckDue(now, config.clearNight.checkTime, site.timezone, lastClearNightCheck()?.night ?? null)) return;

  running = true;
  try {
    const check = await runClearNightCheck(now, true);
    if (check.reason === 'no_forecast') {
      retryAfter = Date.now() + RETRY_MS; // try again later this evening
      return;
    }
    setAlertState(LAST_CHECK_KEY, check);
  } catch (err) {
    retryAfter = Date.now() + RETRY_MS;
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] clear-night check failed');
  } finally {
    running = false;
  }
}

export function startClearNightScheduler(): void {
  stopClearNightScheduler();
  interval = setInterval(() => { void tick(); }, 60_000);
}

export function stopClearNightScheduler(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

export const _clearNightTickForTests = tick;
