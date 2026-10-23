import { describe, it, expect, beforeEach } from 'vitest';
import db from '../../server/lib/db';
import {
  getNightConditions,
  listNightConditions,
  mergeHours,
  nightWindow,
  recordNightConditions,
  summarizeNight,
} from '../../server/lib/nightConditions';
import {
  rateNightConditions,
  snapshotNightConditions,
  forecastSiteKey,
  type ForecastHour,
} from '../../server/lib/forecastCache';

// Phoenix has no daylight saving, so local = UTC-7 all year and the cases below can be read off the clock.
const LAT = 33.45, LON = -112.07, TZ = 'America/Phoenix';
const KEY = forecastSiteKey(LAT, LON);
const NIGHT = '2026-10-08';

/** Local wall clock in Phoenix (UTC-7) as an ISO instant. */
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour + 7)).toISOString();

function hour(time: string, over: Partial<ForecastHour> = {}): ForecastHour {
  return {
    time, cloudCover: 10, cloudCoverLow: 5, cloudCoverMid: 3, cloudCoverHigh: 2,
    seeing: 2, transparency: 3, humidity: 50, temperature: 18, dewPoint: 8, wind: 8,
    visibility: 24000, precipProb: 0, jetStream: 30, cape: 0, ...over,
  };
}

/** Hourly from local 17:00 on the 8th to 07:00 on the 9th. */
function wholeNight(over: (i: number) => Partial<ForecastHour> = () => ({})): ForecastHour[] {
  return Array.from({ length: 15 }, (_, i) => {
    const h = 17 + i;
    return hour(h < 24 ? at(8, h) : at(9, h - 24), over(i));
  });
}

const record = (hourly: ForecastHour[], now: string) =>
  recordNightConditions({ siteKey: KEY, lat: LAT, lon: LON, timezone: TZ, hourly, rate: rateNightConditions, now: new Date(now) });

