/**
 * 15-night outlook from weather-model ensembles.
 *
 * The detailed forecast (forecastCache.ts) stops a few days out on purpose:
 * 7Timer's seeing ends at 72 h, and a single deterministic cloud forecast
 * a week ahead reads far more precise than it is. Ensembles answer the
 * question that matters that far out (is a session worth planning?) without
 * pretending: each model is run dozens of times from slightly perturbed
 * starting points, and the share of runs that give a clear night is a fair
 * measure of the odds, with the spread saying how much the runs disagree.
 *
 * Source: Open-Meteo's ensemble API (free, no key), three global ensembles
 * that reach 15+ days:
 *   - ECMWF IFS 0.25° (ecmwf_ifs025_ensemble)  51 members, 15 days
 *   - GEM global (gem_global_ensemble)         21 members, 16 days
 *   - NCEP GEFS (ncep_gefs_seamless)           31 members, 0.25° to 10 days
 *                                              then 0.5° to 35 days
 *
 * For each observing night of the site, every member is scored on the dark
 * window (astronomical twilight, nautical where it never gets that dark):
 * a member gives a usable night when at least `minClearHours` of its dark
 * hours are at or under `maxCloudCover`. The night's probability is the
 * share of members that do. Members without data for most of the window
 * (a model that ends earlier) are left out of that night rather than
 * counted as cloudy.
 *
 * Fetched data is cached per site for 3 hours: the ensembles update every
 * 6 to 12 hours and the response is large (about 100 members × 16 days).
 */
import SunCalc from 'suncalc';
import { getNightWindow } from './astroCalc.js';
import { forecastSiteKey } from './forecastCache.js';
import { addDaysToDateKey, zonedDateTimeToUtc } from './timezone.js';
import { observingNightDateKey } from './telescopeFiles.js';

/** Open-Meteo's ensemble model ids (the API rejects the deterministic
 *  model names: `ecmwf_ifs025` alone is a 400). */
export const ENSEMBLE_MODELS = [
  { id: 'ecmwf_ifs025_ensemble', label: 'ECMWF' },
  { id: 'gem_global_ensemble', label: 'GEM' },
  { id: 'ncep_gefs_seamless', label: 'GFS' },
] as const;
export type EnsembleModelId = (typeof ENSEMBLE_MODELS)[number]['id'];

const HOUR_MS = 3_600_000;
const FORECAST_DAYS = 16;
export const OUTLOOK_NIGHTS = 15;
const CACHE_TTL_MS = 3 * HOUR_MS;
/** A member must cover this share of a night's dark hours to count. */
const MIN_COVERAGE = 0.8;

export interface EnsembleMember {
  model: string;
  /** 0 = control run. */
  member: number;
  /** Cloud cover (%) per entry of `times`; null where the model has no data. */
  values: (number | null)[];
}

export interface EnsembleData {
  /** Hour starts, epoch ms. */
  times: number[];
  members: EnsembleMember[];
}

export interface OutlookModel {
  model: string;
  label: string;
  members: number;
  clearMembers: number;
  /** 0–1, null when no member of this model covers the night. */
  clearProbability: number | null;
}

export interface OutlookNight {
  /** Observing night, YYYY-MM-DD (the evening's date). */
  date: string;
  darkStart: string;
  darkEnd: string;
  darkHours: number;
  /** Members that cover the night, all models together. */
  members: number;
  clearMembers: number;
  /** 0–1, null when no member covers the night. */
  clearProbability: number | null;
  /** Mean cloud cover over the dark hours: median and quartiles across members. */
  cloudMedian: number | null;
  cloudP25: number | null;
  cloudP75: number | null;
  moonIllumination: number;
  /** Moon above the horizon at the middle of the dark window. */
  moonUpAtMidnight: boolean;
  models: OutlookModel[];
}

export interface OutlookThresholds {
  maxCloudCover: number;
  minClearHours: number;
}

export const DEFAULT_OUTLOOK_THRESHOLDS: OutlookThresholds = { maxCloudCover: 30, minClearHours: 3 };

// ─── Fetch and parse ────────────────────────────────────────────────────────

export function ensembleUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: 'cloud_cover',
    models: ENSEMBLE_MODELS.map(m => m.id).join(','),
    forecast_days: String(FORECAST_DAYS),
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  return `https://ensemble-api.open-meteo.com/v1/ensemble?${params}`;
}

const MODEL_IDS: readonly string[] = ENSEMBLE_MODELS.map(m => m.id);
// cloud_cover, cloud_cover_member07, cloud_cover_gem_global,
// cloud_cover_member07_gem_global. A single-model response has no suffix.
const KEY = /^cloud_cover(?:_member(\d+))?(?:_([a-z0-9_]+))?$/;

/**
 * Members from an Open-Meteo ensemble response, whichever way it names them:
 * with one model the keys carry no model suffix, with several each key ends
 * in the model id. Keys this does not recognise are ignored.
 */
export function parseEnsemble(json: unknown, singleModel: string = ENSEMBLE_MODELS[0].id): EnsembleData {
  const hourly = (json as { hourly?: Record<string, unknown> } | null)?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) throw new Error('Ensemble response has no hourly data');
  const times = (hourly.time as unknown[]).map(t =>
    typeof t === 'number' ? t * 1000 : Date.parse(`${String(t)}${/Z|[+-]\d\d:?\d\d$/.test(String(t)) ? '' : 'Z'}`));
  const members: EnsembleMember[] = [];
  for (const [key, raw] of Object.entries(hourly)) {
    if (key === 'time' || !Array.isArray(raw)) continue;
    const m = KEY.exec(key);
    if (!m) continue;
    const model = m[2] ?? singleModel;
    if (m[2] && !MODEL_IDS.includes(m[2])) continue;
    members.push({
      model,
      member: m[1] ? Number(m[1]) : 0,
      values: raw.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
    });
  }
  members.sort((a, b) => a.model.localeCompare(b.model) || a.member - b.member);
  return { times, members };
}

