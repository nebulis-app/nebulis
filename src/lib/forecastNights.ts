/**
 * Slicing hourly forecast data into nights.
 *
 * Extracted from ForecastPage so the planner's weather popup groups nights the
 * same way the Sky Forecast page does. Used only for the outlook sparklines, so
 * an approximate evening-to-morning window is fine; the precise dark window
 * comes from the server's twilight times.
 */
import type { ForecastHour } from './api/planner';

/** Local YYYY-MM-DD for a moment, in the forecast's timezone. */
export function localDateKey(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function localHourOfDay(ms: number, timeZone?: string): number {
  try {
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
