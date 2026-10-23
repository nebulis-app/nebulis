import { fetchJSON, authHeaders, BASE } from './client';
import type { SessionFile } from '../../types';

export type FrameFlag = 'clouds' | 'trails' | 'soft' | 'streak' | 'noStars' | 'noisy';
export type FrameGrade = 'good' | 'fair' | 'bad';

export interface FrameMetrics {
  width: number;
  height: number;
  starCount: number;
  fwhm: number | null;
  elongation: number | null;
  orientation: number | null;
  background: number;
  noise: number;
  gradient: number;
  peakSNR: number | null;
  streak: { angle: number; strength: number } | null;
  saturatedFraction: number;
  ra: number | null;
  dec: number | null;
}

/** One finding with the numbers behind it. The sentence is built in the UI so it follows the display language. */
export type FrameReason =
  | { flag: 'noStars'; stars: number; typical: number }
  | { flag: 'clouds'; stars: number; typical: number; percentFewer: number; brighterSky: boolean }
  | { flag: 'trails'; ratio: number; angle: number | null; plain: boolean }
  | { flag: 'soft'; fwhm: number; typical: number }
  | { flag: 'streak'; angle: number }
  | { flag: 'noisy'; percentAbove: number };

export interface FrameVerdict {
  score: number;
  grade: FrameGrade;
  flags: FrameFlag[];
  reasons: FrameReason[];
}

export interface FrameReference {
  stars: number;
  fwhm: number;
  elongation: number;
  noise: number;
  background: number;
  weak: boolean;
}

export interface FrameAnalysisRow {
  path: string;
  name: string;
  timestamp: string | null;
  thumbUrl: string | null;
  downloadUrl: string;
  /** The library's record of the file, so a viewer opens it without a second lookup. */
  file: SessionFile;
  /** Null until the frame has been measured. */
  metrics: FrameMetrics | null;
  verdict: FrameVerdict | null;
  /** The user's own keep / reject call, or null to follow the grade. */
  review: 'keep' | 'reject' | null;
  /** Whether the frame belongs in a stack: the review if there is one, else not graded bad. */
  kept: boolean;
}

export interface FrameAnalysisReport {
  objectId: string;
  date: string;
  frames: FrameAnalysisRow[];
  reference: FrameReference | null;
  measured: number;
  total: number;
  /** Frames of this night waiting for, or being measured by, the server's background worker. */
  pending: number;
  /** Frames that could not be read, with the reason, until they are asked for again. */
  failures: Record<string, string>;
}

export const getFrameAnalysis = (
  objectId: string,
  date: string,
  opts: { includeVariants?: boolean; signal?: AbortSignal } = {},
) =>
  fetchJSON<FrameAnalysisReport>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/frame-analysis`
      + (opts.includeVariants ? '?includeVariants=1' : ''),
    { signal: opts.signal },
  );

export const measureFrame = (path: string, force = false, signal?: AbortSignal) =>
  fetchJSON<{ path: string; metrics: FrameMetrics; cached: boolean }>('/library/frame-analysis/measure', {
    method: 'POST',
    body: JSON.stringify({ path, force }),
    signal,
  });

/** Ask the server to measure whatever of a night is not measured yet, in the background. Safe to repeat. */
export const queueFrameMeasuring = (
  objectId: string,
  date: string,
  opts: { includeVariants?: boolean; force?: boolean } = {},
) =>
  fetchJSON<{ queued: number; pending: number; total: number }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/frame-analysis/measure`,
    { method: 'POST', body: JSON.stringify({ includeVariants: opts.includeVariants === true, force: opts.force === true }) },
  );

/** Mark a frame keep (true), reject (false), or back to following its grade (null). */
export const setFrameReview = (path: string, keep: boolean | null) =>
  fetchJSON<{ path: string; keep: boolean | null }>('/library/frame-analysis/review', {
    method: 'PUT',
    body: JSON.stringify({ path, keep }),
  });

/** The night's analysis as a CSV file (with an `accepted` column), saved through the browser. */
export async function downloadFrameAnalysisCsv(objectId: string, date: string, includeVariants = false): Promise<void> {
  const url = `${BASE}/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/frame-analysis.csv`
    + (includeVariants ? '?includeVariants=1' : '');
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(res.statusText);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${objectId}_${date}_frames.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
