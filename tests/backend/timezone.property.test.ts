import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  addDaysToDateKey,
  dateKeyFromParts,
  localDateKey,
  localParts,
  zonedDateTimeToUtc,
} from '../../server/lib/timezone';
import { isPlausibleCalendarDate } from '../../server/lib/telescopeFiles';

/**
 * Property tests for the timezone helpers. Pure: no DB.
 *
 * Zones cover: no DST (UTC, Asia/Kolkata +05:30, Asia/Kathmandu +05:45),
 * northern DST (America/New_York, Europe/London), southern DST
 * (Australia/Sydney), a half-hour DST shift (Australia/Lord_Howe), and an
 * odd-offset DST zone (America/St_Johns -03:30).
 */

const NUM_RUNS = 150;
const HOUR_MS = 3_600_000;

const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/London',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'America/St_Johns',
  'Asia/Kolkata',
  'Asia/Kathmandu',
] as const;

const zoneArb = fc.constantFrom(...ZONES);

/** A whole-second UTC instant (Intl only reports whole seconds). */
const instantArb = fc
  .integer({ min: Date.UTC(1995, 0, 1) / 1000, max: Date.UTC(2045, 0, 1) / 1000 })
  .map(sec => new Date(sec * 1000));

/** A wall-clock reading that may or may not exist in a given zone. */
const wallArb = fc.record({
  dateKey: fc
    .date({ min: new Date('1995-01-01T00:00:00Z'), max: new Date('2045-01-01T00:00:00Z'), noInvalidDate: true })
    .map(d => d.toISOString().slice(0, 10)),
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  second: fc.integer({ min: 0, max: 59 }),
});

const wallMs = (p: { year: number; month: number; day: number; hour: number; minute: number; second: number }) =>
  Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

