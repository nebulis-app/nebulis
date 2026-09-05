/**
 * What a whole object's imaging record adds up to.
 *
 * The object page used to show only "N observations", so the numbers people
 * actually track for a target (how much integration is on it, how many frames,
 * how long it has been running) lived nowhere: you had to open each night in
 * turn and add them up yourself. These roll the same per-night figures the
 * observation page shows into a lifetime total.
 *
 * Capture data is optional by nature. It comes from the device's own sidecar,
 * which only some telescopes write, so integration and frame counts are null
 * when nothing recorded them. Null means unknown and must never render as 0.
 */
import type { CaptureMetric } from '../../lib/captureMetrics';
import type { Session, SessionCaptureSummary } from '../../types';

export interface ObjectTotals {
  /** Sessions, counting a variant's night separately from the base object's. */
  observations: number;
  /** Distinct calendar nights, which is smaller than `observations` when a
   *  variant was shot on the same night as its base. */
  nights: number;
  firstNight: string | null;
  lastNight: string | null;
  /** Summed from the device sidecar. Null when no night recorded any. */
  integrationSec: number | null;
  framesStacked: number | null;
  /** Always available: counted from the files on disk. */
  subFrames: number;
  processed: number;
  stacked: number;
}

export function summarizeObject(
  sessions: readonly Session[],
  captureByDate: Record<string, SessionCaptureSummary> | undefined,
): ObjectTotals {
  const nights = new Set<string>();
  let firstNight: string | null = null;
  let lastNight: string | null = null;
  let subFrames = 0;
  let processed = 0;
  let stacked = 0;

  for (const s of sessions) {
    if (s.date && s.date !== 'unknown') {
      nights.add(s.date);
      // `YYYY-MM-DD` compares lexicographically in date order.
      if (firstNight === null || s.date < firstNight) firstNight = s.date;
      if (lastNight === null || s.date > lastNight) lastNight = s.date;
    }
    subFrames += s.subFrameCount ?? 0;
    processed += s.processedCount ?? 0;
    stacked += s.stackedCount ?? 0;
  }

  // Keyed by night, so a night that produced both a base and a variant session
  // contributes its capture runs once rather than twice.
  let integrationSec: number | null = null;
  let framesStacked: number | null = null;
  for (const date of nights) {
    const capture = captureByDate?.[date];
    if (!capture) continue;
    if (capture.integrationSec != null) integrationSec = (integrationSec ?? 0) + capture.integrationSec;
    if (capture.framesStacked != null) framesStacked = (framesStacked ?? 0) + capture.framesStacked;
  }

  return {
    observations: sessions.length,
    nights: nights.size,
    firstNight,
    lastNight,
    integrationSec,
    framesStacked,
    subFrames,
    processed,
    stacked,
  };
}

/** Seconds as "12h 30m" / "45m". Matches the observation page's capture rail. */
export function formatIntegration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

/** `YYYY-MM-DD` as "Mar 2024". Built locally so it never shifts a night. */
export function monthYear(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** How long ago a night was, in the fewest words that stay true. */
export function nightsAgo(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const then = new Date(y, m - 1, d);
  const today = new Date();
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - then.getTime())
    / 86_400_000,
  );
  if (days <= 0) return 'Tonight';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = days / 365;
  return years < 1.5 ? 'A year ago' : `${Math.round(years)} years ago`;
}

/**
 * The hero's rail. Same component and shape the observation page uses for one
 * night, so a night's numbers and a target's lifetime numbers are set
 * identically and can be read the same way.
 *
 * Capped at five cells: past that the rail wraps to two rows on a laptop and
 * stops reading as a rule under the picture.
 */
export function buildObjectMetrics(totals: ObjectTotals): CaptureMetric[] {
  const metrics: CaptureMetric[] = [];

  metrics.push({
    key: 'observations',
    value: String(totals.observations),
    label: totals.observations === 1 ? 'Observation' : 'Observations',
    // Only worth saying when the two counts differ, which means a variant was
    // shot alongside the base on one of the nights.
    hint: totals.nights !== totals.observations ? `${totals.nights} nights` : undefined,
  });

  if (totals.lastNight) {
    metrics.push({
      key: 'last',
      value: nightsAgo(totals.lastNight),
      label: 'Last shot',
      hint: totals.firstNight && totals.firstNight !== totals.lastNight
        ? `since ${monthYear(totals.firstNight)}`
        : undefined,
    });
  }

  if (totals.integrationSec != null) {
    metrics.push({
      key: 'integration',
      value: formatIntegration(totals.integrationSec),
      label: 'Integration',
      hint: totals.framesStacked != null ? `${totals.framesStacked.toLocaleString()} frames` : undefined,
    });
  }

  if (totals.subFrames > 0) {
    metrics.push({
      key: 'subs',
      value: totals.subFrames.toLocaleString(),
      label: 'Sub-frames',
    });
  } else if (totals.stacked > 0) {
    metrics.push({
      key: 'stacked',
      value: totals.stacked.toLocaleString(),
      label: totals.stacked === 1 ? 'Stack' : 'Stacks',
    });
  }

  if (totals.processed > 0) {
    metrics.push({
      key: 'processed',
      value: totals.processed.toLocaleString(),
      label: 'Processed',
    });
  }

  return metrics.slice(0, 5);
}
