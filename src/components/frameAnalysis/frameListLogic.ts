/** Pure helpers for the night frame list: ordering, the summary, the timeline's gap, and trimming shared name prefixes. */
import type { FrameAnalysisRow } from '../../lib/api/frameAnalysis';

export type SortKey = 'time' | 'score' | 'flags' | 'stars' | 'fwhm' | 'round' | 'noise' | 'snr' | 'sky' | 'file';

/** The telescope's `yyyymmdd-hhmmss` stamp as a wall-clock time, or null when the name carries none. */
export function captureTime(stamp: string | null): Date | null {
  if (!stamp) return null;
  const m = /(\d{4})(\d{2})(\d{2})[-_T]?(\d{2})(\d{2})(\d{2})/.exec(stamp);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const GRADE_RANK = { bad: 0, fair: 1, good: 2 } as const;

/**
 * Frames not measured yet sort last, whichever way the column runs. "Flags" ranks by how much is wrong: worse
 * grade first, then more flags.
 */
export function orderRows(
  rows: FrameAnalysisRow[],
  opts: { sortKey: SortKey; ascending: boolean; flaggedOnly: boolean },
): FrameAnalysisRow[] {
  const { sortKey, ascending, flaggedOnly } = opts;
  const kept = flaggedOnly
    ? rows.filter(r => r.verdict !== null && (r.verdict.flags.length > 0 || r.verdict.grade === 'bad'))
    : rows;

  const value = (r: FrameAnalysisRow): number | null => {
    switch (sortKey) {
      case 'time': return captureTime(r.timestamp)?.getTime() ?? null;
      case 'score': return r.verdict?.score ?? null;
      case 'flags': return r.verdict ? GRADE_RANK[r.verdict.grade] * 10 - r.verdict.flags.length : null;
      case 'stars': return r.metrics?.starCount ?? null;
      case 'fwhm': return r.metrics?.fwhm ?? null;
      case 'round': return r.metrics?.elongation ?? null;
      case 'noise': return r.metrics?.noise ?? null;
      case 'snr': return r.metrics?.peakSNR ?? null;
      case 'sky': return r.metrics?.background ?? null;
      case 'file': return null;
    }
  };

  return [...kept].sort((a, b) => {
    if (sortKey === 'file') {
      const order = a.name.localeCompare(b.name, undefined, { numeric: true });
      return ascending ? order : -order;
    }
    const x = value(a), y = value(b);
    if (x !== null && y !== null) {
      if (x === y) return a.name.localeCompare(b.name, undefined, { numeric: true });
      return ascending ? x - y : y - x;
    }
    if (x !== null) return -1;
    if (y !== null) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

export interface FrameListSummary {
  flagged: number;
  bad: number;
  badPaths: string[];
  flaggedPaths: string[];
}

export function summaryOf(rows: FrameAnalysisRow[]): FrameListSummary {
  const badPaths: string[] = [];
  const flaggedPaths: string[] = [];
  for (const r of rows) {
    if (!r.verdict) continue;
    if (r.verdict.grade === 'bad') badPaths.push(r.path);
    if (r.verdict.flags.length > 0) flaggedPaths.push(r.path);
  }
  const flagged = new Set([...badPaths, ...flaggedPaths]).size;
  return { flagged, bad: badPaths.length, badPaths, flaggedPaths };
}

/**
 * The biggest pause between two frames, only when it is plainly longer than the usual spacing and at least five
 * minutes: a few seconds between frames is not a finding.
 */
export function longestGap(rows: FrameAnalysisRow[]): { seconds: number; at: Date } | null {
  const times = rows.flatMap(r => { const d = captureTime(r.timestamp); return d ? [d.getTime()] : []; }).sort((a, b) => a - b);
  if (times.length <= 3) return null;
  const gaps = times.slice(1).map((t, i) => ({ seconds: (t - times[i]) / 1000, at: times[i] }));
  const biggest = gaps.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  const sorted = gaps.map(g => g.seconds).sort((a, b) => a - b);
  const typical = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return biggest.seconds >= 300 && biggest.seconds > typical * 3 ? { seconds: biggest.seconds, at: new Date(biggest.at) } : null;
}

/**
 * How many leading characters every file name shares, backed up to a separator so a number is never cut in half.
 * A night's frames all start `Light_mosaic_NGC…_30s_…`; only the tail tells them apart.
 */
export function sharedPrefixLength(names: string[]): number {
  if (names.length < 2) return 0;
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === '') return 0;
  }
  while (prefix.length > 0 && !'_- '.includes(prefix[prefix.length - 1])) prefix = prefix.slice(0, -1);
  const shortest = Math.min(...names.map(n => n.length));
  return shortest - prefix.length >= 4 ? prefix.length : 0;
}

const MINUTE_MS = 60_000;
/** Spacings a time axis can use, so its labels fall on round clock times. */
const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map(m => m * MINUTE_MS);
/** Labels this close to either end would run into the first and last time, so they are left out. */
const TICK_END_MARGIN = 0.07;

/**
 * Round clock times between two instants, for labelling a timeline: about six of them, on the whole minute or hour
 * (in the viewer's own time zone), and none too near the ends. Empty when the span is too short to need any.
 */
export function timelineTicks(first: number, last: number): Array<{ at: number; fraction: number }> {
  const span = last - first;
  if (!(span >= 3 * MINUTE_MS)) return [];
  const step = TICK_STEPS_MS.find(s => s >= span / 7) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  // Aligned to local midnight, so a half-hour time zone still lands on :00 and :30.
  const offset = -new Date(first).getTimezoneOffset() * MINUTE_MS;
  const ticks: Array<{ at: number; fraction: number }> = [];
  for (let at = Math.ceil((first + offset) / step) * step - offset; at < last; at += step) {
    const fraction = (at - first) / span;
    if (fraction > TICK_END_MARGIN && fraction < 1 - TICK_END_MARGIN) ticks.push({ at, fraction });
  }
  return ticks;
}
