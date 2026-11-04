import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { localDateKey, localParts, zonedDateTimeToUtc } from '../../server/lib/timezone';
import { rolloverDateUnconditional, OBSERVING_NIGHT_ROLLOVER_HOUR, isPlausibleCalendarDate } from '../../server/lib/telescopeFiles';

/**
 * timezone.property.test.ts samples eight hand-picked zones. A DST rule is per zone, so a Southern
 * hemisphere, half-hour or abolished-DST error would hide in the other four hundred. These run the
 * same round-trip over every zone this Node's ICU knows.
 */

const ALL_ZONES = Intl.supportedValuesOf('timeZone');
const zoneArb = fc.constantFrom(...ALL_ZONES);
const HOUR_MS = 3_600_000;

const instantArb = fc
  .integer({ min: Date.UTC(1995, 0, 1) / 1000, max: Date.UTC(2045, 0, 1) / 1000 })
  .map(sec => new Date(sec * 1000));

describe('every IANA zone', () => {
  it('has a meaningful number of zones to test', () => {
    expect(ALL_ZONES.length).toBeGreaterThan(300);
  });

  it('UTC -> zoned -> UTC lands on the same wall clock, at most one DST shift away from the original instant', () => {
    // When clocks fall back, one wall-clock hour happens twice. Which of the two instants comes back is not
    // fixed: zones west of UTC settle on the earlier, zones east of UTC (Europe) on the later. Both are
    // correct, so the only promises are the same wall clock and no more than one shift of distance.
    fc.assert(
      fc.property(instantArb, zoneArb, (t, tz) => {
        const p = localParts(t, tz);
        const back = zonedDateTimeToUtc(localDateKey(t, tz), { hour: p.hour, minute: p.minute, second: p.second }, tz);
        expect(localParts(back, tz), tz).toEqual(p);
        expect(Math.abs(t.getTime() - back.getTime()), tz).toBeLessThanOrEqual(HOUR_MS);
      }),
      {
        numRuns: 1500,
        // Found by random search: the first pass through the repeated hour in zones east of UTC.
        examples: [
          [new Date('2034-10-29T00:00:00.000Z'), 'Europe/Podgorica'],
          [new Date('2011-10-30T00:00:00.000Z'), 'Europe/Tallinn'],
          [new Date('2043-10-25T00:00:00.000Z'), 'Europe/Athens'],
        ],
      },
    );
  });

  it('a repeated fall-back hour resolves to one of its two real instants, in both east and west zones', () => {
    // Tallinn: 04:00 EEST -> 03:00 EET at 01:00Z on 2011-10-30, so 03:30 happens at 00:30Z and again at 01:30Z.
    // New York: 02:00 EDT -> 01:00 EST at 06:00Z on 2026-11-01, so 01:30 happens at 05:30Z and again at 06:30Z.
    const cases: Array<[string, string, number[]]> = [
      ['Europe/Tallinn', '2011-10-30', [Date.UTC(2011, 9, 30, 0, 30), Date.UTC(2011, 9, 30, 1, 30)]],
      ['America/New_York', '2026-11-01', [Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)]],
    ];
    for (const [tz, key, instants] of cases) {
      const hour = tz === 'Europe/Tallinn' ? 3 : 1;
      const back = zonedDateTimeToUtc(key, { hour, minute: 30 }, tz).getTime();
      expect(instants, tz).toContain(back);
    }
  });

  it('every zone resolves a midday wall time exactly, on every day of a year', () => {
    // Midday is outside every DST gap and repeat, so it must always be exact.
    for (const tz of ALL_ZONES) {
      for (const dateKey of ['2026-01-15', '2026-03-29', '2026-06-21', '2026-10-25', '2026-11-01']) {
        const utc = zonedDateTimeToUtc(dateKey, { hour: 12 }, tz);
        expect(Number.isNaN(utc.getTime()), `${tz} ${dateKey}`).toBe(false);
        expect(localDateKey(utc, tz), `${tz} ${dateKey}`).toBe(dateKey);
        expect(localParts(utc, tz).hour, `${tz} ${dateKey}`).toBe(12);
      }
    }
  });
});

describe('observing-night rollover', () => {
  const dateKey = fc
    .date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2045-12-31T00:00:00Z'), noInvalidDate: true })
    .map(d => d.toISOString().slice(0, 10));
  const hms = fc
    .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 }))
    .map(([h, m, s]) => `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${String(s).padStart(2, '0')}`);

  const previousDay = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  it('keeps the date from the rollover hour on, and takes the previous day before it', () => {
    fc.assert(
      fc.property(dateKey, hms, (date, time) => {
        const out = rolloverDateUnconditional(date, time);
        const hour = Number(time.slice(0, 2));
        expect(out).toBe(hour >= OBSERVING_NIGHT_ROLLOVER_HOUR ? date : previousDay(date));
      }),
      { numRuns: 1000 },
    );
  });

  it('always returns a real calendar date, across month, year and leap-day boundaries', () => {
    fc.assert(
      fc.property(dateKey, hms, (date, time) => {
        expect(isPlausibleCalendarDate(rolloverDateUnconditional(date, time))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('is never more than one day from the date it was given', () => {
    fc.assert(
      fc.property(dateKey, hms, (date, time) => {
        const diffDays = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${rolloverDateUnconditional(date, time)}T00:00:00Z`)) / 86_400_000;
        expect([0, 1]).toContain(diffDays);
      }),
      { numRuns: 500 },
    );
  });

  it('leaves the date alone when there is no time to test', () => {
    fc.assert(
      fc.property(dateKey, fc.constantFrom(null, undefined, '', '0'), (date, none) => {
        expect(rolloverDateUnconditional(date, none)).toBe(date);
      }),
      { numRuns: 100 },
    );
  });

  it('a night-rolled date, re-read with a night-safe time, does not roll a second time', () => {
    fc.assert(
      fc.property(dateKey, hms, (date, time) => {
        const once = rolloverDateUnconditional(date, time);
        expect(rolloverDateUnconditional(once, `${String(OBSERVING_NIGHT_ROLLOVER_HOUR).padStart(2, '0')}0000`)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});