describe('nightConditions', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM nightConditions').run();
  });

  describe('nightWindow', () => {
    it('runs sunset to sunrise with the dark core inside it', () => {
      const w = nightWindow(NIGHT, LAT, LON, TZ);
      expect(w).not.toBeNull();
      expect(w!.sunrise.getTime()).toBeGreaterThan(w!.sunset.getTime());
      expect(w!.coreStart.getTime()).toBeGreaterThan(w!.sunset.getTime());
      expect(w!.coreEnd.getTime()).toBeLessThan(w!.sunrise.getTime());
      expect(w!.darkHours).toBeGreaterThan(8);
      expect(w!.darkHours).toBeLessThan(11);
    });

    it('gives up where the Sun never sets', () => {
      expect(nightWindow('2026-06-21', 80, 0, 'UTC')).toBeNull();
    });
  });

  describe('recordNightConditions', () => {
    it('keeps the hours around the night and works out the summary from the dark ones', () => {
      const row = record(wholeNight((i) => ({ cloudCover: i < 3 ? 100 : 20, wind: i === 8 ? 25 : 8, seeing: 3 })), at(8, 22));
      expect(row).not.toBeNull();
      expect(row!.night).toBe(NIGHT);
      expect(row!.source).toBe('forecast');
      // The three cloudy evening hours are before astronomical dark, so they do not drag the average.
      expect(row!.avgCloud).toBeLessThan(40);
      expect(row!.maxWind).toBe(25);
      expect(row!.minDewGap).toBe(10);
      expect(row!.medianSeeing).toBe(3);
      expect(row!.moonIllum).toBeGreaterThanOrEqual(0);
      expect(row!.darkHours).toBeGreaterThan(8);
      expect(getNightConditions(KEY, NIGHT)?.hours.length).toBe(row!.hours.length);
    });

    it('drops hours well outside the night', () => {
      const row = record([hour(at(8, 12)), hour(at(8, 20)), hour(at(9, 12))], at(8, 22));
      expect(row!.hours.map((h) => h.time)).toEqual([at(8, 20)]);
    });

    it('keeps the evening when an early-morning fetch only holds the second half of the night', () => {
      record(wholeNight(() => ({ cloudCover: 5, seeing: 1 })), at(8, 21));
      // 03:00 on the 9th is still the night of the 8th. Open-Meteo starts at midnight, and 7Timer has no past hours.
      const morning = Array.from({ length: 8 }, (_, i) => hour(at(9, i), { cloudCover: 90, seeing: null, transparency: null }));
      const row = record(morning, at(9, 3));
      expect(row!.night).toBe(NIGHT);

      const byTime = new Map(row!.hours.map((h) => [h.time, h]));
      expect(byTime.get(at(8, 20))?.cloudCover).toBe(5);
      expect(byTime.get(at(9, 2))?.cloudCover).toBe(90);
      expect(byTime.get(at(9, 2))?.seeing).toBe(1);
      expect(row!.hours.length).toBeGreaterThan(morning.length);
    });

    it('starts a new night once the 7 AM rollover has passed', () => {
      record(wholeNight(), at(8, 22));
      const nextDay = [hour(at(9, 19)), hour(at(9, 20)), hour(at(9, 21)), hour(at(9, 22))];
      const row = recordNightConditions({
        siteKey: KEY, lat: LAT, lon: LON, timezone: TZ, hourly: nextDay, rate: rateNightConditions, now: new Date(at(9, 10)),
      });
      expect(row!.night).toBe('2026-10-09');
      expect(listNightConditions(KEY, '2026-10-01', '2026-10-31').map((r) => r.night)).toEqual([NIGHT, '2026-10-09']);
    });

    it('records nothing when the fetch has no hours for the night', () => {
      expect(record([hour(at(12, 12))], at(8, 22))).toBeNull();
      expect(getNightConditions(KEY, NIGHT)).toBeNull();
    });

    it('records nothing and does not throw where there is no sunset', () => {
      const row = recordNightConditions({
        siteKey: 'polar', lat: 80, lon: 0, timezone: 'UTC', hourly: [hour('2026-06-21T22:00:00.000Z')], rate: rateNightConditions,
        now: new Date('2026-06-21T22:00:00Z'),
      });
      expect(row).toBeNull();
    });

    it('keeps one row per site and night however many fetches arrive', () => {
      record(wholeNight(), at(8, 18));
      record(wholeNight(), at(8, 20));
      record(wholeNight(), at(8, 22));
      expect(listNightConditions(KEY, NIGHT, NIGHT)).toHaveLength(1);
    });
  });

  describe('snapshotNightConditions', () => {
    it('ignores a forecast with no hourly weather', () => {
      snapshotNightConditions({ hourly: [], sources: { weather: null }, timezone: TZ }, LAT, LON);
      expect(db.prepare('SELECT COUNT(*) AS n FROM nightConditions').get()).toEqual({ n: 0 });
    });

    it('shrugs off junk', () => {
      expect(() => snapshotNightConditions('nope', LAT, LON)).not.toThrow();
      expect(() => snapshotNightConditions(null, LAT, LON)).not.toThrow();
      expect(() => snapshotNightConditions({ hourly: [{ time: 'x' }], sources: { weather: 'open-meteo' } }, LAT, LON)).not.toThrow();
    });
  });

  describe('mergeHours and summarizeNight', () => {
    it('lets the newer hour win but keeps the seeing it lacks', () => {
      const t = at(8, 22);
      const merged = mergeHours([hour(t, { cloudCover: 10, seeing: 2 })], [hour(t, { cloudCover: 60, seeing: null })]);
      expect(merged).toHaveLength(1);
      expect(merged[0].cloudCover).toBe(60);
      expect(merged[0].seeing).toBe(2);
    });

    it('sorts by time', () => {
      const merged = mergeHours([hour(at(9, 1))], [hour(at(8, 23))]);
      expect(merged.map((h) => h.time)).toEqual([at(8, 23), at(9, 1)]);
    });

    it('leaves seeing out when no hour has any', () => {
      const w = nightWindow(NIGHT, LAT, LON, TZ)!;
      const s = summarizeNight([hour(at(8, 22), { seeing: null })], w, rateNightConditions);
      expect(s!.medianSeeing).toBeNull();
    });

    it('returns nothing for no hours', () => {
      const w = nightWindow(NIGHT, LAT, LON, TZ)!;
      expect(summarizeNight([], w, rateNightConditions)).toBeNull();
    });
  });
});
