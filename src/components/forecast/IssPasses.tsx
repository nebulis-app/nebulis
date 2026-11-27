/**
 * The ISS passes you can see from the site over the next week (GET /sky-events/iss-passes): when each one starts,
 * where it comes from, how high it gets, where it goes, how bright it is, and whether it fades into Earth's shadow
 * before it sets. A separate request, like the outlook below it, so the forecast never waits for it.
 *
 * The times are only as good as the station's orbital elements, so their age is shown, and old elements are flagged.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Satellite } from 'lucide-react';
import { getIssPasses, type IssPass } from '../../lib/api/iss';
import { formatDate } from '../../lib/formatLocale';
import { formatHm } from '../../lib/timeFormat';
import { compassKey } from '../../lib/compass';

function dayLabel(iso: string, timeZone?: string): string {
  try {
    return formatDate(new Date(iso), { weekday: 'short', day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return formatDate(new Date(iso), { weekday: 'short', day: 'numeric', month: 'short' });
  }
}

export function IssPasses({ siteId, isDark, timeZone }: { siteId: string | null; isDark: boolean; timeZone?: string }) {
  const { t } = useTranslation('forecast');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['iss-passes', siteId],
    queryFn: () => getIssPasses({ siteId, days: 7 }),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const strong = isDark ? 'text-slate-100' : 'text-slate-800';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-500';
  const card = isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white';
  const dir = (az: number) => t(`issPasses.compass.${compassKey(az)}`);

  return (
    <section data-iss-passes>
      <h2 className={`mb-1 flex items-center gap-2 font-display text-lg font-semibold ${strong}`}>
        <Satellite className="h-4 w-4" aria-hidden="true" />
        {t('issPasses.title')}
      </h2>
      <p className={`mb-3 text-xs ${subtle}`}>{t('issPasses.subtitle', { deg: data?.minAltitude ?? 10 })}</p>

      {isLoading && <p className={`text-sm ${subtle}`}>{t('issPasses.loading')}</p>}
      {(isError || (data && !data.tle)) && <p className={`text-sm ${subtle}`}>{t('issPasses.unavailable')}</p>}
      {data?.tle?.stale && (
        <p className={`mb-3 flex items-center gap-1.5 text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {t('issPasses.stale', { days: Math.round(data.tle.ageHours / 24) })}
        </p>
      )}
      {data?.tle && data.passes.length === 0 && <p className={`text-sm ${subtle}`}>{t('issPasses.none')}</p>}

      {data && data.passes.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.passes.map((p: IssPass) => p.visible && (
            <li key={p.visible.start.t} className={`rounded-xl border p-3 text-sm ${card}`} data-iss-pass={p.visible.start.t}>
              <div className={`flex items-baseline justify-between gap-2 ${strong}`}>
                <span className="font-medium">{dayLabel(p.visible.start.t, timeZone)}</span>
                <span className="tabular-nums">
                  {formatHm(new Date(p.visible.start.t), timeZone)}–{formatHm(new Date(p.visible.end.t), timeZone)}
                </span>
              </div>
              <p className={`mt-1 text-xs ${subtle}`}>
                {t('issPasses.path', {
                  from: dir(p.visible.start.az),
                  alt: Math.round(p.visible.peak.alt),
                  peak: dir(p.visible.peak.az),
                  to: dir(p.visible.end.az),
                })}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[0.6875rem]">
                {p.magnitude !== null && (
                  <span className={`rounded-full px-1.5 py-0.5 tabular-nums ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
                    {t('issPasses.magnitude', { mag: p.magnitude.toFixed(1) })}
                  </span>
                )}
                {p.endsInShadow && (
                  <span className={`rounded-full px-1.5 py-0.5 ${isDark ? 'bg-indigo-500/15 text-indigo-300' : 'bg-indigo-50 text-indigo-700'}`} title={t('issPasses.shadowTitle')}>
                    {t('issPasses.shadow')}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {data?.tle && (
        <p className={`mt-2 text-[0.6875rem] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          {t('issPasses.source', { hours: Math.round(data.tle.ageHours) })}
        </p>
      )}
    </section>
  );
}
