/**
 * Fifteen nights ahead, from weather-model ensembles (GET /forecast/outlook).
 *
 * One bar per night: the share of model runs (ECMWF, GEM and GFS ensembles,
 * about a hundred) that give at least a few clear dark hours. A probability
 * is a magnitude, so every bar wears the same hue and its height carries the
 * value; colour-coding nights good/bad would read as a verdict the data
 * cannot give two weeks out. Past a week the bars fade, because the models
 * still agree or disagree there, but that agreement means less.
 *
 * Only promising nights get their figure printed; every bar shows its full
 * detail (spread, per-model odds, Moon) on hover or keyboard focus, and the
 * same numbers are in a table for screen readers.
 */
import { useState } from 'react';
import { useQuery, skipToken } from '@tanstack/react-query';
import { Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getForecastOutlook, type OutlookNight } from '../../lib/api/planner';
import { formatDate } from '../../lib/formatLocale';

interface Props {
  siteId: string | null;
  isDark: boolean;
  /** The page accent (hex), already adjusted for night/space themes. */
  accent: string;
}

/** Nights from this index on are past a week: shown faded. */
const TREND_FROM = 7;
/** Bars at or above this probability get their figure printed. */
const LABEL_FROM = 0.5;

function dayLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  // `date` is a calendar day; noon UTC keeps it on that day in any zone.
  return formatDate(new Date(`${date}T12:00:00Z`), { ...options, timeZone: 'UTC' });
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function EnsembleOutlook({ siteId, isDark, accent }: Props) {
  const { t } = useTranslation('forecast');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['forecast-outlook', siteId],
    queryFn: siteId ? () => getForecastOutlook(siteId) : skipToken,
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const [focus, setFocus] = useState<string | null>(null);

  const surface = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const secondary = isDark ? 'text-slate-400' : 'text-slate-500';
  const primary = isDark ? 'text-slate-100' : 'text-slate-800';
  const track = isDark ? 'bg-slate-800/60' : 'bg-slate-100';

  if (!siteId) return null;

  // A response of another shape (an older server, a proxy page, a test mock
  // of the detailed forecast) counts as "unavailable", never as a crash: the
  // outlook sits on the forecast page and must not take it down.
  const usable = !!data && Array.isArray(data.nights) && Array.isArray(data.models);
  const nights = usable ? data.nights : [];
  const totalRuns = usable ? data.models.reduce((a, m) => a + m.members, 0) : 0;
  // The detail line follows hover/focus, and otherwise shows the best night.
  const best = nights.reduce<OutlookNight | null>(
    (b, n) => (n.clearProbability !== null && (!b || n.clearProbability > (b.clearProbability ?? -1)) ? n : b), null);
  const shown = nights.find(n => n.date === focus) ?? best;

  const describe = (n: OutlookNight): string => {
    if (n.clearProbability === null) return t('outlook.noData');
    const parts = [
      t('outlook.runsClear', { pct: pct(n.clearProbability), clear: n.clearMembers, runs: n.members, hours: data?.thresholds?.minClearHours ?? 3 }),
    ];
    if (n.cloudMedian !== null) {
      parts.push(t('outlook.clouds', { median: n.cloudMedian, low: n.cloudP25 ?? n.cloudMedian, high: n.cloudP75 ?? n.cloudMedian }));
    }
    const byModel = n.models.filter(m => m.clearProbability !== null).map(m => `${m.label} ${pct(m.clearProbability!)}`);
    if (byModel.length > 1) parts.push(byModel.join(' · '));
    parts.push(t(n.moonUpAtMidnight ? 'outlook.moonUp' : 'outlook.moonDown', { pct: n.moonIllumination }));
    return parts.join(' · ');
  };

  return (
    <section className={`rounded-2xl border p-5 ${surface}`} aria-labelledby="ensemble-outlook-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="ensemble-outlook-title" className={`font-display text-lg font-semibold ${primary}`}>
          {t('outlook.title')}
        </h2>
        {usable && (
          <span className={`text-xs ${muted}`}>
            {t('outlook.basis', { runs: totalRuns, models: data.models.filter(m => m.members > 0).map(m => m.label).join(', ') })}
          </span>
        )}
      </div>
      <p className={`mt-1 text-sm ${secondary}`}>
        {t('outlook.explain', {
          hours: data?.thresholds?.minClearHours ?? 3,
          cloud: data?.thresholds?.maxCloudCover ?? 30,
        })}
      </p>

      {isLoading ? (
        <div className={`mt-4 h-40 animate-pulse rounded-xl ${track}`} />
      ) : isError || nights.length === 0 ? (
        <p className={`mt-4 text-sm ${muted}`}>{t('outlook.unavailable')}</p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <div
              className="grid min-w-[42rem] gap-[2px]"
              style={{ gridTemplateColumns: `repeat(${nights.length}, minmax(0, 1fr))` }}
              onMouseLeave={() => setFocus(null)}
            >
              {nights.map((n, i) => {
                const p = n.clearProbability;
                const faded = i >= TREND_FROM;
                return (
                  <button
                    key={n.date}
                    type="button"
                    onMouseEnter={() => setFocus(n.date)}
                    onFocus={() => setFocus(n.date)}
                    onBlur={() => setFocus(null)}
                    aria-label={`${dayLabel(n.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${describe(n)}`}
                    className={`group flex flex-col items-stretch rounded-md px-0.5 pt-1 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-500/50 ${
                      shown?.date === n.date ? (isDark ? 'bg-slate-800/50' : 'bg-slate-50') : ''
                    }`}
                  >
                    <span className={`h-4 text-[11px] font-semibold tabular-nums ${primary}`}>
                      {p !== null && p >= LABEL_FROM ? pct(p) : ''}
                    </span>
                    <span className={`relative mt-1 flex h-28 items-end overflow-hidden rounded-t ${track}`}>
                      {p === null ? (
                        <span className={`w-full border-t border-dashed ${isDark ? 'border-slate-700' : 'border-slate-300'}`} />
                      ) : (
                        <span
                          className="w-full rounded-t-[4px] transition-[height]"
                          style={{
                            height: `${Math.max(p * 100, 2)}%`,
                            backgroundColor: accent,
                            opacity: faded ? 0.45 : 0.9,
                          }}
                        />
                      )}
                    </span>
                    <span className={`mt-1.5 text-[10px] uppercase tracking-wide ${muted}`}>
                      {dayLabel(n.date, { weekday: 'narrow' })}
                    </span>
                    {/* Day and month, in the reader's order (31/10 in French, 10/31 in US English). */}
                    <span className={`text-[11px] tabular-nums ${secondary}`}>{dayLabel(n.date, { day: '2-digit', month: '2-digit' })}</span>
                    <Moon
                      aria-hidden="true"
                      className={`mx-auto mt-1 h-3 w-3 ${n.moonIllumination >= 50 && n.moonUpAtMidnight ? (isDark ? 'text-slate-300' : 'text-slate-500') : muted}`}
                      style={{ opacity: 0.35 + (n.moonIllumination / 100) * 0.65 }}
                    />
                  </button>
                );
              })}
            </div>
            <div
              className={`mt-1 grid min-w-[42rem] text-[10px] ${muted}`}
              style={{ gridTemplateColumns: `repeat(${nights.length}, minmax(0, 1fr))` }}
              aria-hidden="true"
            >
              <span className="border-t pt-1" style={{ gridColumn: `1 / span ${Math.min(TREND_FROM, nights.length)}` }}>
                {t('outlook.firstWeek')}
              </span>
              {nights.length > TREND_FROM && (
                <span className="border-t border-dashed pt-1" style={{ gridColumn: `${TREND_FROM + 1} / span ${nights.length - TREND_FROM}` }}>
                  {t('outlook.trend')}
                </span>
              )}
            </div>
          </div>

          {shown && (
            <p className={`mt-3 text-sm ${secondary}`} aria-live="polite">
              <span className={`font-medium ${primary}`}>
                {dayLabel(shown.date, { weekday: 'long', day: 'numeric', month: 'long' })}
              </span>
              {' · '}
              {describe(shown)}
            </p>
          )}

          <table className="sr-only">
            <caption>{t('outlook.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('outlook.colNight')}</th>
                <th scope="col">{t('outlook.colChance')}</th>
                <th scope="col">{t('outlook.colClouds')}</th>
                <th scope="col">{t('outlook.colMoon')}</th>
              </tr>
            </thead>
            <tbody>
              {nights.map(n => (
                <tr key={n.date}>
                  <th scope="row">{dayLabel(n.date, { weekday: 'long', day: 'numeric', month: 'long' })}</th>
                  <td>{n.clearProbability === null ? '—' : pct(n.clearProbability)}</td>
                  <td>{n.cloudMedian === null ? '—' : `${n.cloudMedian}%`}</td>
                  <td>{`${n.moonIllumination}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
