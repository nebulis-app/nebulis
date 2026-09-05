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
      process.env.TZ = before;
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
});
