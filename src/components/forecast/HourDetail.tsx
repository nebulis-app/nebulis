/**
 * Detail for the hour picked on the night ribbon: what the score is made of,
 * what to point the telescope at, and the raw numbers behind it.
 */
import { CloudRain, Droplets, Star, Wind, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ForecastHour } from '../../lib/api/planner';
import {
  calculateVisibilityScore,
  formatTemp,
  formatTime,
  formatWind,
  scoreLabel,
  SEEING_KEYS,
  type DarkWindow,
} from '../../lib/forecastScore';
import { ScoreDial } from '../ui/ScoreDial';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  hour: ForecastHour;
  moonIllumination: number;
  isDark: boolean;
  onClose: () => void;
  tempUnit: 'celsius' | 'fahrenheit';
  windUnit: 'mph' | 'kmh';
  timeZone?: string;
  darkWindow: DarkWindow | null;
}

function BreakdownBar({ label, value, detail, isDark }: {
  label: string;
  value: number;
  detail: string;
  isDark: boolean;
}) {
  const barColor = value >= 80 ? 'bg-emerald-500' : value >= 60 ? 'bg-blue-500' : value >= 40 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</span>
        <span className={`text-xs font-bold tabular-nums ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{value}</span>
      </div>
      <div className={`h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
        <div className={`h-full rounded-full ${barColor} transition-all duration-500 ease-out`} style={{ width: `${value}%` }} />
      </div>
      <span className={`mt-1 block text-[0.6562rem] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>{detail}</span>
    </div>
  );
}

function Stat({ children, isDark, title }: { children: React.ReactNode; isDark: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] tabular-nums ring-1 ring-inset ${
        isDark ? 'bg-slate-800/60 text-slate-400 ring-slate-700/60' : 'bg-slate-100 text-slate-500 ring-slate-200'
      }`}
    >
      {children}
    </span>
  );
}

export function HourDetail({
  hour, moonIllumination, isDark, onClose, tempUnit, windUnit, timeZone, darkWindow,
}: Props) {
  const { t } = useTranslation('forecast');
  const { isNight } = useTheme();
  const vis = calculateVisibilityScore(hour, moonIllumination, timeZone, darkWindow, t, isNight);

  return (
    <div
      role="region"
      aria-label={t('hourDetail.conditionsAt', { time: formatTime(hour.time, timeZone) })}
      className={`relative overflow-hidden rounded-2xl border p-5 sm:p-6 ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-28 opacity-45"
        style={{ background: `radial-gradient(70% 100% at 12% 0%, ${vis.hex}26 0%, transparent 72%)` }}
      />

      <button
        onClick={onClose}
        aria-label={t('hourDetail.closeAriaLabel')}
        // z-10 keeps it above the `relative` content row below, which otherwise
        // paints over the button and swallows the click.
        className={`absolute right-4 top-4 z-10 rounded-lg p-1.5 transition ${
          isDark ? 'text-slate-500 hover:bg-slate-800 hover:text-slate-300' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
        }`}
      >
        <X className="h-4 w-4" />
      </button>

      <div className="relative flex flex-wrap items-start gap-6 pr-10">
        <ScoreDial score={vis.score} size={104} label={scoreLabel(vis.score, t)} />

        <div className="min-w-[16rem] flex-1">
          <div className={`text-[0.6875rem] font-medium uppercase tracking-[0.16em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {formatTime(hour.time, timeZone)}
          </div>
          <div className="mt-1.5 flex items-start gap-2">
            <Star className="mt-0.5 h-4 w-4 shrink-0" style={{ color: vis.hex }} />
            <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              {vis.recommendation}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5">
            <Stat isDark={isDark}><Wind className="h-3 w-3" />{formatWind(hour.wind, windUnit)}</Stat>
            <Stat isDark={isDark}>{t('hourDetail.temp', { value: formatTemp(hour.temperature, tempUnit) })}</Stat>
            <Stat isDark={isDark}><Droplets className="h-3 w-3" />{t('hourDetail.dewPt', { value: formatTemp(hour.dewPoint, tempUnit) })}</Stat>
            {hour.jetStream != null && (
              <Stat isDark={isDark} title={t('hourDetail.jetStreamTitle')}>
                {t('hourDetail.jet', { value: formatWind(hour.jetStream, windUnit) })}
              </Stat>
            )}
            {hour.cape != null && hour.cape > 50 && (
              <Stat isDark={isDark} title={t('hourDetail.capeTitle')}>
                {t('hourDetail.cape', { value: Math.round(hour.cape) })}
              </Stat>
            )}
            {hour.precipProb > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/12 px-2.5 py-1 text-[0.6875rem] tabular-nums text-amber-500 ring-1 ring-inset ring-amber-500/25">
                <CloudRain className="h-3 w-3" />{t('hourDetail.precip', { percent: hour.precipProb })}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="relative mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <BreakdownBar isDark={isDark} label={t('hourDetail.clouds')} value={vis.breakdown.clouds} detail={t('hourDetail.coverPercent', { percent: hour.cloudCover })} />
        <BreakdownBar isDark={isDark} label={t('hourDetail.seeing')} value={vis.breakdown.seeing} detail={hour.seeing ? t(`hourDetail.seeingName.${SEEING_KEYS[hour.seeing]}`) : t('hourDetail.noData')} />
        <BreakdownBar isDark={isDark} label={t('hourDetail.moon')} value={vis.breakdown.moon} detail={t('hourDetail.litPercent', { percent: moonIllumination })} />
        <BreakdownBar isDark={isDark} label={t('hourDetail.transparency')} value={vis.breakdown.transparency} detail={t('hourDetail.humidityPercent', { percent: hour.humidity })} />
      </div>

      {vis.dewWarning && (
        <div className={`relative mt-5 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs ${
          isDark ? 'bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20' : 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200'
        }`}>
          <Droplets className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t('hourDetail.dewWarning', { temp: formatTemp(hour.temperature, tempUnit) })}
          </span>
        </div>
      )}
    </div>
  );
}
