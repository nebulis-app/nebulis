/**
 * Tonight's imaging window.
 *
 * Shows the window start and end (astronomical twilight, falling back to
 * nautical), then a compact hour-by-hour table of the conditions during that
 * window so the photographer can see at a glance whether to bother setting up
 * and when the worst of the cloud cover or dew risk arrives.
 *
 * The scoring and formatting reuse the same helpers the hero panel and the
 * hour detail use, so every number on the page is consistent.
 */
import { Camera, CloudSun, Droplets, Eye, Moon, Wind } from 'lucide-react';
import type { ForecastHour } from '../../lib/api/planner';
import {
  calculateVisibilityScore,
  formatTemp,
  formatTime,
  formatWind,
  scoreHex,
  scoreLabel,
  type DarkWindow,
} from '../../lib/forecastScore';

interface TonightInfo {
  moonIllumination: number;
  astronomicalTwilightEnd: string;
  astronomicalTwilightStart: string;
  nauticalTwilightEnd: string;
  nauticalTwilightStart: string;
  sunset: string;
  sunrise: string;
}

interface Props {
  hours: ForecastHour[];
  tonight: TonightInfo;
  timeZone?: string;
  darkWindow: DarkWindow | null;
  tempUnit: 'celsius' | 'fahrenheit';
  windUnit: 'mph' | 'kmh';
  isDark: boolean;
}

const SEEING_NAMES: Record<number, string> = { 1: 'Excellent', 2: 'Good', 3: 'Average', 4: 'Poor', 5: 'Bad' };

/** One cell in the header label row. */
function ColLabel({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="py-2 px-3 text-left text-[10.5px] font-medium uppercase tracking-[0.14em] whitespace-nowrap">
      {children}
    </th>
  );
}

/** Score chip — matches the style of the ribbon's scrub tooltip. */
function ScoreChip({ score }: { score: number }) {
  const hex = scoreHex(score);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ring-1 ring-inset"
      style={{ color: hex, backgroundColor: `${hex}18`, borderColor: `${hex}45` }}
    >
      {score}
      <span className="font-semibold uppercase tracking-[0.10em] text-[9.5px]">{scoreLabel(score)}</span>
    </span>
  );
}

