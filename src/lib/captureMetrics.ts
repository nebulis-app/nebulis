import type { SessionCaptureSummary, SessionFile } from '../types';

/**
 * The headline numbers for one observing night, rolled up from the two places
 * they can come from.
 *
 * The telescope's own sidecar wins wherever it has a value and the filename
 * parse is the fallback, so each figure appears once on the page and comes from
 * the better source. This used to be duplicated: a tile grid derived everything
 * from filenames while a Capture Settings card read the sidecar, and the two
 * could disagree about the same session.
 *
 * A null `exposureSec`/`gain`/`filter` on the summary means the night held
 * several runs that disagreed, which is why those come back as "Mixed" rather
 * than being dropped: mixed is information, absent would be misleading.
 */
export interface CaptureMetric {
  key: string;
  value: string;
  label: string;
  /** Second line under the value, for context the number alone can't carry. */
  hint?: string;
  /** 0-100. The renderer draws a thin bar under the cell. */
  bar?: number;
}

/** Seconds as a compact "3h 29m" / "12m 30s". */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function filterDisplay(f: string): string {
  const upper = f.toUpperCase();
  if (upper === 'LP') return 'LP';
  if (upper === 'IRCUT') return 'IR Cut';
  return f;
}

export function buildCaptureMetrics({ capture, files, tempUnit }: {
  capture: SessionCaptureSummary | null | undefined;
  files: SessionFile[];
  tempUnit: 'celsius' | 'fahrenheit';
}): CaptureMetric[] {
  const stackedFile = files.find(f => f.fileType === 'stacked');
  const subCount = files.filter(f => f.fileType === 'sub').length;

  const parsedExposure = stackedFile?.exposure ? parseFloat(stackedFile.exposure.replace('s', '')) : null;
  const parsedFrames = stackedFile?.frameCount ?? null;

  const frames = capture?.framesStacked ?? parsedFrames;
  const exposureSec = capture?.exposureSec ?? parsedExposure;
  const integrationSec = capture?.integrationSec
    ?? (parsedFrames && parsedExposure ? parsedFrames * parsedExposure : null);
  const filter = capture?.filter ?? stackedFile?.filter ?? null;
  const hasRuns = (capture?.runs ?? 0) > 1;

  const temp = (c: number) =>
    tempUnit === 'fahrenheit' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;
  const tempRange = capture?.minTempC != null && capture.maxTempC != null
    ? (Math.round(capture.minTempC) === Math.round(capture.maxTempC)
      ? temp(capture.minTempC)
      : `${temp(capture.minTempC)} to ${temp(capture.maxTempC)}`)
    : null;

  // Frames kept out of frames attempted. The telescope discards frames it could
  // not stack, so "209 of 300" is a genuinely different number from the file
  // count and is not derivable from the files on disk.
  const attempted = capture?.framesTaken ?? capture?.framesPlanned ?? null;
  const attemptedLabel = capture?.framesTaken != null
    ? `of ${capture.framesTaken} taken`
    : capture?.framesPlanned != null ? `of ${capture.framesPlanned} planned` : undefined;
  const keptPct = frames != null && attempted
    ? Math.min(100, Math.round((frames / attempted) * 100))
    : undefined;

  const metrics: CaptureMetric[] = [];
  if (integrationSec != null) {
    metrics.push({
      key: 'integration',
      value: formatDuration(integrationSec),
      label: 'Integration',
      hint: hasRuns ? `${capture?.runs} runs` : undefined,
    });
  }
  if (frames != null) {
    metrics.push({
      key: 'frames',
      value: frames.toLocaleString(),
      label: 'Frames stacked',
      hint: attemptedLabel,
      bar: keptPct,
    });
  }
  if (exposureSec != null) metrics.push({ key: 'exposure', value: `${exposureSec}s`, label: 'Exposure' });
  else if (hasRuns) metrics.push({ key: 'exposure', value: 'Mixed', label: 'Exposure' });
  if (capture?.gain != null) metrics.push({ key: 'gain', value: String(capture.gain), label: 'Gain' });
  else if (hasRuns) metrics.push({ key: 'gain', value: 'Mixed', label: 'Gain' });
  if (filter) metrics.push({ key: 'filter', value: filterDisplay(filter), label: 'Filter' });
  if (tempRange) metrics.push({ key: 'sensor', value: tempRange, label: 'Sensor' });
  if (subCount > 0) metrics.push({ key: 'subs', value: subCount.toLocaleString(), label: 'Subframes' });

  return metrics;
}
