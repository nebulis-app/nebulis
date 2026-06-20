import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNightWindow } from '../../server/lib/astroCalc';
import { observerTimezoneForCoordinates } from '../../server/lib/observerTimezone';
import { addDaysToDateKey, localDateKey, localParts, zonedDateTimeToUtc } from '../../server/lib/timezone';
import { defaultNightAnchor, parseLocalNoon, resolvePlannerDarkWindow } from '../../server/routes/planner';

describe('timezone helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts observer-local noon to the matching UTC instant', () => {
    expect(parseLocalNoon('2026-06-17', 'America/Los_Angeles').toISOString()).toBe('2026-06-17T19:00:00.000Z');
    expect(parseLocalNoon('2026-06-17', 'Asia/Tokyo').toISOString()).toBe('2026-06-17T03:00:00.000Z');
  });

  it('keeps date arithmetic on calendar keys independent of host timezone', () => {
    expect(addDaysToDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysToDateKey('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDaysToDateKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('formats instants in the requested observer timezone', () => {
    const instant = new Date('2026-06-17T04:30:00.000Z');
    expect(localDateKey(instant, 'America/Los_Angeles')).toBe('2026-06-16');
    expect(localDateKey(instant, 'Asia/Tokyo')).toBe('2026-06-17');
    expect(localParts(instant, 'America/Los_Angeles').hour).toBe(21);
    expect(localParts(instant, 'Asia/Tokyo').hour).toBe(13);
  });

  it('uses the observer timezone for planner 07:00 rollover', () => {
    const instant = new Date('2026-06-17T10:30:00.000Z');
    expect(defaultNightAnchor(instant, 'America/Los_Angeles').toISOString()).toBe('2026-06-16T19:00:00.000Z');
    expect(defaultNightAnchor(instant, 'Asia/Tokyo').toISOString()).toBe('2026-06-17T03:00:00.000Z');
  });

  it('handles DST offsets for observer-local wall times', () => {
    expect(zonedDateTimeToUtc('2026-01-15', { hour: 12 }, 'America/New_York').toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(zonedDateTimeToUtc('2026-07-15', { hour: 12 }, 'America/New_York').toISOString()).toBe('2026-07-15T16:00:00.000Z');
  });

  it('uses the coordinate timezone for Franklin planner windows even when saved timezone is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ timezone: 'America/Chicago' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const lat = 35.904;
    const lon = -86.831;
    const timezone = await observerTimezoneForCoordinates(lat, lon, 'Australia/Brisbane');
    const night = getNightWindow(parseLocalNoon('2026-06-19', timezone), lat, lon);

    const fmt = (d: Date) => new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);

    expect(timezone).toBe('America/Chicago');
    expect(fmt(night.nightStart!)).toBe('21:57');
    expect(fmt(night.nightEnd!)).toBe('03:42');
  });

  it('does not invent an afternoon dark window when Moscow has no nautical dark', () => {
    const night = getNightWindow(parseLocalNoon('2026-06-19', 'Europe/Moscow'), 55.752, 37.618);

    expect(night.nightStart).toBeNull();
    expect(night.nightEnd).toBeNull();
    expect(night.nauticalDusk).toBeNull();
    expect(night.nauticalDawn).toBeNull();
    expect(resolvePlannerDarkWindow(night)).toBeNull();
  });
});
