/**
 * Geometry helpers for the planner timeline.
 *
 * Vertical layout: time on the Y axis, top = night start, bottom = night end.
 * One pixel scale (px-per-hour) governs both rendering and drop calculations.
 */

export const PX_PER_HOUR = 80;
export const PX_PER_MINUTE = PX_PER_HOUR / 60;
export const SNAP_MINUTES = 10;
export const DEFAULT_BLOCK_MINUTES = 60;
export const MIN_BLOCK_MINUTES = 15;

// The timeline scale (pixels per minute) is computed at runtime so the night
// fills the available pane height instead of always rendering at a fixed
// 80px/hour. The floor keeps very long nights readable on short screens
// (they scroll rather than collapsing to slivers). There is no ceiling —
// the fill value grows freely with the viewport so larger screens show
// proportionally larger hour blocks.
export const MIN_PX_PER_MINUTE = 0.8;  // 48 px/hour

/**
 * Pixels-per-minute that makes `totalMinutes` of night fill `viewportHeight`
 * pixels, floored at MIN_PX_PER_MINUTE. Falls back to the static default
 * before the viewport has been measured (height 0).
 */
export function computePxPerMinute(viewportHeight: number, totalMinutes: number): number {
  if (viewportHeight <= 0 || totalMinutes <= 0) return PX_PER_MINUTE;
  const fill = viewportHeight / totalMinutes;
  return Math.max(MIN_PX_PER_MINUTE, fill);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60000;
}

export function yToTime(y: number, nightStart: Date): Date {
  const minutes = Math.max(0, y / PX_PER_MINUTE);
  return new Date(nightStart.getTime() + minutes * 60000);
}

export function timeToY(t: Date, nightStart: Date): number {
  return Math.max(0, minutesBetween(nightStart, t) * PX_PER_MINUTE);
}

export function snapToGrid(t: Date): Date {
  const snapMs = SNAP_MINUTES * 60_000;
  return new Date(Math.round(t.getTime() / snapMs) * snapMs);
}

export function clampTime(t: Date, nightStart: Date, nightEnd: Date): Date {
  if (t.getTime() < nightStart.getTime()) return new Date(nightStart);
  if (t.getTime() > nightEnd.getTime()) return new Date(nightEnd);
  return t;
}

/** Two ranges overlap iff a.start < b.end AND b.start < a.end. */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export function formatHm(d: Date, timeZone?: string): string {
  // hourCycle:'h23' (not hour12:false) so midnight renders as "00:00"; some
  // WebKit builds emit "24:00" for en-GB + hour12:false.
  if (timeZone) {
    try {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
    } catch { /* fall through */ }
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Seconds elapsed into the current wall-clock hour for an instant, evaluated
 *  in `timeZone` (machine-local when omitted). Used to snap tick marks to the
 *  top of the hour as the observer sees it, not as the viewing device sees it. */
function secondsIntoHour(d: Date, timeZone?: string): number {
  if (!timeZone) return d.getMinutes() * 60 + d.getSeconds();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    return get('minute') * 60 + get('second');
  } catch {
    return d.getMinutes() * 60 + d.getSeconds();
  }
}

/**
 * Hour tick marks between nightStart and nightEnd, snapped to the top of each
 * hour in `timeZone` (the observer's zone). Includes both endpoints. Snapping
 * in the observer zone keeps labels on ":00" even when the viewing device is
 * in a different (or fractional-offset) timezone, where naive device-local
 * snapping would land labels on ":30".
 */
export function hourTicks(nightStart: Date, nightEnd: Date, timeZone?: string): Date[] {
  const ticks: Date[] = [];
  const into = secondsIntoHour(nightStart, timeZone);
  // First hour boundary at or after nightStart.
  let t = into === 0 ? nightStart.getTime() : nightStart.getTime() + (3600 - into) * 1000;
  while (t <= nightEnd.getTime()) {
    ticks.push(new Date(t));
    t += 3_600_000;
  }
  return ticks;
}
