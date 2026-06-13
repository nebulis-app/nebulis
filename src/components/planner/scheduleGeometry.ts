/**
 * Geometry helpers for the planner timeline.
 *
 * Vertical layout: time on the Y axis, top = night start, bottom = night end.
 * One pixel scale (px-per-hour) governs both rendering and drop calculations.
 */

export const PX_PER_HOUR = 80;
export const PX_PER_MINUTE = PX_PER_HOUR / 60;
export const SNAP_MINUTES = 15;
export const DEFAULT_BLOCK_MINUTES = 30;
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

export function snapToGrid(t: Date, nightStart: Date): Date {
  const minutesFromStart = minutesBetween(nightStart, t);
  const snapped = Math.round(minutesFromStart / SNAP_MINUTES) * SNAP_MINUTES;
  return new Date(nightStart.getTime() + snapped * 60000);
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

export function formatHm(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Hour tick marks between nightStart and nightEnd. Includes both endpoints. */
export function hourTicks(nightStart: Date, nightEnd: Date): Date[] {
  const ticks: Date[] = [];
  let t = new Date(nightStart);
  t.setMinutes(0, 0, 0); t.setMilliseconds(0);
  if (t.getTime() < nightStart.getTime()) t = new Date(t.getTime() + 3_600_000);
  while (t.getTime() <= nightEnd.getTime()) {
    ticks.push(new Date(t));
    t = new Date(t.getTime() + 3_600_000);
  }
  return ticks;
}
