import { Cloud, Moon, Telescope } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile, SessionCaptureSummary, SessionWeather } from '../../types';

/** Seconds as a compact "3h 29m" / "12m 30s". */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function filterDisplay(f: string): string {
  if (f.toUpperCase() === 'LP') return 'LP';
  if (f.toUpperCase() === 'IRCUT') return 'IR Cut';
  return f;
}

/**
 * The session's headline numbers, in one scannable band.
 *
 * Replaces the old stat-tile grid, which duplicated four of its five values
 * with `CapturePanel` and could disagree with it: the tiles derived everything
 * from filenames while the panel reads the telescope's own sidecar. Here the
 * sidecar wins whenever it has the value and the filename parse is the
 * fallback, so a number appears once on the page and comes from the better
 * source. `null` on a sidecar field means the night held runs that disagreed,
 * which renders as "Mixed" for the same reason CapturePanel does it.
 */
export function ObservationStrip({ capture, files, weather, note, tempUnit }: {
  capture: SessionCaptureSummary | null | undefined;
  files: SessionFile[];
  weather: SessionWeather | null | undefined;
  note: { bortleClass?: number | null; moonPhase?: string | null; moonIllumination?: number | null } | null | undefined;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const { isDark } = useTheme();

  const stackedFile = files.find(f => f.fileType === 'stacked');
  const subCount = files.filter(f => f.fileType === 'sub').length;

  const parsedExposure = stackedFile?.exposure ? parseFloat(stackedFile.exposure.replace('s', '')) : null;
  const parsedFrames = stackedFile?.frameCount ?? null;

  const frames = capture?.framesStacked ?? parsedFrames;
  const exposureSec = capture?.exposureSec ?? parsedExposure;
  const integrationSec = capture?.integrationSec
    ?? (parsedFrames && parsedExposure ? parsedFrames * parsedExposure : null);
  const filter = capture?.filter ?? stackedFile?.filter ?? null;

  const temp = (c: number) =>
    tempUnit === 'fahrenheit' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;
  const tempRange = capture?.minTempC != null && capture.maxTempC != null
    ? (Math.round(capture.minTempC) === Math.round(capture.maxTempC)
      ? temp(capture.minTempC)
      : `${temp(capture.minTempC)} to ${temp(capture.maxTempC)}`)
    : null;

  const hasRuns = (capture?.runs ?? 0) > 1;

  const metrics: { value: string; label: string }[] = [];
  if (frames != null) metrics.push({ value: frames.toLocaleString(), label: 'Frames' });
  if (integrationSec != null) metrics.push({ value: formatDuration(integrationSec), label: 'Integration' });
  if (exposureSec != null) metrics.push({ value: `${exposureSec}s`, label: 'Exposure' });
  else if (hasRuns) metrics.push({ value: 'Mixed', label: 'Exposure' });
  if (capture?.gain != null) metrics.push({ value: String(capture.gain), label: 'Gain' });
  else if (hasRuns) metrics.push({ value: 'Mixed', label: 'Gain' });
  if (filter) metrics.push({ value: filterDisplay(filter), label: 'Filter' });
  if (tempRange) metrics.push({ value: tempRange, label: 'Sensor' });
  if (subCount > 0) metrics.push({ value: subCount.toLocaleString(), label: 'Subframes' });

  const pills: { key: string; icon: typeof Cloud; text: string; tone: 'teal' | 'plain' }[] = [];
  if (weather?.cloudCover != null) {
    pills.push({
      key: 'clouds',
      icon: Cloud,
      text: `${Math.round(weather.cloudCover)}% clouds`,
      tone: weather.cloudCover <= 25 ? 'teal' : 'plain',
    });
  }
  if (note?.bortleClass) {
    pills.push({ key: 'bortle', icon: Telescope, text: `Bortle ${note.bortleClass}`, tone: 'plain' });
  }
  if (note?.moonPhase) {
    pills.push({
      key: 'moon',
      icon: Moon,
      text: note.moonIllumination != null ? `Moon ${note.moonIllumination}%` : note.moonPhase,
      tone: 'plain',
    });
  }

  if (metrics.length === 0 && pills.length === 0) return null;

  return (
    <div className={`rounded-xl border p-4 ${
      isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'
    }`}>
      {/* A wrapping grid rather than a single row: this sits in the column
          beside the hero, whose width changes with the frame's orientation.
          A flex band with dividers strands an orphaned separator at each wrap
          point, so the cells are spaced instead of ruled. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-3">
        {metrics.map(({ value, label }) => (
          <div key={label} className="min-w-0">
            <div className={`font-display text-[15px] font-semibold leading-tight tabular-nums truncate ${
              isDark ? 'text-white' : 'text-slate-900'
            }`}>
              {value}
            </div>
            <div className={`text-[10px] uppercase tracking-wider mt-0.5 truncate ${
              isDark ? 'text-slate-600' : 'text-slate-400'
            }`}>
              {label}
            </div>
          </div>
        ))}
      </div>

      {pills.length > 0 && (
        <div className={`flex items-center gap-2 flex-wrap ${
          metrics.length > 0 ? `mt-3 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}` : ''
        }`}>
          {pills.map(({ key, icon: Icon, text, tone }) => (
            <span
              key={key}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium whitespace-nowrap ${
                tone === 'teal'
                  ? isDark ? 'bg-teal-500/10 text-teal-400' : 'bg-teal-50 text-teal-700'
                  : isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600'
              }`}
            >
              <Icon className="w-3 h-3" />
              {text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
