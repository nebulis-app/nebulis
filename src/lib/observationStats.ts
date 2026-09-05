import type { ObservationSummary } from './api/observations';

/**
 * Summary of an observing record, and where in the year the nights actually
 * fall.
 *
 * The second part is the load-bearing one. A month grid can only show one month
 * at a time, so with nights spread thinly across a couple of years the only way
 * to find them was to click the chevron and hope. These buckets let the page
 * draw where the observing happened and jump straight there.
 */

export interface ObservationTotals {
  /** Sessions. One object on one date. */
  sessions: number;
  /** Distinct dates. Two objects shot the same night is one night. */
  nights: number;
  objects: number;
  files: number;
  /** `YYYY-MM-DD`, or null when there is nothing recorded. */
  firstDate: string | null;
  lastDate: string | null;
}

export function summarize(observations: ObservationSummary[]): ObservationTotals {
  const nights = new Set<string>();
  const objects = new Set<string>();
  let files = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (const o of observations) {
    nights.add(o.date);
    objects.add(o.objectId);
    files += o.fileCount ?? 0;
    // `YYYY-MM-DD` compares lexicographically in date order, so no parsing.
    if (firstDate === null || o.date < firstDate) firstDate = o.date;
    if (lastDate === null || o.date > lastDate) lastDate = o.date;
  }

  return {
    sessions: observations.length,
    nights: nights.size,
    objects: objects.size,
    files,
    firstDate,
    lastDate,
  };
}

/** Sessions and distinct nights in one calendar month. */
export interface MonthBucket {
  month: number;
  sessions: number;
  nights: number;
}

/**
 * Per-month counts for one year, always twelve entries so the chart has a
 * fixed shape whether or not a month was observed.
 */
export function bucketByMonth(observations: ObservationSummary[], year: number): MonthBucket[] {
  const sessions = new Array<number>(12).fill(0);
  const nights: Array<Set<string>> = Array.from({ length: 12 }, () => new Set<string>());

  for (const o of observations) {
    const [y, m] = o.date.split('-').map(Number);
    if (y !== year || !m || m < 1 || m > 12) continue;
    sessions[m - 1] += 1;
    nights[m - 1].add(o.date);
  }

  return sessions.map((count, month) => ({
    month,
    sessions: count,
    nights: nights[month].size,
  }));
}

/** Every year that holds at least one observation, oldest first. */
export function yearsWithObservations(observations: ObservationSummary[]): number[] {
  const years = new Set<number>();
  for (const o of observations) {
    const y = Number(o.date.slice(0, 4));
    if (Number.isFinite(y)) years.add(y);
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * The observed date closest to `from`, for "nothing here, take me to where
 * something is". Ties break towards the past: a night already recorded is a
 * better destination than one that has not happened.
 */
export function nearestObservedDate(dates: string[], from: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  const target = Date.parse(`${from}T12:00:00`);
  if (Number.isNaN(target)) return null;

  for (const date of dates) {
    const t = Date.parse(`${date}T12:00:00`);
    if (Number.isNaN(t)) continue;
    const distance = Math.abs(t - target);
    if (distance < bestDistance || (distance === bestDistance && t < target)) {
      best = date;
      bestDistance = distance;
    }
  }
  return best;
}
