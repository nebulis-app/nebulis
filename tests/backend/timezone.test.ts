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

  // CODE_AUDIT.md Finding 24: zonedDateTimeToUtc's fixed-point iteration
  // seeds the wall-clock parts as if they were UTC, then corrects by
  // whatever the offset error is. For a wall time inside a DST
  // spring-forward gap (no UTC instant maps to it), the offset error never
  // resolves to zero — the loop bounced between the pre- and post-transition
  // guesses and returned whichever one it happened to land on after 4
  // iterations, which for '2026-03-08T02:30' local New York time was
  // 2026-03-08T06:30:00.000Z: 01:30 EST, a full hour off from what was asked
  // for and not even inside the requested gap.
  describe('DST spring-forward gap', () => {
    it('clamps a target inside the gap to the exact instant the clock springs forward', () => {
      // America/New_York: 2026-03-08, 02:00 -> 03:00 local, at 07:00:00.000Z.
      const expected = '2026-03-08T07:00:00.000Z';
      expect(zonedDateTimeToUtc('2026-03-08', { hour: 2, minute: 0, second: 0 }, 'America/New_York').toISOString()).toBe(expected);
      expect(zonedDateTimeToUtc('2026-03-08', { hour: 2, minute: 30, second: 0 }, 'America/New_York').toISOString()).toBe(expected);
      expect(zonedDateTimeToUtc('2026-03-08', { hour: 2, minute: 59, second: 59 }, 'America/New_York').toISOString()).toBe(expected);
    });

    it('leaves times just outside the gap on either side untouched', () => {
      expect(zonedDateTimeToUtc('2026-03-08', { hour: 1, minute: 59, second: 59 }, 'America/New_York').toISOString())
        .toBe('2026-03-08T06:59:59.000Z');
      expect(zonedDateTimeToUtc('2026-03-08', { hour: 3, minute: 0, second: 0 }, 'America/New_York').toISOString())
        .toBe('2026-03-08T07:00:00.000Z');
    });

    it('resolves a gap in a different timezone with a different transition rule (Europe/Berlin)', () => {
      // Europe/Berlin: 2026-03-29, 02:00 -> 03:00 CET/CEST local, at 01:00:00.000Z.
      expect(zonedDateTimeToUtc('2026-03-29', { hour: 2, minute: 30 }, 'Europe/Berlin').toISOString())
        .toBe('2026-03-29T01:00:00.000Z');
    });
  });

  // The fall-back (ambiguous) side isn't broken the same way — some instant's
  // wall clock genuinely equals the target, so the iteration always
  // converges — but which of the two matching instants it lands on was
  // previously undocumented. Pinned here so it stays deterministic.
  it('resolves an ambiguous (fall-back) local time to the earlier, still-DST occurrence', () => {
    // America/New_York: 2026-11-01, 01:00 occurs twice (EDT then EST).
    expect(zonedDateTimeToUtc('2026-11-01', { hour: 1, minute: 30 }, 'America/New_York').toISOString())
      .toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT (-4), the earlier occurrence
  });
});
