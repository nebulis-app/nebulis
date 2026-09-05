/** "2m 14s" / "1h 06m". Used for elapsed time and for an ETA. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return 'just started';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

/**
 * A remaining-time estimate, rounded to something a person would say.
 *
 * Deliberately coarser than `formatDuration`: a countdown recomputed from a
 * live transfer rate jitters by seconds, and showing "4m 07s" ticking to
 * "4m 22s" reads as broken. Minutes, then hours.
 */
export function formatEta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours} h` : `${hours} h ${mins} min`;
}

/** "just now" / "18m ago" / "Mar 15, 11:00 PM". */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Shortest honest form of a relative time, for a stat value: "18m", "3d". */
export function formatRelativeShort(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Minutes as a sync cadence: "30 min", "1 h", "6 h", "1 day". */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '1 day' : `${days} days`;
  }
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
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
