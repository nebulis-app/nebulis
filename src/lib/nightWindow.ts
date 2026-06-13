/**
 * Client-side dark-window calculation for a given local date.
 *
 * Astronomy convention: "the night of May 17" is the dark window that begins
 * on the evening of May 17 and ends in the early morning of May 18. We use
 * astronomical twilight (sun ≥ 18° below horizon) as the start/end markers,
 * since that's when DSO imaging actually pays off.
 */
import SunCalc from 'suncalc';

/** Local midnight for a Date — strips time, keeps calendar day. */
export function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

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
export function plannerToday(now: Date = new Date()): Date {
  const d = localMidnight(now);
  if (now.getHours() < 7) d.setDate(d.getDate() - 1);
  return d;
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
  // twilight, then a fixed 21:00-04:30 window if even that doesn't resolve.
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

/** Format as YYYY-MM-DD using local date parts (no UTC drift). */
export function localDateKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** "Sat, May 17, 2026" */
export function formatPlannerDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Two Date instances refer to the same local calendar day. */
export function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
