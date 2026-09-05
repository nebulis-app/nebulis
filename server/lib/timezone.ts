export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

export function timeZoneOrLocal(timeZone?: string | null): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return fallback;
  }
}

export function localParts(date: Date, timeZone?: string | null): Required<LocalDateTimeParts> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZoneOrLocal(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0';
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
  };
}

export function localDateKey(date: Date, timeZone?: string | null): string {
  const p = localParts(date, timeZone);
  return dateKeyFromParts(p.year, p.month, p.day);
}

export function dateKeyFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = parseDateKey(dateKey);
  const utcNoon = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return dateKeyFromParts(utcNoon.getUTCFullYear(), utcNoon.getUTCMonth() + 1, utcNoon.getUTCDate());
}

/** The UTC-to-local offset (in ms) actually in effect at `utcMs` for `timeZone`:
 *  the amount added to a UTC instant to get its local wall-clock reading. */
function localOffsetMsAt(utcMs: number, timeZone?: string | null): number {
  const actual = localParts(new Date(utcMs), timeZone);
  const actualWallMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  return actualWallMs - utcMs;
}

/**
 * A DST spring-forward transition skips a range of wall-clock times
 * entirely (e.g. `America/New_York` has no 02:30 on the day clocks jump from
 * 02:00 to 03:00). No UTC instant formats to a skipped time, so the caller's
 * fixed-point iteration in `zonedDateTimeToUtc` never converges for one —
 * it keeps landing on instants just before or just after the jump, neither
 * of which round-trips back to the target.
 *
 * Policy for that case (documented, not incidental): resolve to the first
 * valid instant at or after the target — i.e. the exact moment the clock
 * springs forward. Found by binary-searching the offset change within a
 * ±24h window of the naive guess, which safely brackets a single transition
 * (the next-nearest one is months away in every real IANA zone).
 */
function resolveDstGap(utcMsGuess: number, timeZone?: string | null): Date {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // localParts (Intl.DateTimeFormat) only reports whole seconds, so
  // localOffsetMsAt is only meaningful at whole-second probe points — a
  // sub-second probe's own discarded millisecond remainder would corrupt the
  // computed offset once the search narrows past 1s. Every real IANA DST
  // transition lands on a whole second anyway, so searching at that
  // granularity loses nothing.
  let loSec = Math.floor((utcMsGuess - DAY_MS) / 1000);
  let hiSec = Math.floor((utcMsGuess + DAY_MS) / 1000);
  const offsetBefore = localOffsetMsAt(loSec * 1000, timeZone);
  const offsetAfter = localOffsetMsAt(hiSec * 1000, timeZone);
  if (offsetBefore === offsetAfter) {
    // No transition bracketed (shouldn't happen for a genuine gap target) —
    // fall back to the naive guess rather than guessing further.
    return new Date(utcMsGuess);
  }
  // Binary search for the first second whose offset differs from
  // offsetBefore — the exact moment the clock springs forward.
  while (hiSec - loSec > 1) {
    const midSec = Math.floor((loSec + hiSec) / 2);
    if (localOffsetMsAt(midSec * 1000, timeZone) === offsetBefore) loSec = midSec;
    else hiSec = midSec;
  }
  return new Date(hiSec * 1000);
}

export function zonedDateTimeToUtc(
  dateKey: string,
  time: { hour: number; minute?: number; second?: number },
  timeZone?: string | null,
): Date {
  const [year, month, day] = parseDateKey(dateKey);
  const target: Required<LocalDateTimeParts> = {
    year,
    month,
    day,
    hour: time.hour,
    minute: time.minute ?? 0,
    second: time.second ?? 0,
  };

  let utcMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  let converged = false;
  for (let i = 0; i < 4; i++) {
    const actual = localParts(new Date(utcMs), timeZone);
    const actualWallMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const targetWallMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
    const delta = targetWallMs - actualWallMs;
    if (delta === 0) { converged = true; break; }
    utcMs += delta;
  }
  // An ambiguous (fall-back) target always converges — some instant's wall
  // clock genuinely equals it — and the iteration above settles on whichever
  // of the two matching instants it reaches first, which in practice is the
  // earlier (still-DST) occurrence. A target inside a spring-forward gap
  // never converges — no instant's wall clock equals it — which is exactly
  // the signal to fall back to the documented gap policy instead of
  // returning whatever `utcMs` the loop happened to end on.
  if (!converged) return resolveDstGap(utcMs, timeZone);

  return new Date(utcMs);
}

function parseDateKey(dateKey: string): [number, number, number] {
  const [year, month, day] = dateKey.split('-').map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
}
