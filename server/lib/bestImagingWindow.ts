/**
 * Server-side port of src/lib/bestImagingWindow.ts.
 *
 * The web client computes this in the browser with SunCalc. The native clients
 * (iOS, Android) have no sun-position math, so they call
 * GET /api/v1/catalogs/best-window and get the same result the browser derives.
 *
 * Metric: for each of the next 12 calendar months, the maximum altitude the
 * object reaches during astronomical darkness (nautical-twilight fallback at
 * high latitudes). Plus the contiguous run of months it clears `minAlt`, wrapped
 * across the array boundary so a season that straddles the sample start reads as
 * one window.
 */
import { altAz, getNightWindow } from './astroCalc.js';
import { lookupTimeZoneForCoordinates } from './observerTimezone.js';
import { observingNightAnchor } from './telescopeFiles.js';
import { localParts } from './timezone.js';

export interface MonthlyAltSample {
  /** Month label: "Jan", "Feb", etc. */
  label: string;
  /** Max altitude during darkness, degrees. -1 when the sun never sets enough. */
  maxAlt: number;
  /** True when maxAlt >= minAlt. */
  aboveMinAlt: boolean;
}

export interface BestImagingWindow {
  months: MonthlyAltSample[];
  /** First label of the longest contiguous ">= minAlt" run, null if never. */
  windowStart: string | null;
  windowEnd: string | null;
  everVisible: boolean;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Astronomical night window for `date`'s evening, nautical-twilight fallback. */
function nightWindowFor(date: Date, lat: number, lon: number): { start: Date; end: Date } | null {
  const w = getNightWindow(date, lat, lon);
  if (w.nightStart && w.nightEnd) return { start: w.nightStart, end: w.nightEnd };
  if (w.nauticalDusk && w.nauticalDawn) return { start: w.nauticalDusk, end: w.nauticalDawn };
  return null;
}

export function computeBestImagingWindow(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  minAlt = 20,
  now: Date = new Date(),
): BestImagingWindow {
  const months: MonthlyAltSample[] = [];
  // The month is the site's, and each sample is anchored at mean solar noon at
  // the site's longitude, like observerNoonAnchor in the client. A noon on the
  // server's own clock is another solar day for a site far from it (Sydney seen
  // from a server in Iowa), so the answer depended on where the server ran.
  const here = localParts(now, lookupTimeZoneForCoordinates(lat, lon));

  for (let i = 0; i < 12; i++) {
    const utcNoon = Date.UTC(here.year, here.month - 1 + i, 15, 12, 0, 0);
    const anchor = new Date(utcNoon - (lon / 15) * 3_600_000);
    const label = MONTH_ABBR[new Date(utcNoon).getUTCMonth()];

    const night = nightWindowFor(anchor, lat, lon);
    if (!night) {
      months.push({ label, maxAlt: -1, aboveMinAlt: false });
      continue;
    }

    let maxAlt = -90;
    const stepMs = 15 * 60 * 1000;
    for (let t = night.start.getTime(); t <= night.end.getTime(); t += stepMs) {
      const { alt } = altAz(ra, dec, lat, lon, new Date(t));
      if (alt > maxAlt) maxAlt = alt;
    }

    months.push({
      label,
      maxAlt: Math.round(maxAlt * 10) / 10,
      aboveMinAlt: maxAlt >= minAlt,
    });
  }

  const flags = months.map(m => m.aboveMinAlt);
  let bestRunStart = -1;
  let bestRunLen = 0;
  if (flags.every(Boolean)) {
    bestRunStart = 0;
    bestRunLen = months.length;
  } else {
    let runStart = -1;
    let runLen = 0;
    for (let i = 0; i < months.length; i++) {
      if (flags[i]) {
        if (runStart === -1) runStart = i;
        runLen++;
        if (runLen > bestRunLen) { bestRunLen = runLen; bestRunStart = runStart; }
      } else {
        runStart = -1;
        runLen = 0;
      }
    }
    // A trailing run joins a leading run across the array boundary.
    if (flags[0] && flags[months.length - 1]) {
      let lead = 0;
      while (lead < months.length && flags[lead]) lead++;
      let trail = 0;
      while (trail < months.length && flags[months.length - 1 - trail]) trail++;
      const wrapLen = lead + trail;
      if (wrapLen > bestRunLen) {
        bestRunLen = wrapLen;
        bestRunStart = months.length - trail;
      }
    }
  }

  const windowStart = bestRunStart >= 0 ? months[bestRunStart].label : null;
  const windowEnd = bestRunStart >= 0
    ? months[(bestRunStart + bestRunLen - 1) % months.length].label
    : null;
  const everVisible = months.some(m => m.aboveMinAlt);

  return { months, windowStart, windowEnd, everVisible };
}

/**
 * Whether the object clears `minAlt` at any point during tonight's dark window.
 * null when it can't be determined (no dark window). Mirrors isUpTonight() in
 * the client, minus the null-coordinate guards the route handles.
 */
export function isUpTonight(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  minAlt = 0,
  now: Date = new Date(),
  timeZone: string | null = lookupTimeZoneForCoordinates(lat, lon),
): boolean | null {
  // "Astronomer's today": before 07:00 at the site the relevant window is
  // still the one that began last evening, like plannerToday() in the client.
  // The rollover is read in the site's own zone, looked up from the
  // coordinates: the server's clock is UTC in Docker, which put the rollover
  // at 01:00 or 02:00 in the US and asked about the wrong night until dawn.
  const anchor = observingNightAnchor(now, timeZone);
  const night = nightWindowFor(anchor, lat, lon);
  if (!night) return null;
  const stepMs = 10 * 60 * 1000;
  for (let t = night.start.getTime(); t <= night.end.getTime(); t += stepMs) {
    if (altAz(ra, dec, lat, lon, new Date(t)).alt > minAlt) return true;
  }
  return false;
}
