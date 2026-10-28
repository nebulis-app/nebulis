/**
 * Slicing hourly forecast data into nights, and the dark window a night holds.
 *
 * Extracted from ForecastPage so the planner's weather popup groups nights the
 * same way the Sky Forecast page does. `hoursForNight` stays deliberately
 * approximate (evening to morning) because it only feeds the outlook
 * sparklines. The precise window comes from the server's own twilight times,
 * and `resolveImagingWindow` / `hoursInWindow` below are what turn those into
 * the bounds the imaging window table tabulates.
 */
import type { ForecastHour } from './api/planner';

/** Local YYYY-MM-DD for a moment, in the forecast's timezone. 'en-CA' is
 *  locale-invariant PARSING: it happens to be the one built-in locale whose
 *  short date format is exactly YYYY-MM-DD, used here as a sort/lookup key,
 *  not display — see formatLocale.ts's header comment. */
export function localDateKey(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ms));
  } catch {
    // An unusable zone falls back to the viewer's clock, never to UTC.
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

export function localHourOfDay(ms: number, timeZone?: string): number {
  try {
    // 'en-US' here is locale-invariant PARSING — see formatLocale.ts's header comment.
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(new Date(ms));
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  } catch {
    return new Date(ms).getHours();
  }
}

export function nextDateKey(dateKey: string): string {
  const d = new Date(dateKey + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  // eslint-disable-next-line local/no-utc-date-key -- d is a noon-UTC carrier for the key, not a real moment
  return d.toISOString().slice(0, 10);
}

/**
 * Hours belonging to the night labelled `dateKey`: evening of that date through
 * the small hours of the next.
 */
export function hoursForNight(hourly: ForecastHour[], dateKey: string, timeZone?: string): ForecastHour[] {
  const tomorrow = nextDateKey(dateKey);
  return hourly.filter(h => {
    const ms = new Date(h.time).getTime();
    const key = localDateKey(ms, timeZone);
    const hod = localHourOfDay(ms, timeZone);
    if (key === dateKey) return hod >= 19;
    if (key === tomorrow) return hod <= 6;
    return false;
  });
}

/** Just the twilight fields of the forecast's `tonight` block. */
export interface TwilightTimes {
  astronomicalTwilightEnd?: string | null;
  astronomicalTwilightStart?: string | null;
  nauticalTwilightEnd?: string | null;
  nauticalTwilightStart?: string | null;
}

/** A night's dark window, in absolute milliseconds and as the source strings. */
export interface ImagingWindow {
  /** The twilight time that opened the window, as sent by the server. */
  startIso: string;
  /** The twilight time that closed it. */
  endIso: string;
  startMs: number;
  endMs: number;
  /** True when the bounds came from astronomical twilight rather than the
   *  nautical fallback. That fallback is what a high-latitude summer night
   *  gets: the Sun never reaches -18°, so there is no astronomical darkness. */
  astronomical: boolean;
}

/**
 * The dark window for a night, preferring astronomical twilight and falling
 * back to nautical.
 *
 * Null when the data cannot describe a window: no twilight pair at all, an
 * unparseable time, or an end that does not land after its start. The last of
 * those is real rather than defensive, since the server can hand back the
 * following night's dawn ahead of tonight's dusk at high latitudes in summer.
 */
export function resolveImagingWindow(twilight: TwilightTimes): ImagingWindow | null {
  const startIso = twilight.astronomicalTwilightEnd || twilight.nauticalTwilightEnd;
  const endIso = twilight.astronomicalTwilightStart || twilight.nauticalTwilightStart;
  if (!startIso || !endIso) return null;

  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;

  return { startIso, endIso, startMs, endMs, astronomical: !!twilight.astronomicalTwilightEnd };
}

/** The hours falling inside the window, inclusive of both bounds. */
export function hoursInWindow(hours: ForecastHour[], win: ImagingWindow): ForecastHour[] {
  return hours.filter(h => {
    const ms = new Date(h.time).getTime();
    return ms >= win.startMs && ms <= win.endMs;
  });
}
