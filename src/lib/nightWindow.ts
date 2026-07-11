/**
 * Client-side dark-window calculation for a given local date.
 *
 * Astronomy convention: "the night of May 17" is the dark window that begins
 * on the evening of May 17 and ends in the early morning of May 18. We use
 * astronomical twilight (sun ≥ 18° below horizon) as the start/end markers,
 * since that's when DSO imaging actually pays off.
 */
import SunCalc from 'suncalc';

/**
 * Astronomer's "today" — the calendar date whose evening starts the most
 * relevant upcoming or current dark window.
 *
 * Until 07:00 local, default to yesterday's calendar date: a session running
 * at 02:00 belongs to the prior evening's plan, not the new day. 07:00 (not
 * noon) is the rollover because a planner is forward-looking — after dawn,
 * "tonight" means the coming evening. 07:00 (not 06:00) so midwinter
 * sessions that image until a late dawn aren't yanked to the next night
 * mid-capture. Keep in sync with NightDate.swift in the iOS client and the
 * default-date anchor in server/routes/planner.ts.
 */
export function plannerToday(now: Date = new Date(), timeZone?: string): Date {
  const todayKey = timeZone ? localDateKeyInTimeZone(now, timeZone) : localDateKey(now);
  const hour = timeZone ? localHourInTimeZone(now, timeZone) : now.getHours();
  const key = hour < 7 ? addDaysToDateKey(todayKey, -1) : todayKey;
  return dateFromKey(key);
}

/**
 * Astronomical twilight start and end for the night that begins on `date`'s
 * evening. Returns null at observatories where the sun never sets enough
 * (polar summer / high latitudes mid-summer).
 */
export function nightWindowFor(date: Date, lat: number, lon: number): { start: Date; end: Date } | null {
  const eveningAnchor = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12, 0, 0);

  const evening = SunCalc.getTimes(eveningAnchor, lat, lon);
  const morning = SunCalc.getTimes(next, lat, lon);

  const start = evening.night;
  const end = morning.nightEnd;

  // SunCalc returns Invalid Date when an event doesn't occur (e.g. astronomical
  // twilight never reaches at high summer latitudes). Fall back to nautical
  // twilight. If even that does not occur, report no dark window.
  const validStart = start instanceof Date && !isNaN(start.getTime());
  const validEnd = end instanceof Date && !isNaN(end.getTime());
  if (validStart && validEnd) return { start, end };

  const eveningFallback = evening.nauticalDusk;
  const morningFallback = morning.nauticalDawn;
  if (eveningFallback instanceof Date && !isNaN(eveningFallback.getTime()) &&
      morningFallback instanceof Date && !isNaN(morningFallback.getTime())) {
    return { start: eveningFallback, end: morningFallback };
  }

  return null;
}

/**
 * Sunset-to-sunrise planning window (plus a buffer) for the night that begins
 * on `date`'s evening — the same wider window the planner's droppable
 * timeline uses (see resolvePlannerTimelineWindow in server/routes/planner.ts),
 * as opposed to nightWindowFor's narrower astronomical-darkness window. Use
 * this whenever you need "everything the user could have scheduled that
 * night", including twilight blocks, e.g. when copying a night's plan.
 * Falls back to dusk/dawn if sunset/sunrise don't occur (high-latitude
 * summer); returns null if neither pair occurs.
 */
export function timelineWindowFor(
  date: Date,
  lat: number,
  lon: number,
  bufferMs = 30 * 60_000,
): { start: Date; end: Date } | null {
  const eveningAnchor = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12, 0, 0);

  const evening = SunCalc.getTimes(eveningAnchor, lat, lon);
  const morning = SunCalc.getTimes(next, lat, lon);

  const rawStart = evening.sunset ?? evening.dusk;
  const rawEnd = morning.sunrise ?? morning.dawn;

  const validStart = rawStart instanceof Date && !isNaN(rawStart.getTime());
  const validEnd = rawEnd instanceof Date && !isNaN(rawEnd.getTime());
  if (!validStart || !validEnd) return null;

  return { start: new Date(rawStart.getTime() - bufferMs), end: new Date(rawEnd.getTime() + bufferMs) };
}

/** Format as YYYY-MM-DD using local date parts (no UTC drift). */
export function localDateKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Format as YYYY-MM-DD in a specific IANA timezone. */
function localDateKeyInTimeZone(d: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return localDateKey(d);
  }
}

/**
 * Planner calendar key for an instant. Times after midnight but before the
 * morning rollover still belong to the previous evening's plan.
 */
export function plannerDateKeyForInstant(d: Date, timeZone?: string): string {
  const key = timeZone ? localDateKeyInTimeZone(d, timeZone) : localDateKey(d);
  const hour = timeZone ? localHourInTimeZone(d, timeZone) : d.getHours();
  return hour < 7 ? addDaysToDateKey(key, -1) : key;
}

export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0);
}

function localHourInTimeZone(d: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  } catch {
    return d.getHours();
  }
}

function addDaysToDateKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days, 12, 0, 0));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** "Sat, May 17, 2026" */
export function formatPlannerDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Two Date instances refer to the same local calendar day. */
export function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
