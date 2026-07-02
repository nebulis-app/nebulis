/**
 * Computes the best calendar window to image a deep-sky object from a given
 * location, across a full year. The metric is the maximum altitude the object
 * reaches during astronomical darkness for each sample date.
 *
 * Pure functions — no external dependencies beyond the altaz/nightWindow helpers
 * already used throughout the planner.
 */
import { altAz } from './altaz';
import { nightWindowFor, plannerToday } from './nightWindow';

interface MonthlyAltSample {
  /** Mid-month Date (15th of each month, current or next year) */
  date: Date;
  /** Month label: "Jan", "Feb", etc. */
  label: string;
  /** Max altitude during astronomical darkness, degrees. -1 if sun never sets. */
  maxAlt: number;
  /** True when the object is above the observer's minimum altitude during darkness */
  aboveMinAlt: boolean;
}

interface BestImagingWindow {
  /** Ordered 12-month samples */
  months: MonthlyAltSample[];
  /** The single best month (highest maxAlt) */
  peakMonth: MonthlyAltSample | null;
  /** Contiguous run of months where maxAlt >= minAlt, null if never visible */
  windowStart: string | null;
  windowEnd: string | null;
  /** Whether the object is ever reasonably placed from this location */
  everVisible: boolean;
}

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Sample an object's max-altitude-at-darkness for the 12 months starting from
 * the current calendar month. Uses the 15th of each month as an anchor; checks
 * altitude every 15 minutes during the astronomical night window.
 */
export function computeBestImagingWindow(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  minAlt = 20,
): BestImagingWindow {
  const now = new Date();
  const months: MonthlyAltSample[] = [];

  for (let i = 0; i < 12; i++) {
    const anchor = new Date(now.getFullYear(), now.getMonth() + i, 15, 12, 0, 0);
    const label = MONTH_ABBR[anchor.getMonth()];

    const night = nightWindowFor(anchor, lat, lon);
    if (!night) {
      months.push({ date: anchor, label, maxAlt: -1, aboveMinAlt: false });
      continue;
    }

    let maxAlt = -90;
    const stepMs = 15 * 60 * 1000;
    for (let t = night.start.getTime(); t <= night.end.getTime(); t += stepMs) {
      const { alt } = altAz(ra, dec, lat, lon, new Date(t));
      if (alt > maxAlt) maxAlt = alt;
    }

    months.push({
      date: anchor,
      label,
      maxAlt: Math.round(maxAlt * 10) / 10,
      aboveMinAlt: maxAlt >= minAlt,
    });
  }

  const peakMonth = months.reduce<MonthlyAltSample | null>((best, m) =>
    m.maxAlt > (best?.maxAlt ?? -Infinity) ? m : best, null);

  // Find the longest contiguous run above minAlt, treating the 12-month array
  // as circular. The samples span a full calendar cycle starting at the current
  // month, so a visible season that straddles the array's start (e.g. Oct–Feb
  // when sampling begins in January) is one continuous window, not two. Without
  // the wrap it would be truncated to whichever half is longer, and the reported
  // window would change depending on the month the user happens to be viewing.
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

  return { months, peakMonth, windowStart, windowEnd, everVisible };
}

/**
 * Whether an object climbs above `minAlt` (the geometric horizon by default) at
 * any point during tonight's dark window from the given location.
 *
 * Returns null when visibility can't be determined — no location, missing
 * coordinates, or no dark window for the night (e.g. polar summer) — so callers
 * can decline to warn in ambiguous cases rather than greying out a control on a
 * false negative.
 */
export function isUpTonight(
  ra: number | null | undefined,
  dec: number | null | undefined,
  lat: number | null | undefined,
  lon: number | null | undefined,
  minAlt = 0,
  now: Date = new Date(),
): boolean | null {
  if (ra == null || dec == null || lat == null || lon == null) return null;
  const night = nightWindowFor(plannerToday(now), lat, lon);
  if (!night) return null;
  const stepMs = 10 * 60 * 1000;
  for (let t = night.start.getTime(); t <= night.end.getTime(); t += stepMs) {
    if (altAz(ra, dec, lat, lon, new Date(t)).alt > minAlt) return true;
  }
  return false;
}
