/**
 * A cached forecast, made right for one site.
 *
 * The forecast is cached per grid cell and built with the default window, so two sites in one cell can share it.
 * Their imaging windows (lib/imagingWindow.ts) can differ, and the night scores depend on the window, so both are
 * settled here per request and never written back to the cache.
 */
import type { ObservingSite } from './observingSites.js';
import { isDefaultWindow, resolveWindowFromIso, windowPrefsOf } from './imagingWindow.js';
import { scoreObservingNight } from './nightConditions.js';
import type { ForecastHour } from './forecastCache.js';
import { isRecord } from './typeGuards.js';

/**
 * Adds `tonight.imagingWindow` (the site's window for tonight, null when its settings leave none) and, for a site off
 * the default window, scores `nightRatings` again over that window's hours. Returns `data` untouched when it is not a
 * forecast.
 */
export function forecastForSite<T>(data: T, site: ObservingSite): T {
  if (!isRecord(data) || !isRecord(data.tonight)) return data;
  const prefs = windowPrefsOf(site);
  const tonight = data.tonight;
  const str = (k: string) => (typeof tonight[k] === 'string' ? tonight[k] : null);
  const win = resolveWindowFromIso({
    astronomicalTwilightEnd: str('astronomicalTwilightEnd'),
    astronomicalTwilightStart: str('astronomicalTwilightStart'),
    nauticalTwilightEnd: str('nauticalTwilightEnd'),
    nauticalTwilightStart: str('nauticalTwilightStart'),
  }, prefs);

  let nightRatings = data.nightRatings;
  // The coordinates the cached forecast was built for, so these scores match the default ones in every way but the window.
  const lat = isRecord(data.location) && typeof data.location.lat === 'number' ? data.location.lat : null;
  const lon = isRecord(data.location) && typeof data.location.lon === 'number' ? data.location.lon : null;
  if (!isDefaultWindow(prefs) && Array.isArray(nightRatings) && Array.isArray(data.hourly) && lat !== null && lon !== null) {
    const hours = data.hourly as ForecastHour[];
    const tz = typeof data.timezone === 'string' ? data.timezone : '';
    nightRatings = nightRatings.flatMap((r: unknown) => {
      if (!isRecord(r) || typeof r.date !== 'string') return [];
      const score = scoreObservingNight(hours, r.date, lat, lon, tz, prefs);
      return score ? [{ ...r, ...score }] : [];
    });
  }

  return {
    ...data,
    ...(nightRatings !== undefined ? { nightRatings } : {}),
    tonight: {
      ...tonight,
      imagingWindow: win
        ? { start: win.start.toISOString(), end: win.end.toISOString(), darkness: win.darkness, startOffsetMin: prefs.startOffsetMin, endOffsetMin: prefs.endOffsetMin }
        : null,
    },
  };
}
