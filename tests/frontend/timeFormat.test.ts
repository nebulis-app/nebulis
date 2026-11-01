import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { formatDuration, formatEta, formatRelativeTime, formatRelativeShort, formatInterval, formatHm, hourTicks } from '../../src/lib/timeFormat';

const NOW = new Date('2026-11-01T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatDuration', () => {
  it.each([
    [0, 'just started'],
    [999, 'just started'],
    [1000, '1s'],
    [59_999, '59s'],
    [60_000, '1m 00s'],
    [134_000, '2m 14s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 00m'],
    [3_960_000, '1h 06m'],
    [86_400_000, '24h 00m'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('never renders a seconds or minutes field of 60 or more', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 400 * HOUR }), ms => {
        const out = formatDuration(ms);
        for (const [, n] of out.matchAll(/(\d+)[ms]/g)) expect(Number(n)).toBeLessThan(60);
      }),
      { numRuns: 300 },
    );
  });
});

describe('formatEta', () => {
  it.each([
    [0, 'under a minute'],
    [29_999, 'under a minute'],
    [30_000, '1 min'],
    [4 * MIN + 7000, '4 min'],
    [59 * MIN, '59 min'],
    [HOUR, '1 h'],
    [HOUR + 30 * MIN, '1 h 30 min'],
    [3 * HOUR, '3 h'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatEta(ms)).toBe(expected);
  });

  it('does not jitter: an estimate moving by under half a minute rounds to the same text', () => {
    expect(formatEta(10 * MIN + 1000)).toBe(formatEta(10 * MIN + 20_000));
  });
});

describe('formatInterval', () => {
  it.each([
    [1, '1 min'],
    [30, '30 min'],
    [59, '59 min'],
    [60, '1 h'],
    [90, '1.5 h'],
    [360, '6 h'],
    [1440, '1 day'],
    [2880, '2 days'],
    [1500, '25 h'],
  ])('%i min -> %s', (minutes, expected) => {
    expect(formatInterval(minutes)).toBe(expected);
  });
});

describe('relative times', () => {
  afterEach(() => vi.useRealTimers());
  const at = () => { vi.useFakeTimers(); vi.setSystemTime(NOW); };

  it('says "just now" inside the first minute, in both forms', () => {
    at();
    expect(formatRelativeTime(ago(30_000))).toBe('just now');
    expect(formatRelativeShort(ago(30_000))).toBe('Just now');
  });

  it('counts minutes, hours and days at the boundaries', () => {
    at();
    expect(formatRelativeTime(ago(MIN))).toMatch(/\b1\b.*minute/);
    expect(formatRelativeTime(ago(18 * MIN))).toMatch(/\b18\b.*minute/);
    expect(formatRelativeTime(ago(HOUR))).toMatch(/\b1\b.*hour/);
    expect(formatRelativeTime(ago(5 * HOUR))).toMatch(/\b5\b.*hour/);
    expect(formatRelativeTime(ago(DAY))).toMatch(/yesterday|\b1\b.*day/i);
    expect(formatRelativeTime(ago(6 * DAY))).toMatch(/\b6\b.*day/);
  });

  it('falls back to a calendar date after a week, with no relative wording', () => {
    at();
    const out = formatRelativeTime(ago(8 * DAY));
    expect(out).not.toMatch(/ago|just now/i);
    expect(out).toMatch(/\d/);
    expect(formatRelativeShort(ago(8 * DAY))).not.toMatch(/ago|just now/i);
  });

  it('returns an empty string for an unparseable timestamp rather than "Invalid Date"', () => {
    expect(formatRelativeTime('not a date')).toBe('');
    expect(formatRelativeShort('')).toBe('');
  });
});

describe('formatHm', () => {
  it('pads to HH:mm in the given zone', () => {
    expect(formatHm(new Date('2026-11-01T05:07:00Z'), 'UTC')).toBe('05:07');
    expect(formatHm(new Date('2026-11-01T05:07:00Z'), 'Asia/Kolkata')).toBe('10:37');
  });

  it('falls back to the device clock for a zone it does not know', () => {
    const d = new Date(2026, 10, 1, 9, 5);
    expect(formatHm(d, 'Not/AZone')).toBe('09:05');
    expect(formatHm(d)).toBe('09:05');
  });
});

describe('hourTicks', () => {
  const iso = (s: string) => new Date(s);

  it('snaps to the top of each hour and includes an endpoint that falls on one', () => {
    const ticks = hourTicks(iso('2026-11-01T01:30:00Z'), iso('2026-11-01T04:00:00Z'), 'UTC');
    expect(ticks.map(t => t.toISOString())).toEqual(['2026-11-01T02:00:00.000Z', '2026-11-01T03:00:00.000Z', '2026-11-01T04:00:00.000Z']);
  });

  it('starts exactly at nightStart when it is already on the hour', () => {
    const ticks = hourTicks(iso('2026-11-01T02:00:00Z'), iso('2026-11-01T03:00:00Z'), 'UTC');
    expect(ticks.map(t => t.toISOString())).toEqual(['2026-11-01T02:00:00.000Z', '2026-11-01T03:00:00.000Z']);
  });

  it('is empty when the window is shorter than the gap to the next hour', () => {
    expect(hourTicks(iso('2026-11-01T01:10:00Z'), iso('2026-11-01T01:40:00Z'), 'UTC')).toEqual([]);
  });

  it('keeps labels on :00 in the observer zone even where the zone has a 30 minute offset', () => {
    // India is UTC+5:30, so :00 there is :30 in UTC.
    const ticks = hourTicks(iso('2026-11-01T14:00:00Z'), iso('2026-11-01T17:00:00Z'), 'Asia/Kolkata');
    expect(ticks.map(t => t.toISOString())).toEqual(['2026-11-01T14:30:00.000Z', '2026-11-01T15:30:00.000Z', '2026-11-01T16:30:00.000Z']);
    for (const t of ticks) expect(formatHm(t, 'Asia/Kolkata').endsWith(':00')).toBe(true);
  });

  it('every tick is an hour apart, inside the window, and on the hour in the zone', () => {
    const zones = ['UTC', 'Asia/Kolkata', 'America/St_Johns', 'Australia/Lord_Howe', 'Pacific/Chatham'];
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) }),
        fc.integer({ min: 0, max: 14 * HOUR }),
        fc.constantFrom(...zones),
        (startMs, lengthMs, zone) => {
          const start = new Date(startMs);
          const end = new Date(startMs + lengthMs);
          const ticks = hourTicks(start, end, zone);
          ticks.forEach((t, i) => {
            expect(t.getTime()).toBeGreaterThanOrEqual(start.getTime());
            expect(t.getTime()).toBeLessThanOrEqual(end.getTime());
            expect(formatHm(t, zone).endsWith(':00')).toBe(true);
            if (i > 0) expect(t.getTime() - ticks[i - 1].getTime()).toBe(HOUR);
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
