import { Camera, Timer, Layers, Filter, Thermometer, Gauge } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import type { SessionCaptureSummary } from '../../types';

/** Seconds as a compact "3h 29m" / "12m 30s". */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * What the telescope itself recorded about this night, read from its own
 * sidecar file rather than guessed from filenames.
 *
 * A null `exposureSec`/`gain`/`filter` on the summary means the night held
 * several runs that disagreed, which is why those render as "Mixed" rather than
 * being hidden: "mixed" is information, "absent" would be misleading.
 */
export function CapturePanel({ capture, tempUnit }: {
  capture: SessionCaptureSummary;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const labelClass = isDark ? 'text-slate-600' : 'text-slate-400';

  const temp = (c: number) =>
    tempUnit === 'fahrenheit' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;

  const tempRange = capture.minTempC != null && capture.maxTempC != null
    ? (Math.round(capture.minTempC) === Math.round(capture.maxTempC)
      ? temp(capture.minTempC)
      : `${temp(capture.minTempC)} to ${temp(capture.maxTempC)}`)
    : null;

  // Frames kept out of frames planned. The telescope discards frames it could
  // not stack, so "209 of 300" is a genuinely different number from the file
  // count and is not derivable from the files on disk.
  const keptPct = capture.framesStacked != null && capture.framesPlanned
    ? Math.min(100, Math.round((capture.framesStacked / capture.framesPlanned) * 100))
    : null;

  return (
    <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      <h3 className={`font-display font-semibold text-sm flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
        <Camera className={`w-3.5 h-3.5 ${accentText}`} />
        Capture Settings
        {capture.runs > 1 && (
          <span className={`text-[11px] font-normal ${labelClass}`}>
            {capture.runs} runs
          </span>
        )}
      </h3>

      <div className={`grid grid-cols-2 gap-x-4 gap-y-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        <div className="flex items-center justify-between">
          <span className={`flex items-center gap-1.5 ${labelClass}`}>
            <Timer className="w-3 h-3" /> Exposure
          </span>
          <span className="font-medium">
            {capture.exposureSec != null ? `${capture.exposureSec}s` : 'Mixed'}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className={`flex items-center gap-1.5 ${labelClass}`}>
            <Gauge className="w-3 h-3" /> Gain
          </span>
          <span className="font-medium">
            {capture.gain != null ? capture.gain : 'Mixed'}
          </span>
        </div>

        {capture.integrationSec != null && (
          <div className="flex items-center justify-between">
            <span className={`flex items-center gap-1.5 ${labelClass}`}>
              <Layers className="w-3 h-3" /> Integration
            </span>
            <span className="font-medium">{formatDuration(capture.integrationSec)}</span>
          </div>
        )}

        {(capture.filter || capture.runs > 1) && (
          <div className="flex items-center justify-between">
            <span className={`flex items-center gap-1.5 ${labelClass}`}>
              <Filter className="w-3 h-3" /> Filter
            </span>
            <span className="font-medium">{capture.filter ?? 'Mixed'}</span>
          </div>
        )}

        {tempRange && (
          <div className="flex items-center justify-between">
            <span className={`flex items-center gap-1.5 ${labelClass}`}>
              <Thermometer className="w-3 h-3" /> Sensor
            </span>
            <span className="font-medium">{tempRange}</span>
          </div>
        )}
      </div>

      {capture.framesStacked != null && (
        <div className={`mt-3 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
          <div className={`flex items-center justify-between text-xs mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <span className={labelClass}>Frames stacked</span>
            <span className="font-medium">
              {capture.framesStacked}
              {capture.framesTaken != null && ` of ${capture.framesTaken} taken`}
              {capture.framesPlanned != null && `, ${capture.framesPlanned} planned`}
            </span>
          </div>
          {keptPct != null && (
            <div
              className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}
              role="progressbar"
              aria-valuenow={keptPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${keptPct}% of planned frames stacked`}
            >
              <div
                className={`h-full ${isNight ? 'bg-red-500' : isSpace ? 'bg-violet-500' : 'bg-accent-500'}`}
                style={{ width: `${keptPct}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
