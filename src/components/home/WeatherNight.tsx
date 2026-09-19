/**
 * Tonight's hour-by-hour weather during the dark window — Home dashboard.
 *
 * Design is intentionally aligned with NightOverview ("What's Up Tonight"):
 *   - Same outer background (`bg-[#0e1117]` dark / `bg-slate-50` light)
 *   - Same border shade (`border-slate-700/50` dark / `border-slate-200` light)
 *   - Same header layout: amber circle icon badge + lg/bold title + [12px] subtitle
 *   - Same footer treatment: small muted text strip
 *   - Window start→end badge uses amber accent (matches footer icons)
 *
 * Scoring and formatting reuse the same helpers as ForecastPage so every
 * number on the page is consistent.
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

const SEEING_NAMES: Record<number, string> = {
  1: 'Excellent',
  2: 'Good',
  3: 'Average',
  4: 'Poor',
  5: 'Bad',
};

// ─── Sub-components ────────────────────────────────────────────────────────

function ColLabel({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="py-2 px-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.16em] whitespace-nowrap"
    >
      {children}
    </th>
  );
}

function ScoreChip({ score }: { score: number }) {
  const hex = scoreHex(score);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ring-1 ring-inset"
      style={{ color: hex, backgroundColor: `${hex}18`, borderColor: `${hex}45` }}
    >
      {score}
      <span className="font-semibold uppercase tracking-[0.10em] text-[9.5px]">
        {scoreLabel(score)}
      </span>
    </span>
  );
}

function CloudBar({ pct, isDark }: { pct: number; isDark: boolean }) {
  const color = pct <= 20 ? 'bg-emerald-500' : pct <= 50 ? 'bg-amber-400' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2 min-w-[4.5rem]">
      <div className={`h-1.5 rounded-full overflow-hidden flex-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-[11px] w-7 text-right">{pct}%</span>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export function WeatherNight({
  hours,
  tonight,
  timeZone,
  darkWindow,
  tempUnit,
  windUnit,
  isDark,
}: Props) {
  // Prefer astronomical twilight; fall back to nautical.
  const windowStartIso = tonight.astronomicalTwilightEnd || tonight.nauticalTwilightEnd;
  const windowEndIso   = tonight.astronomicalTwilightStart || tonight.nauticalTwilightStart;

  if (!windowStartIso || !windowEndIso) return null;

  const windowStart = new Date(windowStartIso).getTime();
  const windowEnd   = new Date(windowEndIso).getTime();
  if (windowEnd <= windowStart) return null;

  const windowHours = hours.filter(h => {
    const t = new Date(h.time).getTime();
    return t >= windowStart && t <= windowEnd;
  });
  if (windowHours.length < 2) return null;

  const windowLabel = tonight.astronomicalTwilightEnd ? 'Astronomical dark' : 'Nautical dark';
  const fmt = (iso: string | null) => (iso ? formatTime(iso, timeZone) : '–');

  // ── Shared design tokens (aligned with NightOverview) ─────────────────
  const outerBg   = isDark ? 'bg-[#0e1117] border-slate-700/50' : 'bg-slate-50 border-slate-200 shadow-sm';
  const headerBdr = isDark ? 'border-slate-700/60' : 'border-slate-200';
  const tHeadClr  = isDark ? 'text-slate-500 border-b border-slate-700/60' : 'text-slate-400 border-b border-slate-200';
  const rowBase   = isDark ? 'border-slate-700/40' : 'border-slate-100';
  const rowAlt    = isDark ? 'bg-slate-800/20' : 'bg-slate-50/70';
  const footerBdr = isDark ? 'border-slate-700/60 text-slate-600' : 'border-slate-200 text-slate-400';
  const cellClr   = isDark ? 'text-slate-300' : 'text-slate-600';

  return (
    <section
      aria-label="Weather tonight — hour by hour"
      className={`rounded-2xl border overflow-hidden flex flex-col h-full ${outerBg}`}
    >
      {/* ── Header (aligned with NightOverview) ─────────────────────── */}
      <div className={`px-5 pt-5 pb-4 border-b ${headerBdr} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-center gap-3">
          {/* Amber circle badge — matches NightOverview's sparkle badge */}
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isDark ? 'bg-amber-500/15' : 'bg-amber-50'
          }`}>
            <Camera className={`h-4 w-4 ${isDark ? 'text-amber-400' : 'text-amber-500'}`} />
          </div>
          <div>
            <h2 className={`font-display text-lg font-bold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              Weather Tonight
            </h2>
            <p className={`text-[12px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {windowLabel} · hour by hour
            </p>
          </div>
        </div>

        {/* Window start → end badge — amber to match footer accent */}
        <div className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium tabular-nums ${
          isDark
            ? 'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/20'
            : 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200'
        }`}>
          <span>{fmt(windowStartIso)}</span>
          <span className="opacity-50">→</span>
          <span>{fmt(windowEndIso)}</span>
          <span className={`ml-1 text-[11px] font-normal ${isDark ? 'text-amber-400/60' : 'text-amber-600/70'}`}>
            ({windowHours.length - 1}h)
          </span>
        </div>
      </div>

      {/* ── Hour-by-hour table ───────────────────────────────────────── */}
      <div className="overflow-x-auto flex-1">
        <table className="w-full min-w-[620px] border-collapse text-xs">
          <thead>
            <tr className={tHeadClr}>
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
              const vis        = calculateVisibilityScore(hour, tonight.moonIllumination, timeZone, darkWindow);
              const isEvenRow  = idx % 2 === 0;

              return (
                <tr
                  key={hour.time}
                  className={`border-b last:border-b-0 transition-colors ${rowBase} ${isEvenRow ? rowAlt : ''}`}
                >
                  {/* Time */}
                  <td className={`px-3 py-2.5 font-medium tabular-nums whitespace-nowrap ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {formatTime(hour.time, timeZone)}
                  </td>

                  {/* Score */}
                  <td className="px-3 py-2.5">
                    <ScoreChip score={vis.score} />
                  </td>

                  {/* Cloud cover */}
                  <td className={`px-3 py-2.5 ${cellClr}`}>
                    <CloudBar pct={hour.cloudCover} isDark={isDark} />
                  </td>

                  {/* Seeing */}
                  <td className={`px-3 py-2.5 whitespace-nowrap ${cellClr}`}>
                    {hour.seeing != null
                      ? (SEEING_NAMES[hour.seeing] ?? `${hour.seeing}`)
                      : <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>–</span>
                    }
                  </td>

                  {/* Moon illumination */}
                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${
                    tonight.moonIllumination > 70 ? 'text-amber-500' : cellClr
                  }`}>
                    {Math.round(tonight.moonIllumination)}%
                  </td>

                  {/* Humidity */}
                  <td className={`px-3 py-2.5 tabular-nums ${hour.humidity > 85 ? 'text-amber-500' : cellClr}`}>
                    {hour.humidity}%
                  </td>

                  {/* Wind */}
                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${cellClr}`}>
                    {formatWind(hour.wind, windUnit)}
                  </td>

                  {/* Temperature */}
                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${cellClr}`}>
                    {formatTemp(hour.temperature, tempUnit)}
                  </td>

                  {/* Dew warning / dew point */}
                  <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                    {vis.dewWarning ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] text-amber-500 ring-1 ring-inset ring-amber-500/25">
                        <Droplets className="h-2.5 w-2.5" />
                        Risk
                      </span>
                    ) : (
                      <span className={`tabular-nums ${cellClr}`}>
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

      {/* ── Footer (aligned with NightOverview footer strip) ─────────── */}
      <div className={`px-5 py-3 text-[11px] border-t ${footerBdr}`}>
        Moon at {Math.round(tonight.moonIllumination)}% illumination throughout the window.
        {tonight.moonIllumination > 70 && (
          <span className="ml-1 text-amber-500">
            Bright Moon — favour planets and star clusters.
          </span>
        )}
      </div>
    </section>
  );
}
