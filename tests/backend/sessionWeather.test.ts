import { describe, it, expect } from 'vitest';
import { nightHourIndices } from '../../server/lib/library/observations';

/** Open-Meteo with `timezone=auto` returns naive local timestamps for the site. */
function localDay(date: string): string[] {
  return Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
}

describe('nightHourIndices', () => {
  it('selects 20:00-23:00 and 00:00-03:00 from a full local day', () => {
    const times = localDay('2026-01-15');
    expect(nightHourIndices(times)).toEqual([0, 1, 2, 3, 20, 21, 22, 23]);
  });

  it('reads the hour lexically, independent of the server timezone', () => {
    // The bug: `new Date("2026-01-15T20:00").getHours()` returns the hour in
    // the *server* TZ. A server in UTC reading a Denver session (UTC-7) would
    // have bucketed 13:00-20:00 local instead of the real night. The lexical
    // read is correct regardless of process.env.TZ.
    const times = localDay('2026-01-15');
    const before = process.env.TZ;
    try {
      process.env.TZ = 'America/Denver';
      expect(nightHourIndices(times)).toEqual([0, 1, 2, 3, 20, 21, 22, 23]);
      process.env.TZ = 'Asia/Tokyo';
      expect(nightHourIndices(times)).toEqual([0, 1, 2, 3, 20, 21, 22, 23]);
    } finally {
      // Assigning undefined to process.env stores the string "undefined".
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('falls back to every index when nothing lands in the night window', () => {
    const times = ['2026-06-21T10:00', '2026-06-21T11:00', '2026-06-21T12:00'];
    expect(nightHourIndices(times)).toEqual([0, 1, 2]);
  });

  it('does not treat a malformed timestamp as an in-window hour', () => {
    const times = ['garbage', '2026-01-15T21:00'];
    expect(nightHourIndices(times)).toEqual([1]);
  });

  // ─── date-aware selection ────────────────────────────────────────────────
  // A session is keyed by its observing night, so the darkness it describes
  // runs into the NEXT calendar day. Open-Meteo is asked for both days; the
  // window must be 20:00-23:59 of the night date plus 00:00-03:59 of the day
  // after, and never the night date's own small hours (which are the previous
  // night) nor the following day's evening.

  describe('with the observing-night date', () => {
    const times = [...localDay('2026-01-15'), ...localDay('2026-01-16')];

    it('selects only the two days the night actually spans', () => {
      const selected = nightHourIndices(times, '2026-01-15').map(i => times[i]);
      expect(selected).toEqual([
        '2026-01-15T20:00', '2026-01-15T21:00', '2026-01-15T22:00', '2026-01-15T23:00',
        '2026-01-16T00:00', '2026-01-16T01:00', '2026-01-16T02:00', '2026-01-16T03:00',
      ]);
    });

    it('never reaches back into the previous night or forward into the next evening', () => {
      const selected = nightHourIndices(times, '2026-01-15').map(i => times[i]!);
      expect(selected).not.toContain('2026-01-15T00:00'); // previous night's morning
      expect(selected).not.toContain('2026-01-15T03:00');
      expect(selected).not.toContain('2026-01-16T20:00'); // tomorrow night's evening
      expect(selected).not.toContain('2026-01-16T23:00');
    });

    it('rolls the second day across a month and a year boundary', () => {
      const monthEnd = [...localDay('2026-01-31'), ...localDay('2026-02-01')];
      expect(nightHourIndices(monthEnd, '2026-01-31').map(i => monthEnd[i]))
        .toEqual([
          '2026-01-31T20:00', '2026-01-31T21:00', '2026-01-31T22:00', '2026-01-31T23:00',
          '2026-02-01T00:00', '2026-02-01T01:00', '2026-02-01T02:00', '2026-02-01T03:00',
        ]);
      const yearEnd = [...localDay('2026-12-31'), ...localDay('2027-01-01')];
      expect(nightHourIndices(yearEnd, '2026-12-31')).toHaveLength(8);
      expect(yearEnd[nightHourIndices(yearEnd, '2026-12-31')[4]!]).toBe('2027-01-01T00:00');
    });
  });
});
