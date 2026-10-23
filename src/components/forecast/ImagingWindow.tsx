/**
 * Tonight's imaging window.
 *
 * The dark window (astronomical twilight, falling back to nautical) with every
 * hour inside it tabulated, so you can tell whether the night is worth setting
 * up for and when the cloud, the dew or the Moon arrives.
 *
 * Every number comes from the same helpers the rest of the page uses:
 * `calculateVisibilityScore` and `scoreLabel` from forecastScore, and the
 * window bounds and the Moon's up-spans from forecastNights/forecastScore. The
 * table therefore cannot disagree with the ribbon or the hour detail about the
 * night it is describing.
 */
import { Camera, CloudSun, Droplets, Eye, Moon, Wind } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ForecastHour } from '../../lib/api/planner';
import {
  calculateVisibilityScore,
  formatTemp,
  formatTime,
  formatWind,
  moonUpSpans,
  scoreHex,
  scoreLabel,
  SEEING_KEYS,
  type DarkWindow,
} from '../../lib/forecastScore';
import {
  hoursInWindow,
  resolveImagingWindow,
  type TwilightTimes,
} from '../../lib/forecastNights';
import { useTheme } from '../../hooks/useTheme';

interface TonightInfo extends TwilightTimes {
  moonIllumination: number;
  moonRise: string | null;
  moonSet: string | null;
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

/** One cell in the header label row. */
function ColLabel({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="py-2 px-3 text-left text-[0.6562rem] font-medium uppercase tracking-[0.14em] whitespace-nowrap">
      {children}
    </th>
  );
}

/** Score chip, matching the style of the ribbon's scrub tooltip. */
function ScoreChip({ score, label, isNight }: { score: number; label: string; isNight: boolean }) {
  const hex = scoreHex(score, isNight);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-bold tabular-nums ring-1 ring-inset"
      style={{ color: hex, backgroundColor: `${hex}18`, borderColor: `${hex}45` }}
    >
      {score}
      <span className="font-semibold uppercase tracking-[0.10em] text-[0.5938rem]">{label}</span>
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
      <span className="tabular-nums text-[0.6875rem] w-7 text-right">{pct}%</span>
    </div>
  );
}

