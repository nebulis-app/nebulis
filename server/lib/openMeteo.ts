/**
 * One Open-Meteo hourly fetch + boundary-narrow.
 *
 * There were three separate Open-Meteo integrations (forecast hero, historical
 * session weather, a catalog route), and the historical one parsed hour
 * timestamps with `new Date(t).getHours()` — the server's timezone, not the
 * site's — so a UTC server scored the wrong 8 hours of every session
 * (CORE-PIPELINE-AUDIT FC-2). This is the shared fetch + parse; each consumer
 * keeps its own scoring (future forecast vs historical average).
 *
 * Every consumer should bucket hours with `nightHourIndices` (in
 * library/observations.ts) or `parseOpenMeteoHour` (forecastCache.ts): the API
 * is queried with `timezone=auto`, so `time[i]` is a naive local timestamp at
 * the site and its hour must be read lexically, never through `new Date()`.
 */
import { isRecord } from './typeGuards.js';

export interface OpenMeteoHourly {
  /** Naive local timestamps at the site, e.g. `2026-01-15T20:00`. */
  time: string[];
  /** One parallel array per requested variable; missing samples are null. */
  series: Record<string, Array<number | null>>;
  /** IANA zone the API resolved for the coordinates, or null. */
  timezone: string | null;
}

export interface OpenMeteoHourlyOptions {
  vars: string[];
  /** `YYYY-MM-DD`. Omit both to use `forecastDays` from today instead. */
  startDate?: string;
  endDate?: string;
  forecastDays?: number;
  /** Use the archive API (past dates) rather than the forecast API. */
  archive?: boolean;
  timeoutMs?: number;
}

/**
 * Fetch hourly data for one point. Returns null on a non-OK response or an
 * unparseable body; throws only on a network/timeout failure (the caller
 * decides whether that is fatal).
 */
export async function openMeteoHourly(
  lat: number,
  lon: number,
  opts: OpenMeteoHourlyOptions,
): Promise<OpenMeteoHourly | null> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: opts.vars.join(','),
    timezone: 'auto',
  });
  if (opts.startDate) params.set('start_date', opts.startDate);
  if (opts.endDate) params.set('end_date', opts.endDate);
  if (opts.forecastDays != null) params.set('forecast_days', String(opts.forecastDays));

  const base = opts.archive
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';

  const res = await fetch(`${base}?${params.toString()}`, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) return null;

  const raw: unknown = await res.json();
  if (!isRecord(raw) || !isRecord(raw.hourly)) return null;
  const hourly = raw.hourly;

  const time = Array.isArray(hourly.time)
    ? hourly.time.filter((s): s is string => typeof s === 'string')
    : [];

  const series: Record<string, Array<number | null>> = {};
  for (const v of opts.vars) {
    const col = hourly[v];
    series[v] = Array.isArray(col) ? col.map(n => (typeof n === 'number' ? n : null)) : [];
  }

  return { time, series, timezone: typeof raw.timezone === 'string' ? raw.timezone : null };
}