describe('zonedDateTimeToUtc - property tests', () => {
  it('UTC -> zoned -> UTC: lands on an instant with the same wall clock, never later', () => {
    fc.assert(
      fc.property(instantArb, zoneArb, (t, tz) => {
        const p = localParts(t, tz);
        const back = zonedDateTimeToUtc(localDateKey(t, tz), { hour: p.hour, minute: p.minute, second: p.second }, tz);

        expect(localParts(back, tz)).toEqual(p);
        // Unambiguous wall times round-trip exactly; a fall-back repeat
        // resolves to the earlier occurrence, at most one DST shift earlier.
        expect(back.getTime()).toBeLessThanOrEqual(t.getTime());
        expect(t.getTime() - back.getTime()).toBeLessThanOrEqual(HOUR_MS);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is exact for instants that are not inside a fall-back repeat', () => {
    fc.assert(
      fc.property(instantArb, zoneArb, (t, tz) => {
        const p = localParts(t, tz);
        // Same wall clock one shift earlier/later means this wall time repeats.
        const offset = (ms: number) => wallMs(localParts(new Date(ms), tz)) - ms;
        fc.pre(offset(t.getTime() - 2 * HOUR_MS) === offset(t.getTime() + 2 * HOUR_MS));

        const back = zonedDateTimeToUtc(localDateKey(t, tz), { hour: p.hour, minute: p.minute, second: p.second }, tz);
        expect(back.getTime()).toBe(t.getTime());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('zoned -> UTC -> zoned: reproduces the wall clock, or the spring-forward instant for a skipped time', () => {
    fc.assert(
      fc.property(wallArb, zoneArb, (w, tz) => {
        const utc = zonedDateTimeToUtc(w.dateKey, { hour: w.hour, minute: w.minute, second: w.second }, tz);
        const [year, month, day] = w.dateKey.split('-').map(Number);
        const target = wallMs({ year, month, day, hour: w.hour, minute: w.minute, second: w.second });
        const got = wallMs(localParts(utc, tz));

        if (got !== target) {
          // DST gap: documented policy is the first valid instant after the
          // target, i.e. the transition itself. One second earlier is still
          // before the target on the wall clock.
          expect(got).toBeGreaterThan(target);
          expect(got - target).toBeLessThanOrEqual(HOUR_MS);
          expect(wallMs(localParts(new Date(utc.getTime() - 1000), tz))).toBeLessThan(target);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is monotonic in the wall clock within a day', () => {
    fc.assert(
      fc.property(wallArb, wallArb, zoneArb, (a, b, tz) => {
        const ta = zonedDateTimeToUtc(a.dateKey, a, tz).getTime();
        const tb = zonedDateTimeToUtc(a.dateKey, b, tz).getTime();
        const wa = a.hour * 3600 + a.minute * 60 + a.second;
        const wb = b.hour * 3600 + b.minute * 60 + b.second;
        // Allow the one-hour fold: a later wall time in the repeated hour can
        // map to an instant before an earlier wall time just after the fold.
        if (wa < wb) expect(tb).toBeGreaterThanOrEqual(ta - HOUR_MS);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('throws a clear RangeError for any dateKey with a non-numeric component', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter(s => /[^0-9\s+\-.eExXoObB]/.test(s) && !s.includes('-')),
        fc.integer({ min: 0, max: 2 }),
        zoneArb,
        (junk, position, tz) => {
          const parts = ['2026', '06', '15'];
          parts[position] = junk;
          const key = parts.join('-');
          fc.pre(parts.map(Number).some(n => !Number.isFinite(n)));
          expect(() => zonedDateTimeToUtc(key, { hour: 12 }, tz)).toThrow(/zonedDateTimeToUtc: malformed input/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('addDaysToDateKey - property tests', () => {
  const keyArb = fc
    .date({ min: new Date('1995-01-01T00:00:00Z'), max: new Date('2045-01-01T00:00:00Z'), noInvalidDate: true })
    .map(d => d.toISOString().slice(0, 10));

  it('n then -n is the identity, and every result is a real calendar day', () => {
    fc.assert(
      fc.property(keyArb, fc.integer({ min: -3000, max: 3000 }), (key, n) => {
        const moved = addDaysToDateKey(key, n);
        expect(isPlausibleCalendarDate(moved)).toBe(true);
        expect(addDaysToDateKey(moved, -n)).toBe(key);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('agrees with UTC day arithmetic', () => {
    fc.assert(
      fc.property(keyArb, fc.integer({ min: -3000, max: 3000 }), (key, n) => {
        const expected = new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
        expect(addDaysToDateKey(key, n)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('localDateKey of any instant is a real calendar day matching localParts', () => {
    fc.assert(
      fc.property(instantArb, zoneArb, (t, tz) => {
        const key = localDateKey(t, tz);
        const p = localParts(t, tz);
        expect(isPlausibleCalendarDate(key)).toBe(true);
        expect(key).toBe(dateKeyFromParts(p.year, p.month, p.day));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('zonedDateTimeToUtc - malformed input regression (audit bug 3)', () => {
  it('names the bad argument instead of failing deep inside Intl', () => {
    expect(() => zonedDateTimeToUtc('abc', { hour: 12 }, 'UTC')).toThrow(RangeError);
    expect(() => zonedDateTimeToUtc('abc', { hour: 12 }, 'UTC')).toThrow(/malformed input dateKey="abc"/);
    expect(() => zonedDateTimeToUtc('2026-06-15', { hour: Number.NaN }, 'UTC')).toThrow(/malformed input/);
  });

  it('keeps valid-input results unchanged', () => {
    expect(zonedDateTimeToUtc('2026-06-17', { hour: 12 }, 'America/Los_Angeles').toISOString()).toBe('2026-06-17T19:00:00.000Z');
    expect(zonedDateTimeToUtc('2026-03-08', { hour: 2, minute: 30 }, 'America/New_York').toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  // Still open, deliberately not fixed here. routes/planner.ts validates
  // `?date=` with a regex only (/^\d{4}-\d{2}-\d{2}$/), so '2026-13-40'
  // reaches parseLocalNoon and today silently plans 2027-02-09 with a 200.
  // Throwing here would turn that into a 500; the right fix is a calendar
  // refine on the planner's zod schema (outside this change's scope), after
  // which this can throw too. Flip to `it` when that lands.
  it.fails('rejects calendar-invalid but numeric dateKeys instead of rolling them over', () => {
    expect(() => zonedDateTimeToUtc('2026-13-40', { hour: 12 }, 'UTC')).toThrow();
  });
});
