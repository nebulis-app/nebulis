import { describe, it, expect, beforeEach } from 'vitest';
import db from '../../server/lib/db';
import {
  DEFAULT_WINDOW_PREFS,
  isDefaultWindow,
  resolveWindow,
  windowPrefsKey,
  windowPrefsOf,
  type ImagingWindowPrefs,
} from '../../server/lib/imagingWindow';
import { getNightWindow } from '../../server/lib/astroCalc';
import { nightWindow, scoreObservingNight } from '../../server/lib/nightConditions';
import { darkWindow } from '../../server/lib/alerts/clearNight';
import { computeBestImagingWindow, isUpTonight } from '../../server/lib/bestImagingWindow';
import { forecastForSite } from '../../server/lib/forecastForSite';
import { createSite, getSite, updateSite, type ObservingSite } from '../../server/lib/observingSites';
import { zonedDateTimeToUtc } from '../../server/lib/timezone';
import type { ForecastHour } from '../../server/lib/forecastCache';

// Phoenix has no daylight saving, so local = UTC-7 all year.
const LAT = 33.45, LON = -112.07, TZ = 'America/Phoenix';
const NIGHT = '2026-10-08';
const d = (s: string) => new Date(s);
const MINUTE = 60_000;

const NARROWBAND: ImagingWindowPrefs = { darkness: 'nautical', startOffsetMin: 30, endOffsetMin: 60 };

const TWILIGHT = {
  astronomicalDusk: d('2026-10-09T02:02:00Z'), astronomicalDawn: d('2026-10-09T12:38:00Z'),
  nauticalDusk: d('2026-10-09T01:27:00Z'), nauticalDawn: d('2026-10-09T13:13:00Z'),
};

describe('resolveWindow', () => {
  it('is the astronomical night by default', () => {
    expect(resolveWindow(TWILIGHT)).toEqual({ start: TWILIGHT.astronomicalDusk, end: TWILIGHT.astronomicalDawn, darkness: 'astronomical' });
  });

  it('starts from the nautical night when asked, and moves either end by the offsets', () => {
    const w = resolveWindow(TWILIGHT, NARROWBAND)!;
    expect(w.darkness).toBe('nautical');
    expect(w.start.getTime()).toBe(TWILIGHT.nauticalDusk.getTime() + 30 * MINUTE);
    expect(w.end.getTime()).toBe(TWILIGHT.nauticalDawn.getTime() - 60 * MINUTE);
  });

  it('lets a negative offset move that end the other way', () => {
    const w = resolveWindow(TWILIGHT, { darkness: 'astronomical', startOffsetMin: -20, endOffsetMin: -15 })!;
    expect(w.start.getTime()).toBe(TWILIGHT.astronomicalDusk.getTime() - 20 * MINUTE);
    expect(w.end.getTime()).toBe(TWILIGHT.astronomicalDawn.getTime() + 15 * MINUTE);
  });

  it('falls back to nautical where it never gets astronomically dark', () => {
    const summer = { ...TWILIGHT, astronomicalDusk: null, astronomicalDawn: null };
    expect(resolveWindow(summer)).toEqual({ start: TWILIGHT.nauticalDusk, end: TWILIGHT.nauticalDawn, darkness: 'nautical' });
  });

  it('is null when there is no night at either level, or the offsets leave nothing', () => {
    expect(resolveWindow({ astronomicalDusk: null, astronomicalDawn: null, nauticalDusk: null, nauticalDawn: null })).toBeNull();
    expect(resolveWindow(TWILIGHT, { darkness: 'astronomical', startOffsetMin: 360, endOffsetMin: 360 })).toBeNull();
  });
});

