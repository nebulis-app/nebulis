import { describe, it, expect, afterEach } from 'vitest';
import { moonTimesForNight } from '../../server/lib/moonTimes';

// SunCalc.getMoonTimes() without inUTC searches from the host's local midnight, so a UTC Docker install and a Mac in
// Chicago disagreed about the same night's moonset by a whole day.
const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// Chicago, sunset on 2026-10-30 is about 17:55 CDT.
const CHICAGO = { lat: 41.88, lon: -87.63 };
const SUNSET = new Date('2026-10-30T22:55:00Z');

describe('moonTimesForNight', () => {
  it('gives the same answer whatever the host time zone is', () => {
    const results = ['UTC', 'America/Chicago', 'Pacific/Auckland', 'Asia/Kolkata'].map(tz => {
      process.env.TZ = tz;
      const { rise, set } = moonTimesForNight(SUNSET, CHICAGO.lat, CHICAGO.lon);
      return [rise?.toISOString(), set?.toISOString()];
    });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('never returns an event from before the night began', () => {
    const { rise, set } = moonTimesForNight(SUNSET, CHICAGO.lat, CHICAGO.lon);
    expect(rise).not.toBeNull();
    expect(set).not.toBeNull();
    expect(rise!.getTime()).toBeGreaterThanOrEqual(SUNSET.getTime());
    expect(set!.getTime()).toBeGreaterThanOrEqual(SUNSET.getTime());
  });

  it('finds the evening moonrise and the following afternoon moonset for 30 Oct 2026', () => {
    const { rise, set } = moonTimesForNight(SUNSET, CHICAGO.lat, CHICAGO.lon);
    // Rise ~21:22 CDT that evening, set ~12:39 CDT the next day (the old code reported the set a day earlier).
    expect(rise!.toISOString().slice(0, 13)).toBe('2026-10-31T02');
    expect(set!.getTime()).toBeGreaterThan(rise!.getTime());
  });
});