// ─── Scoring ────────────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function darkWindowFor(night: string, lat: number, lon: number, timeZone: string): { start: number; end: number } | null {
  const w = getNightWindow(zonedDateTimeToUtc(night, { hour: 12 }, timeZone), lat, lon);
  const start = w.astronomicalDusk ?? w.nauticalDusk;
  const end = w.astronomicalDawn ?? w.nauticalDawn;
  if (!start || !end || end <= start) return null;
  return { start: start.getTime(), end: end.getTime() };
}

/**
 * Score each of the next `nights` observing nights (tonight first) against
 * the ensemble. Pure: the data, the place and the clock come in.
 */
export function computeOutlook(
  data: EnsembleData,
  site: { lat: number; lon: number; timeZone: string },
  now: Date,
  thresholds: OutlookThresholds = DEFAULT_OUTLOOK_THRESHOLDS,
  nights = OUTLOOK_NIGHTS,
): OutlookNight[] {
  const first = observingNightDateKey(now, site.timeZone);
  const out: OutlookNight[] = [];
  for (let d = 0; d < nights; d++) {
    const date = addDaysToDateKey(first, d);
    const win = darkWindowFor(date, site.lat, site.lon, site.timeZone);
    if (!win) continue;
    // Hours whose start falls in the dark window (hourly data).
    const idx: number[] = [];
    data.times.forEach((t, i) => { if (t >= win.start - HOUR_MS / 2 && t < win.end) idx.push(i); });
    const darkHours = (win.end - win.start) / HOUR_MS;
    const needClear = Math.min(thresholds.minClearHours, darkHours);

    const perModel = new Map<string, { members: number; clear: number }>();
    const means: number[] = [];
    let members = 0;
    let clear = 0;
    for (const m of data.members) {
      const vals = idx.map(i => m.values[i]).filter((v): v is number => v !== null && v !== undefined);
      if (idx.length === 0 || vals.length < idx.length * MIN_COVERAGE) continue;
      const clearHours = vals.filter(v => v <= thresholds.maxCloudCover).length;
      const isClear = clearHours >= needClear;
      members += 1;
      if (isClear) clear += 1;
      means.push(vals.reduce((a, b) => a + b, 0) / vals.length);
      const pm = perModel.get(m.model) ?? { members: 0, clear: 0 };
      pm.members += 1;
      if (isClear) pm.clear += 1;
      perModel.set(m.model, pm);
    }
    means.sort((a, b) => a - b);
    const round = (v: number | null) => (v === null ? null : Math.round(v));
    const mid = new Date((win.start + win.end) / 2);
    out.push({
      date,
      darkStart: new Date(win.start).toISOString(),
      darkEnd: new Date(win.end).toISOString(),
      darkHours: Math.round(darkHours * 10) / 10,
      members,
      clearMembers: clear,
      clearProbability: members > 0 ? Math.round((clear / members) * 100) / 100 : null,
      cloudMedian: round(quantile(means, 0.5)),
      cloudP25: round(quantile(means, 0.25)),
      cloudP75: round(quantile(means, 0.75)),
      moonIllumination: Math.round(SunCalc.getMoonIllumination(mid).fraction * 100),
      moonUpAtMidnight: SunCalc.getMoonPosition(mid, site.lat, site.lon).altitude > 0,
      models: ENSEMBLE_MODELS.map(({ id, label }) => {
        const pm = perModel.get(id);
        return {
          model: id,
          label,
          members: pm?.members ?? 0,
          clearMembers: pm?.clear ?? 0,
          clearProbability: pm && pm.members > 0 ? Math.round((pm.clear / pm.members) * 100) / 100 : null,
        };
      }),
    });
  }
  return out;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry { data: EnsembleData; fetchedAt: number }
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();
const MAX_SITES = 20;

/** Test hook. */
export function _clearEnsembleCache(): void {
  cache.clear();
  inFlight.clear();
}

async function fetchEnsemble(lat: number, lon: number): Promise<EnsembleData> {
  const res = await fetch(ensembleUrl(lat, lon), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    // Open-Meteo explains a refusal in `{ error: true, reason }`: pass it on,
    // so a renamed model or variable says what it is instead of a bare 400.
    const reason = await res.json().then((b: { reason?: unknown }) => (typeof b?.reason === 'string' ? b.reason : null)).catch(() => null);
    throw new Error(`Open-Meteo ensemble API error: ${res.status}${reason ? ` (${reason})` : ''}`);
  }
  const data = parseEnsemble(await res.json());
  if (data.members.length === 0) throw new Error('Open-Meteo ensemble API returned no members');
  return data;
}

/**
 * The ensemble for a site: cached for 3 hours, one fetch at a time per site.
 * A failed refresh falls back to a stale entry when there is one.
 */
export async function getEnsemble(lat: number, lon: number): Promise<CacheEntry> {
  const key = forecastSiteKey(lat, lon);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const job = (async () => {
    try {
      const entry = { data: await fetchEnsemble(lat, lon), fetchedAt: Date.now() };
      cache.delete(key);
      cache.set(key, entry);
      while (cache.size > MAX_SITES) cache.delete(cache.keys().next().value!);
      return entry;
    } catch (err) {
      if (cached) return cached;
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}