describe('windowPrefsOf', () => {
  it('defaults what is missing and holds the rest to the allowed range', () => {
    expect(windowPrefsOf(null)).toEqual(DEFAULT_WINDOW_PREFS);
    expect(windowPrefsOf({ darkness: 'civil', windowStartOffsetMin: 'soon' })).toEqual(DEFAULT_WINDOW_PREFS);
    expect(windowPrefsOf({ darkness: 'nautical', windowStartOffsetMin: 9999, windowEndOffsetMin: -9999 }))
      .toEqual({ darkness: 'nautical', startOffsetMin: 360, endOffsetMin: -180 });
  });

  it('tells the default window from a changed one, and keys caches on every part of it', () => {
    expect(isDefaultWindow(DEFAULT_WINDOW_PREFS)).toBe(true);
    expect(isDefaultWindow(NARROWBAND)).toBe(false);
    const keys = new Set([
      windowPrefsKey(DEFAULT_WINDOW_PREFS),
      windowPrefsKey({ ...DEFAULT_WINDOW_PREFS, darkness: 'nautical' }),
      windowPrefsKey({ ...DEFAULT_WINDOW_PREFS, startOffsetMin: 15 }),
      windowPrefsKey({ ...DEFAULT_WINDOW_PREFS, endOffsetMin: 15 }),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe('a site stores its window', () => {
  beforeEach(() => {
    db.prepare("DELETE FROM observingSites WHERE name LIKE 'Window test%'").run();
  });

  it('defaults to the astronomical night and keeps what is saved', () => {
    const plain = createSite({ name: 'Window test plain', latitude: LAT, longitude: LON });
    expect(windowPrefsOf(plain)).toEqual(DEFAULT_WINDOW_PREFS);

    const site = createSite({ name: 'Window test narrowband', latitude: LAT, longitude: LON, darkness: 'nautical', windowStartOffsetMin: 30, windowEndOffsetMin: 60 });
    expect(windowPrefsOf(getSite(site.id))).toEqual(NARROWBAND);

    const edited = updateSite(site.id, { windowEndOffsetMin: 999 });
    expect(edited?.windowEndOffsetMin).toBe(360);
    expect(edited?.darkness).toBe('nautical');
  });
});

describe('every consumer agrees on tonight for a site', () => {
  const anchor = zonedDateTimeToUtc(NIGHT, { hour: 12 }, TZ);

  it.each([
    ['the default window', DEFAULT_WINDOW_PREFS],
    ['a narrowband window', NARROWBAND],
    ['a window pulled in at both ends', { darkness: 'astronomical', startOffsetMin: 90, endOffsetMin: 120 } as ImagingWindowPrefs],
  ])('%s: the night model, the score, the alert and the forecast report the same hours', (_name, prefs) => {
    const imaging = getNightWindow(anchor, LAT, LON, prefs).imaging!;
    expect(imaging).not.toBeNull();

    const scoring = nightWindow(NIGHT, LAT, LON, TZ, prefs)!;
    expect(scoring.coreStart).toEqual(imaging.start);
    expect(scoring.coreEnd).toEqual(imaging.end);

    const alert = darkWindow(NIGHT, LAT, LON, TZ, prefs)!;
    expect(alert.start).toEqual(imaging.start);
    expect(alert.end).toEqual(imaging.end);
  });

  it('the default window is the astronomical night, as before the setting existed', () => {
    const w = getNightWindow(anchor, LAT, LON);
    expect(w.imaging).toEqual({ start: w.nightStart, end: w.nightEnd, darkness: 'astronomical' });
  });

  it('a nautical window opens earlier than the astronomical one', () => {
    const astro = getNightWindow(anchor, LAT, LON).imaging!;
    const nautical = getNightWindow(anchor, LAT, LON, { ...DEFAULT_WINDOW_PREFS, darkness: 'nautical' }).imaging!;
    expect(nautical.start.getTime()).toBeLessThan(astro.start.getTime());
    expect(nautical.end.getTime()).toBeGreaterThan(astro.end.getTime());
  });

  it('the best-months chart and "up tonight" follow the window too', () => {
    // A window pulled in far enough to hold only the first minutes of the night changes what is up.
    const base = computeBestImagingWindow(5.59, -5.4, LAT, LON, 20, anchor);
    const narrow = computeBestImagingWindow(5.59, -5.4, LAT, LON, 20, anchor, { darkness: 'astronomical', startOffsetMin: 0, endOffsetMin: 360 });
    expect(narrow.months.some((m, i) => m.maxAlt !== base.months[i].maxAlt)).toBe(true);
    expect(typeof isUpTonight(5.59, -5.4, LAT, LON, 20, anchor, TZ, NARROWBAND)).toBe('boolean');
  });
});

describe('forecastForSite', () => {
  const hour = (iso: string, cloud: number): ForecastHour => ({
    time: iso, cloudCover: cloud, cloudCoverLow: 5, cloudCoverMid: 3, cloudCoverHigh: 2,
    seeing: 2, transparency: 3, humidity: 50, temperature: 18, dewPoint: 8, wind: 8,
    visibility: 24000, precipProb: 0, jetStream: 30, cape: 0,
  });
  // Clear until local 23:00, then overcast, so a window that stops early scores better than one that runs to dawn.
  const hourly = Array.from({ length: 15 }, (_, i) => {
    const t = new Date(Date.UTC(2026, 9, 9, 0 + i));
    return hour(t.toISOString(), i < 7 ? 5 : 95);
  });
  const forecast = {
    location: { lat: LAT, lon: LON },
    timezone: TZ,
    hourly,
    tonight: {
      astronomicalTwilightEnd: TWILIGHT.astronomicalDusk.toISOString(),
      astronomicalTwilightStart: TWILIGHT.astronomicalDawn.toISOString(),
      nauticalTwilightEnd: TWILIGHT.nauticalDusk.toISOString(),
      nauticalTwilightStart: TWILIGHT.nauticalDawn.toISOString(),
    },
    nightRatings: [{ date: NIGHT, score: 50, rating: 'Fair', avgCloudCover: 50, avgHumidity: 50, avgWind: 8, precipChance: 0, confidence: 'normal' }],
  };
  const site = (over: Partial<ObservingSite>): ObservingSite => ({ ...(createSiteStub()), ...over });

  function createSiteStub(): ObservingSite {
    return {
      id: 's', name: 'S', latitude: LAT, longitude: LON, timezone: TZ, minAlt: 20, horizonProfile: [], visibleSkyMap: [],
      bortleClass: null, darkness: 'astronomical', windowStartOffsetMin: 0, windowEndOffsetMin: 0, isDefault: false, sortOrder: 0, createdAt: '',
    };
  }

  it('adds the site’s window and leaves the default site’s ratings alone', () => {
    const out = forecastForSite(forecast, site({})) as typeof forecast & { tonight: { imagingWindow: { start: string; end: string } } };
    expect(out.tonight.imagingWindow.start).toBe(TWILIGHT.astronomicalDusk.toISOString());
    expect(out.tonight.imagingWindow.end).toBe(TWILIGHT.astronomicalDawn.toISOString());
    expect(out.nightRatings).toBe(forecast.nightRatings);
  });

  it('scores the nights again over the site’s own window, so two sites on one forecast can differ', () => {
    const early = site({ windowEndOffsetMin: 300 });
    const out = forecastForSite(forecast, early) as typeof forecast;
    const expected = scoreObservingNight(hourly, NIGHT, LAT, LON, TZ, windowPrefsOf(early))!;
    expect(out.nightRatings[0].score).toBe(expected.score);
    expect(out.nightRatings[0].confidence).toBe('normal');
    const dawn = forecastForSite(forecast, site({})) as typeof forecast;
    expect(out.nightRatings[0].score).not.toBe(scoreObservingNight(hourly, NIGHT, LAT, LON, TZ)!.score);
    expect(dawn.nightRatings).toBe(forecast.nightRatings);
  });

  it('reports no window when the settings leave none', () => {
    const out = forecastForSite(forecast, site({ windowStartOffsetMin: 360, windowEndOffsetMin: 360 })) as typeof forecast & { tonight: { imagingWindow: unknown } };
    expect(out.tonight.imagingWindow).toBeNull();
  });

  it('hands back anything that is not a forecast untouched', () => {
    expect(forecastForSite(null, site({}))).toBeNull();
    const odd = { hourly: [] };
    expect(forecastForSite(odd, site({}))).toBe(odd);
  });
});
