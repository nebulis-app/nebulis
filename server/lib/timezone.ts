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
  for (let i = 0; i < 4; i++) {
    const actual = localParts(new Date(utcMs), timeZone);
    const actualWallMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const targetWallMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
    const delta = targetWallMs - actualWallMs;
    if (delta === 0) break;
    utcMs += delta;
  }

  return new Date(utcMs);
}

function parseDateKey(dateKey: string): [number, number, number] {
  const [year, month, day] = dateKey.split('-').map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
}
