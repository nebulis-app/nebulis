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
