import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Check, Loader2, Moon, Star, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { getNextGoodNights, type ExploreRow, type GoodNight } from '../../lib/api/explore';
import type { PlanResult } from './usePlanObject';
import { formatObjectName } from '../../lib/utils';
import { nightLabel } from '../../lib/exploreFormat';

interface Props {
  row: ExploreRow;
  siteId: string | null;
  isDark: boolean;
  plan: (date: string) => Promise<PlanResult>;
  onClose: () => void;
}


/**
 * The next 30 nights ranked for one object: how high it gets, how long it is
 * up, and how much the moon gets in the way. The three best are starred. It
 * is geometry only (the cloud forecast reaches about a week and isn't mixed
 * in), so the note under the list says so rather than implying a guarantee.
 */
export function PlanNightModal({ row, siteId, isDark, plan, onClose }: Props) {
  const { t, i18n } = useTranslation('catalogs');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, PlanResult>>({});
  const name = formatObjectName(row.id, row.name);

  const query = useQuery({
    queryKey: ['explore-next-nights', row.id, siteId],
    queryFn: () => getNextGoodNights(row.id, { siteId, days: 30 }),
    staleTime: 5 * 60_000,
  });
  const nights = query.data?.nights ?? [];
  // The nights this session put a block on, in the order they were planned: the link opens the Planner on the latest.
  const plannedDates = Object.entries(done).filter(([, r]) => r.ok).map(([date]) => date);
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';

  async function run(night: GoodNight) {
    setBusy(night.date);
    const result = await plan(night.date);
    setDone(d => ({ ...d, [night.date]: result }));
    setBusy(null);
  }

  function resultText(r: PlanResult): string {
    if (r.ok) return t('explore.planNight.planned');
    return r.reason === 'noRoom' ? t('explore.planNight.noRoom') : r.reason === 'noWindow' ? t('explore.planNight.noWindow') : t('explore.planNight.failed');
  }

  const bestNights = nights.filter(n => n.isBest);

  function renderNight(night: GoodNight) {
    const result = done[night.date];
    return (
                  <li
                    key={`${night.isBest ? 'b' : 'n'}-${night.date}`}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                      night.isBest
                        ? isDark ? 'border-accent-500/40 bg-accent-500/10' : 'border-accent-300 bg-accent-50'
                        : isDark ? 'border-slate-800' : 'border-slate-200'
                    }`}
                  >
                    <div className="w-24 shrink-0">
                      <div className="flex items-center gap-1 text-sm font-medium">
                        {night.isBest && <Star className="h-3.5 w-3.5 fill-accent-500 text-accent-500" aria-label={t('explore.planNight.best')} />}
                        {nightLabel(night.date, i18n.language)}
                      </div>
                      <div className={`mt-1 h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} aria-hidden>
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(night.score * 100)}%` }} />
                      </div>
                    </div>
                    <div className={`min-w-0 flex-1 text-xs ${muted}`}>
                      <div>{t('explore.planNight.altHours', { alt: Math.round(night.maxAlt), hours: night.visibleHours })}</div>
                      <div className="flex items-center gap-1">
                        <Moon className={`h-3 w-3 ${night.moonVerdict === 'warning' ? 'text-red-400' : night.moonVerdict === 'caution' ? 'text-amber-400' : ''}`} />
                        {t(`explore.planNight.moon.${night.moonVerdict}`, { illum: night.moonIllumination })}
                      </div>
                    </div>
                    {result ? (
                      <span className={`flex shrink-0 items-center gap-1 text-xs ${result.ok ? 'text-emerald-500' : 'text-accent-500'}`} role="status">
                        {result.ok && <Check className="h-3.5 w-3.5" />}{resultText(result)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void run(night)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-600 disabled:opacity-50"
                      >
                        {busy === night.date ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />}
                        {t('explore.planNight.plan')}
                      </button>
                    )}
                  </li>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title={t('explore.planNight.title', { name })} backdropClassName="bg-black/70">
      <div className={`relative mx-4 flex max-h-[85vh] w-[94vw] max-w-xl flex-col rounded-2xl border p-6 ${
        isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900 shadow-xl'
      }`}>
        <h3 className="shrink-0 pr-8 font-display text-xl font-semibold">{t('explore.planNight.title', { name })}</h3>
        <p className={`mt-1 shrink-0 text-sm ${muted}`}>{t('explore.planNight.subtitle')}</p>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {query.isLoading ? (
            <div className={`flex items-center justify-center gap-2 py-10 text-sm ${muted}`}><Loader2 className="h-4 w-4 animate-spin" />{t('explore.planNight.loading')}</div>
          ) : !query.data?.locationSet ? (
            <p className={`py-8 text-center text-sm ${muted}`}>{t('explore.planNight.noLocation')}</p>
          ) : nights.length === 0 ? (
            <p className={`py-8 text-center text-sm ${muted}`}>{t('explore.planNight.never')}</p>
          ) : (
            <div className="space-y-4">
              {bestNights.length > 0 && (
                <section aria-label={t('explore.planNight.bestNights')}>
                  <h4 className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('explore.planNight.bestNights')}</h4>
                  <ul className="space-y-1.5">{bestNights.map(renderNight)}</ul>
                </section>
              )}
              <section aria-label={t('explore.planNight.allNights')}>
                {bestNights.length > 0 && (
                  <h4 className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${muted}`}>{t('explore.planNight.allNights')}</h4>
                )}
                <ul className="space-y-1.5">{nights.map(renderNight)}</ul>
              </section>
            </div>
          )}
        </div>

        <div className={`mt-3 shrink-0 text-xs ${muted}`}>
          {t('explore.planNight.geometryNote')}{' '}
          {plannedDates.length > 0 && (
            <Link
              to="/planner"
              state={{ searchQuery: row.id, focusDate: plannedDates[plannedDates.length - 1] }}
              className="font-medium text-accent-500 hover:underline"
              onClick={onClose}
            >
              {t('explore.planNight.openPlanner')}
            </Link>
          )}
        </div>

        <button
          onClick={onClose}
          aria-label={t('explore.planNight.close')}
          className={`absolute right-4 top-4 rounded-lg p-1.5 transition ${isDark ? 'text-slate-500 hover:bg-white/5 hover:text-slate-200' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </Modal>
  );
}
