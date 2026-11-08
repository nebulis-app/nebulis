/**
 * The browser and the server each carry a copy of the imaging window rules (src/lib/imagingWindow.ts and
 * server/lib/imagingWindow.ts), because they cannot share a source file. They must give the same window for any
 * site and night, or the Planner and the Forecast would disagree about "tonight".
 */
import { describe, it, expect, vi } from 'vitest';
import * as server from '../../server/lib/imagingWindow';
import * as client from '../../src/lib/imagingWindow';
import { getNightWindow } from '../../server/lib/astroCalc';
import { nightWindowFor } from '../../src/lib/nightWindow';
import { computeBestImagingWindow as serverBest } from '../../server/lib/bestImagingWindow';
import { computeBestImagingWindow as clientBest } from '../../src/lib/bestImagingWindow';
import { lookupTimeZoneForCoordinates } from '../../server/lib/observerTimezone';

const d = (s: string | null) => (s ? new Date(s) : null);
const NIGHT = {
  astronomicalDusk: d('2026-10-09T02:02:00Z'), astronomicalDawn: d('2026-10-09T12:38:00Z'),
  nauticalDusk: d('2026-10-09T01:27:00Z'), nauticalDawn: d('2026-10-09T13:13:00Z'),
};
const NO_ASTRO = { ...NIGHT, astronomicalDusk: null, astronomicalDawn: null };
const NONE = { astronomicalDusk: null, astronomicalDawn: null, nauticalDusk: null, nauticalDawn: null };

const PREFS: client.ImagingWindowPrefs[] = [
  { darkness: 'astronomical', startOffsetMin: 0, endOffsetMin: 0 },
  { darkness: 'nautical', startOffsetMin: 0, endOffsetMin: 0 },
  { darkness: 'nautical', startOffsetMin: 30, endOffsetMin: 60 },
  { darkness: 'astronomical', startOffsetMin: -45, endOffsetMin: -30 },
  { darkness: 'astronomical', startOffsetMin: 360, endOffsetMin: 360 },
  { darkness: 'nautical', startOffsetMin: 9999, endOffsetMin: -9999 },
];

describe('imaging window: browser and server rules agree', () => {
  it('resolves the same window for every kind of night and every setting', () => {
    for (const night of [NIGHT, NO_ASTRO, NONE]) {
      for (const prefs of PREFS) {
        expect(client.resolveWindow(night, prefs)).toEqual(server.resolveWindow(night, prefs));
      }
    }
  });

  it('reads a site’s settings the same way, defaulting what is missing', () => {
    for (const site of [null, {}, { darkness: 'nautical' as const, windowStartOffsetMin: 30 }, { darkness: 'astronomical' as const, windowEndOffsetMin: 1000 }]) {
      expect(client.windowPrefsOf(site)).toEqual(server.windowPrefsOf(site));
    }
    expect(client.DEFAULT_WINDOW_PREFS).toEqual(server.DEFAULT_WINDOW_PREFS);
    expect([client.WINDOW_OFFSET_MIN, client.WINDOW_OFFSET_MAX]).toEqual([server.WINDOW_OFFSET_MIN, server.WINDOW_OFFSET_MAX]);
  });

  it('gives the same night for a real site, from SunCalc on each side', () => {
    const sites = [
      { lat: 33.45, lon: -112.07 },   // Phoenix
      { lat: 51.5074, lon: -0.1278 }, // London
      { lat: 64.1466, lon: -21.9426 },// Reykjavik: no astronomical dark in June
      { lat: -33.8688, lon: 151.2093 },
    ];
    for (const { lat, lon } of sites) {
      for (const prefs of PREFS) {
        const clientDay = new Date(2026, 5, 20, 12);
        const clientWin = nightWindowFor(clientDay, lat, lon, prefs);
        // The browser anchors at mean solar noon of the observer's day; so does the server's best-months chart.
        const utcNoon = Date.UTC(2026, 5, 20, 12);
        const anchor = new Date(utcNoon - (lon / 15) * 3_600_000);
        const serverWin = getNightWindow(anchor, lat, lon, prefs).imaging;
        expect(clientWin?.start.getTime() ?? null).toBe(serverWin?.start.getTime() ?? null);
        expect(clientWin?.end.getTime() ?? null).toBe(serverWin?.end.getTime() ?? null);
      }
    }
  });

  it('draws the same best-months chart under a changed window', () => {
    const now = new Date('2026-10-27T18:00:00Z');
    const lat = 40.7128, lon = -74.006;
    const tz = lookupTimeZoneForCoordinates(lat, lon) ?? undefined;
    for (const prefs of PREFS.slice(0, 4)) {
      const s = serverBest(5.58, -5.39, lat, lon, 20, now, prefs);
      // The browser reads "now" itself, so pin it to the instant the server was given.
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const c = clientBest(5.58, -5.39, lat, lon, 20, tz, prefs);
      vi.useRealTimers();
      expect(c.months.map(m => [m.label, m.maxAlt, m.aboveMinAlt])).toEqual(s.months.map(m => [m.label, m.maxAlt, m.aboveMinAlt]));
    }
  });
});
