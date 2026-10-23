import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseFilename, isPlausibleCalendarDate } from '../../server/lib/telescopeFiles';

/**
 * Property tests for parseFilename's date output. Pure: no DB, no filesystem.
 *
 * Invariant: whatever a filename looks like, a `date` that comes out of
 * parseFilename is a real calendar day, and its `timestamp` (when present)
 * agrees with it. Garbage digits in a well-formed name mean "no date",
 * never an impossible one (audit bug 2: '5480-51-40').
 */

const NUM_RUNS = 200;

/** A parsed filename minus the fields a bad calendar date is allowed to change. */
function withoutDateFields(parsed: ReturnType<typeof parseFilename>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...parsed };
  delete rest.date;
  delete rest.timestamp;
  return rest;
}

const digits = (n: number) =>
  fc.array(fc.constantFrom(...'0123456789'.split('')), { minLength: n, maxLength: n }).map(a => a.join(''));

/** Any 8 digits: mostly impossible dates, which is the point. */
const anyYmdArb = digits(8);

/** A real calendar day, written YYYYMMDD. */
const realYmdArb = fc
  .date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true })
  .map(d => d.toISOString().slice(0, 10).replace(/-/g, ''));

const hmsArb = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m, s]) => [h, m, s].map(n => String(n).padStart(2, '0')).join(''));

const targetArb = fc.constantFrom('M42', 'M 81', 'NGC 6992', 'IC 5070', 'Sh2-155', 'Lunar');

/** Device-shaped names built around a given YYYYMMDD and HHMMSS. */
function deviceNames(ymd: string, hms: string, target: string): string[] {
  return [
    `Stacked_150_${target}_10.0s_IRCUT_${ymd}-${hms}A.jpg`,
    `Stacked_150_${target}_10.0s_IRCUT_${ymd}-${hms}_thn.jpg`,
    `sub_00001_${target}_10.0s_LP_${ymd}-${hms}.fit`,
    `DSO_Stacked_1318_${target}_30.0s_${ymd}_${hms}.jpg`,
    `Light_${target.replace(/ /g, '_')}_180s_Bin1_R_gain100_${ymd}-${hms}_0001.fit`,
  ];
}

const dashed = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

function assertDateInvariant(name: string): void {
  const parsed = parseFilename(name);
  if (parsed.date !== undefined) {
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isPlausibleCalendarDate(parsed.date)).toBe(true);
  }
  if (parsed.timestamp !== undefined) {
    expect(parsed.date).toBeDefined();
    expect(parsed.timestamp.slice(0, 8)).toBe(parsed.date!.replace(/-/g, ''));
  }
}

describe('parseFilename - property tests', () => {
  it('never throws, and any date it emits is a real calendar day (arbitrary strings)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), name => {
        assertDateInvariant(name);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('any date it emits is a real calendar day (device-shaped names with arbitrary digits)', () => {
    fc.assert(
      fc.property(anyYmdArb, digits(6), targetArb, (ymd, hms, target) => {
        for (const name of deviceNames(ymd, hms, target)) assertDateInvariant(name);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps the date exactly when the digits are a real day, drops it when they are not', () => {
    fc.assert(
      fc.property(anyYmdArb, hmsArb, targetArb, (ymd, hms, target) => {
        const expected = isPlausibleCalendarDate(dashed(ymd)) ? dashed(ymd) : undefined;
        for (const name of deviceNames(ymd, hms, target)) {
          expect(parseFilename(name).date).toBe(expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts every real calendar date with its timestamp intact (completeness)', () => {
    fc.assert(
      fc.property(realYmdArb, hmsArb, targetArb, (ymd, hms, target) => {
        for (const name of deviceNames(ymd, hms, target)) {
          const parsed = parseFilename(name);
          expect(parsed.date).toBe(dashed(ymd));
          expect(parsed.timestamp).toBe(`${ymd}-${hms}`);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('dropping an impossible date leaves every non-date field unchanged', () => {
    fc.assert(
      fc.property(realYmdArb, anyYmdArb, hmsArb, targetArb, (good, bad, hms, target) => {
        fc.pre(!isPlausibleCalendarDate(dashed(bad)));
        const goodNames = deviceNames(good, hms, target);
        const badNames = deviceNames(bad, hms, target);
        goodNames.forEach((g, i) => {
          const restGood = withoutDateFields(parseFilename(g));
          const restBad = withoutDateFields(parseFilename(badNames[i]));
          expect(restBad).toEqual(restGood);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('isPlausibleCalendarDate - property tests', () => {
  it('agrees with Date round-tripping for every YYYY-MM-DD digit string', () => {
    fc.assert(
      fc.property(anyYmdArb, ymd => {
        const key = dashed(ymd);
        const [y, m, d] = key.split('-').map(Number);
        const probe = new Date(Date.UTC(y, m - 1, d));
        const real =
          m >= 1 && m <= 12 && d >= 1 &&
          probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
        expect(isPlausibleCalendarDate(key)).toBe(real);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts every ISO calendar date', () => {
    fc.assert(
      fc.property(realYmdArb, ymd => {
        expect(isPlausibleCalendarDate(dashed(ymd))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('parseFilename - impossible-date regression (audit bug 2)', () => {
  it("treats '54805140' as no date instead of emitting '5480-51-40'", () => {
    const parsed = parseFilename('Stacked_150_M42_10.0s_IRCUT_54805140-210530A.jpg');
    expect(parsed.date).toBeUndefined();
    expect(parsed.timestamp).toBeUndefined();
    expect(parsed.target).toBe('M42');
  });
});