export function ImagingWindow({
  hours, tonight, timeZone, darkWindow, tempUnit, windUnit, isDark,
}: Props) {
  const { t } = useTranslation('forecast');
  const { isNight } = useTheme();

  const win = resolveImagingWindow(tonight);
  if (!win) return null;

  const windowHours = hoursInWindow(hours, win);
  // With fewer than two hours there is nothing to tabulate: a single row is not
  // a window, and it is what a night with no real darkness collapses to.
  if (windowHours.length < 2) return null;

  // The Moon is only claimed to be up where a rise or set time says so. With
  // neither, the illumination is still shown but no span is asserted, because
  // an empty span list cannot distinguish "down all night" from "unknown".
  const moonKnown = tonight.moonRise != null || tonight.moonSet != null;
  const moonSpans = moonUpSpans(win.startMs, win.endMs, tonight.moonRise, tonight.moonSet);
  // Closed at both ends: a span clipped to the window's own bounds would
  // otherwise mark the first and last rows as moonless, including the last row
  // of a night the Moon is up for in its entirety.
  const moonUpAt = (ms: number) => moonSpans.some(([a, b]) => ms >= a && ms <= b);
  const moonUpSomeTime = moonSpans.length > 0;
  const moonIsBright = tonight.moonIllumination > 70;
  // A single run reads as one range; the two-run case (up at dusk, sets, rises
  // again before dawn) must not be flattened into "up from X to Y", which is
  // the same over-claim in the summary that the column had per row.
  const moonSingleSpan = moonSpans.length === 1 ? moonSpans[0] : null;
  const moonSplit = moonSpans.length > 1
    ? { until: moonSpans[0][1], from: moonSpans[moonSpans.length - 1][0] }
    : null;

  const fmtMs = (ms: number) => formatTime(new Date(ms).toISOString(), timeZone);
  const rowBase = isDark ? 'border-slate-800/60' : 'border-slate-100';
  const rowAlt = isDark ? 'bg-slate-800/30' : 'bg-slate-50/70';
  const cellText = isDark ? 'text-slate-300' : 'text-slate-600';
  const mutedText = isDark ? 'text-slate-600' : 'text-slate-400';

  return (
    <section
      aria-label={t('imagingWindow.ariaLabel')}
      className={`rounded-2xl border overflow-hidden ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}
    >
      <div className={`px-5 py-4 border-b flex flex-wrap items-center justify-between gap-3 ${
        isDark ? 'border-slate-800' : 'border-slate-100'
      }`}>
        <div className="flex items-center gap-2.5">
          <Camera className={`h-4 w-4 shrink-0 ${isDark ? 'text-violet-400' : 'text-violet-500'}`} />
          <div>
            <h2 className={`font-display font-semibold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              {t('imagingWindow.title')}
            </h2>
            <p className={`text-[0.6875rem] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {win.astronomical ? t('imagingWindow.astronomicalDark') : t('imagingWindow.nauticalDark')}
            </p>
          </div>
        </div>

        {/* Window start to end, with how many hours it covers. */}
        <div className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium tabular-nums ${
          isDark
            ? 'bg-violet-500/10 text-violet-300 ring-1 ring-inset ring-violet-500/20'
            : 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200'
        }`}>
          <span>{formatTime(win.startIso, timeZone)}</span>
          <span className="opacity-50">→</span>
          <span>{formatTime(win.endIso, timeZone)}</span>
          <span className={`ml-1 text-[0.6875rem] font-normal ${isDark ? 'text-violet-400/60' : 'text-violet-500/70'}`}>
            {t('imagingWindow.durationHours', { hours: windowHours.length - 1 })}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-xs">
          <thead>
            <tr className={isDark ? 'text-slate-500 border-b border-slate-800' : 'text-slate-400 border-b border-slate-100'}>
              <ColLabel>{t('imagingWindow.colTime')}</ColLabel>
              <ColLabel>{t('imagingWindow.colScore')}</ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><CloudSun className="h-3 w-3" />{t('imagingWindow.colClouds')}</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{t('imagingWindow.colSeeing')}</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Moon className="h-3 w-3" />{t('imagingWindow.colMoon')}</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Droplets className="h-3 w-3" />{t('imagingWindow.colHumidity')}</span>
              </ColLabel>
              <ColLabel>
                <span className="flex items-center gap-1"><Wind className="h-3 w-3" />{t('imagingWindow.colWind')}</span>
              </ColLabel>
              <ColLabel>{t('imagingWindow.colTemp')}</ColLabel>
              <ColLabel>{t('imagingWindow.colDew')}</ColLabel>
            </tr>
          </thead>
          <tbody>
            {windowHours.map((hour, idx) => {
              const vis = calculateVisibilityScore(hour, tonight.moonIllumination, timeZone, darkWindow, t, isNight);
              const hourMs = new Date(hour.time).getTime();
              const moonUp = moonKnown && moonUpAt(hourMs);
              // Below the horizon is stated plainly; an amber illumination
              // figure only ever appears while the Moon is actually up.
              const moonCell = !moonKnown || moonUp
                ? (moonUp && moonIsBright ? 'text-amber-500' : cellText)
                : mutedText;

              return (
                <tr
                  key={hour.time}
                  className={`border-b last:border-b-0 transition-colors ${rowBase} ${idx % 2 === 0 ? '' : rowAlt} ${
                    isDark ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'
                  }`}
                >
                  <td className={`px-3 py-2.5 font-medium tabular-nums whitespace-nowrap ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {formatTime(hour.time, timeZone)}
                  </td>

                  <td className="px-3 py-2.5">
                    <ScoreChip score={vis.score} label={scoreLabel(vis.score, t)} isNight={isNight} />
                  </td>

                  <td className={`px-3 py-2.5 ${cellText}`}>
                    <CloudBar pct={hour.cloudCover} isDark={isDark} />
                  </td>

                  <td className={`px-3 py-2.5 whitespace-nowrap ${cellText}`}>
                    {hour.seeing != null
                      ? t(`hourDetail.seeingName.${SEEING_KEYS[hour.seeing] ?? 'average'}`)
                      : <span className={mutedText}>–</span>}
                  </td>

                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${moonCell}`}>
                    {moonKnown && !moonUp
                      ? t('imagingWindow.moonDown')
                      : `${Math.round(tonight.moonIllumination)}%`}
                  </td>

                  <td className={`px-3 py-2.5 tabular-nums ${hour.humidity > 85 ? 'text-amber-500' : cellText}`}>
                    {hour.humidity}%
                  </td>

                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${cellText}`}>
                    {formatWind(hour.wind, windUnit)}
                  </td>

                  <td className={`px-3 py-2.5 tabular-nums whitespace-nowrap ${cellText}`}>
                    {formatTemp(hour.temperature, tempUnit)}
                  </td>

                  <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                    {vis.dewWarning ? (
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] ring-1 ring-inset ${
                        isDark
                          ? 'bg-amber-500/10 text-amber-400 ring-amber-500/20'
                          : 'bg-amber-50 text-amber-700 ring-amber-200'
                      }`}>
                        <Droplets className="h-2.5 w-2.5" />
                        {t('imagingWindow.dewRisk')}
                      </span>
                    ) : (
                      <span className={cellText}>{formatTemp(hour.dewPoint, tempUnit)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* What the Moon is actually doing, rather than a claim that it is up all
          night: a 90% Moon that set at 22:00 must not be flagged at 03:00. */}
      <div className={`px-5 py-3 text-[0.6875rem] border-t ${isDark ? 'border-slate-800 text-slate-600' : 'border-slate-100 text-slate-400'}`}>
        {t('imagingWindow.moonSummary', { percent: Math.round(tonight.moonIllumination) })}
        {moonSingleSpan && (
          <> {t('imagingWindow.moonUpDuring', {
            from: fmtMs(moonSingleSpan[0]),
            to: fmtMs(moonSingleSpan[1]),
          })}</>
        )}
        {moonSplit && (
          <> {t('imagingWindow.moonUpSplit', {
            until: fmtMs(moonSplit.until),
            from: fmtMs(moonSplit.from),
          })}</>
        )}
        {moonKnown && !moonUpSomeTime && <> {t('imagingWindow.moonDownAllWindow')}</>}
        {!moonKnown && <> {t('imagingWindow.moonTimesUnknown')}</>}
        {moonIsBright && moonUpSomeTime && (
          <span className="ml-1 text-amber-500">{t('imagingWindow.brightMoon')}</span>
        )}
      </div>
    </section>
  );
}
