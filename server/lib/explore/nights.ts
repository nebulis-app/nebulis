/**
 * Ranked upcoming nights for one object: how high it gets, how long it is up
 * and what the moon does. Geometry only; no cloud forecast.
 *
 * The caller supplies each night's dark window, because deriving it needs the
 * observer's timezone handling that lives with the planner route. That keeps
 * this a pure function the golden generator can call too.
 */
import SunCalc from 'suncalc';
import type { DsoEntry } from '../dsoCatalog.js';
import { visibilityWindow } from '../astroCalc.js';
import { checkMoonProximity } from '../moonProximity.js';

export interface GoodNight {
  date: string;
  score: number;
  maxAlt: number;
  visibleHours: number;
  moonIllumination: number;
  moonVerdict: 'ok' | 'caution' | 'warning';
  minMoonSeparation: number | null;
  nightStart: string;
  nightEnd: string;
  isBest: boolean;
}

export interface NightSite {
  lat: number;
  lon: number;
  minAlt: number;
  horizonProfile?: number[];
  timezone: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** `dates` are the consecutive evenings (YYYY-MM-DD) to rank; `darkWindowFor` returns each one's dark window or null. */
export function rankNights(
  entry: DsoEntry,
  site: NightSite,
  dates: string[],
  darkWindowFor: (date: string) => { start: Date; end: Date } | null,
): GoodNight[] {
  const nights: GoodNight[] = [];
  for (const date of dates) {
    const dark = darkWindowFor(date);
    if (!dark) continue;
    const w = visibilityWindow(entry.ra, entry.dec, site.lat, site.lon, dark.start, dark.end, site.minAlt, site.horizonProfile);
    if (w.maxAlt < site.minAlt || !w.rises) continue;

    const visibleEnd = w.sets ?? dark.end;
    const hours = Math.max(0, (visibleEnd.getTime() - Math.max(w.rises.getTime(), dark.start.getTime())) / 3_600_000);
    const mid = new Date((dark.start.getTime() + dark.end.getTime()) / 2);
    const illumination = Math.round(SunCalc.getMoonIllumination(mid).fraction * 100);
    const moon = checkMoonProximity(entry.ra, entry.dec, site.lat, site.lon, w.rises, visibleEnd, illumination, 15, site.timezone);
    const impact = moon.verdict === 'warning' ? 1 : moon.verdict === 'caution' ? 0.5 : 0;
    const score = 0.4 * clamp01(w.maxAlt / 90) + 0.3 * clamp01(hours / 8) + 0.3 * (1 - impact);

    nights.push({
      date,
      score: Math.round(score * 100) / 100,
      maxAlt: Math.round(w.maxAlt * 10) / 10,
      visibleHours: Math.round(hours * 10) / 10,
      moonIllumination: illumination,
      moonVerdict: moon.verdict,
      minMoonSeparation: Number.isFinite(moon.minSeparation) ? Math.round(moon.minSeparation) : null,
      nightStart: dark.start.toISOString(),
      nightEnd: dark.end.toISOString(),
      isBest: false,
    });
  }
  const best = new Set([...nights].sort((a, b) => b.score - a.score).slice(0, 3).map(n => n.date));
  return nights.map(n => ({ ...n, isBest: best.has(n.date) }));
}