/** Cloud coverage indicator bar (0-100%). */
function CloudBar({ pct, isDark }: { pct: number; isDark: boolean }) {
  const color = pct <= 20 ? 'bg-emerald-500' : pct <= 50 ? 'bg-amber-400' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2 min-w-[4.5rem]">
      <div className={`h-1.5 rounded-full overflow-hidden flex-1 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-[11px] w-7 text-right">{pct}%</span>
    </div>
  );
}

export function ImagingWindow({
  hours, tonight, timeZone, darkWindow, tempUnit, windUnit, isDark,
}: Props) {
  // Prefer astronomical twilight, fall back to nautical for the window bounds.
  const windowStartIso = tonight.astronomicalTwilightEnd || tonight.nauticalTwilightEnd;
  const windowEndIso = tonight.astronomicalTwilightStart || tonight.nauticalTwilightStart;

  // If neither twilight boundary is available, nothing meaningful to show.
  if (!windowStartIso || !windowEndIso) return null;

  const windowStart = new Date(windowStartIso).getTime();
  const windowEnd = new Date(windowEndIso).getTime();

  // Guard against an inverted window (can happen when the server sends the
  // next night's dawn before tonight's dusk at high latitudes in summer).
  if (windowEnd <= windowStart) return null;

  // Filter hourly data to inside the imaging window (inclusive).
  const windowHours = hours.filter(h => {
    const t = new Date(h.time).getTime();
    return t >= windowStart && t <= windowEnd;
  });

  // With fewer than two hours there is nothing useful to tabulate.
  if (windowHours.length < 2) return null;

  const isDarkWindow = darkWindow != null;
  const windowLabel = isDarkWindow
    ? (tonight.astronomicalTwilightEnd ? 'Astronomical dark' : 'Nautical dark')
    : 'Dark window';

  const fmt = (iso: string | null) => (iso ? formatTime(iso, timeZone) : '–');

  // Row background alternation helpers.
  const rowBase = isDark
    ? 'border-slate-800/60'
    : 'border-slate-100';
  const rowAlt = isDark
    ? 'bg-slate-800/30'
    : 'bg-slate-50/70';

  return (
    <section
      aria-label="Tonight's imaging window"
      className={`rounded-2xl border overflow-hidden ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}
    >
      {/* Header */}
      <div className={`px-5 py-4 border-b flex flex-wrap items-center justify-between gap-3 ${
        isDark ? 'border-slate-800' : 'border-slate-100'
      }`}>
        <div className="flex items-center gap-2.5">
          <Camera className={`h-4 w-4 shrink-0 ${isDark ? 'text-violet-400' : 'text-violet-500'}`} />
          <div>
            <h2 className={`font-display font-semibold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              Tonight's Imaging Window
            </h2>
            <p className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {windowLabel}
            </p>
          </div>
        </div>

        {/* Window start → end badge */}
        <div className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium tabular-nums ${
          isDark
            ? 'bg-violet-500/10 text-violet-300 ring-1 ring-inset ring-violet-500/20'
            : 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200'
        }`}>
          <span>{fmt(windowStartIso)}</span>
          <span className="opacity-50">→</span>
          <span>{fmt(windowEndIso)}</span>
          <span className={`ml-1 text-[11px] font-normal ${isDark ? 'text-violet-400/60' : 'text-violet-500/70'}`}>
            ({windowHours.length - 1}h)
          </span>
        </div>
      </div>

      {/* Hour-by-hour table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-xs">
          <thead>
            <tr className={isDark ? 'text-slate-500 border-b border-slate-800' : 'text-slate-400 border-b border-slate-100'}>
              <ColLabel>Time</ColLabel>
              <ColLabel>Score</ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><CloudSun className="h-3 w-3" />Clouds</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Eye className="h-3 w-3" />Seeing</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Moon className="h-3 w-3" />Moon</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Droplets className="h-3 w-3" />Humidity</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Wind className="h-3 w-3" />Wind</span>
              </ColLabel>
              <ColLabel>Temp</ColLabel>
              <ColLabel>Dew</ColLabel>
            </tr>
          </thead>
          <tbody>
            {windowHours.map((hour, idx) => {
              const vis = calculateVisibilityScore(
                hour,
                tonight.moonIllumination,
                timeZone,
                darkWindow,
              );
              const isEvenRow = idx % 2 === 0;

              return (
                <tr
                  key={hour.time}
                  className={`border-b last:border-b-0 transition-colors ${rowBase} ${
                    isEvenRow ? '' : rowAlt
                  } hover:${isDark ? 'bg-slate-800/50' : 'bg-slate-50'}`}
                >
                  {/* Time */}
                  <td className={`px-3 py-2.5 font-medium tabular-nums whitespace-nowrap ${
                    isDark ? 'text-slate-200' : 'text-slate-700'
                  }`}>
                    {formatTime(hour.time, timeZone)}
                  </td>

                  {/* Score chip */}
                  <td className="px-3 py-2.5">
                    <ScoreChip score={vis.score} />
                  </td>

                  {/* Cloud cover */}
                  <td className={`px-3 py-2.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    <CloudBar pct={hour.cloudCover} isDark={isDark} />
                  </td>

                  {/* Seeing */}
                  <td className={`px-3 py-2.5 whitespace-nowrap ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    {hour.seeing != null
                      ? SEEING_NAMES[hour.seeing] ?? `${hour.seeing}`
                      : <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>–</span>
                    }
                  </td>

                  {/* Moon penalty */}
                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${
                    tonight.moonIllumination > 70
                      ? 'text-amber-500'
                      : isDark ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    {Math.round(tonight.moonIllumination)}%
                  </td>

                  {/* Humidity */}
                  <td className={`px-3 py-2.5 tabular-nums ${
                    hour.humidity > 85
                      ? 'text-amber-500'
                      : isDark ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    {hour.humidity}%
                  </td>

                  {/* Wind */}
                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${
                    isDark ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    {formatWind(hour.wind, windUnit)}
                  </td>

                  {/* Temperature */}
                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${
                    isDark ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    {formatTemp(hour.temperature, tempUnit)}
                  </td>

                  {/* Dew warning */}
                  <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                    {vis.dewWarning ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] text-amber-500 ring-1 ring-inset ring-amber-500/25">
                        <Droplets className="h-2.5 w-2.5" />
                        Risk
                      </span>
                    ) : (
                      <span className={`tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                        {formatTemp(hour.dewPoint, tempUnit)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer note */}
      <div className={`px-5 py-3 text-[11px] border-t ${
        isDark
          ? 'border-slate-800 text-slate-600'
          : 'border-slate-100 text-slate-400'
      }`}>
        Moon at {Math.round(tonight.moonIllumination)}% illumination throughout the window.
        {tonight.moonIllumination > 70 && (
          <span className="ml-1 text-amber-500">Bright Moon — favour planets and star clusters.</span>
        )}
      </div>
    </section>
  );
}
