/**
 * The Comets tab of the planner's target list: the comets and asteroids the planner follows, how each does tonight
 * and over the next two weeks, and the box to add one.
 *
 * Tonight's observable ones are also in the list below as ordinary targets (drag, quick add, Plan My Night); this
 * panel is for the rest: what is not up tonight and when it will be, what Horizons does not know, and managing the
 * list. Library comets are listed without being added: having imaged one is reason enough to follow it.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, Plus, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { addPlannerComet, removePlannerComet, type BodyNight, type CometEntry, type CometsResponse } from '../../lib/api/planner';
import { formatHm } from '../../lib/timeFormat';
import { useAuth } from '../../contexts/AuthContext';
import { cometStatusLine, dayLabel, jplLink } from '../../lib/cometStatus';

/** Nights shown per body, best first. */
const NIGHTS_SHOWN = 5;

export function CometsPanel({ data, loading, isDark, observerTimezone }: {
  data: CometsResponse | undefined;
  loading: boolean;
  isDark: boolean;
  observerTimezone?: string;
}) {
  const { t } = useTranslation('planner');
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['planner-comets'] });
  const add = useMutation({
    mutationFn: (value: string) => addPlannerComet(value),
    onSuccess: () => { setInput(''); setError(null); void refresh(); },
    onError: (err: Error) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: (entry: CometEntry) => removePlannerComet(entry.body.kind, entry.body.designation),
    onSuccess: () => void refresh(),
  });

  const subtle = isDark ? 'text-slate-400' : 'text-slate-500';
  const card = isDark ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50';

  return (
    <div className="space-y-2 p-3" data-comets-panel>
      {data && !data.enabled && <p className={`text-xs ${subtle}`}>{t('comets.disabled')}</p>}

      {isAdmin && (
        <form
          className="flex gap-1.5"
          onSubmit={e => { e.preventDefault(); if (input.trim()) add.mutate(input.trim()); }}
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={t('comets.addPlaceholder')}
            aria-label={t('comets.addLabel')}
            maxLength={80}
            className={`min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-accent-500/30 ${
              isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-800'
            }`}
          />
          <button
            type="submit"
            disabled={!input.trim() || add.isPending}
            className="inline-flex items-center gap-1 rounded-lg bg-accent-500 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-600 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {t('comets.add')}
          </button>
        </form>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}

      {loading && !data && (
        <p className={`flex items-center gap-1.5 text-xs ${subtle}`}>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('comets.loading')}
        </p>
      )}
      {data && data.bodies.length === 0 && <p className={`text-xs ${subtle}`}>{t('comets.empty')}</p>}

      {data?.bodies.map(entry => (
        <div key={`${entry.body.kind}|${entry.body.designation}`} className={`rounded-xl border p-2.5 text-xs ${card}`} data-comet={entry.body.designation}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{entry.body.label}</div>
              <div className={`flex flex-wrap items-center gap-x-2 ${subtle}`}>
                {entry.body.label !== entry.body.designation && <span>{entry.body.designation}</span>}
                <span>{t(`comets.kind.${entry.body.kind}`)}</span>
                {entry.body.libraryObjectId && (
                  <Link to={`/object/${encodeURIComponent(entry.body.libraryObjectId)}`} className="text-accent-500 hover:underline">
                    {t('comets.inLibrary')}
                  </Link>
                )}
              </div>
            </div>
            <a
              href={jplLink(entry.body.designation)}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex shrink-0 items-center gap-1 ${subtle} hover:underline`}
              title={t('comets.jplTitle')}
            >
              JPL
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
            {isAdmin && entry.body.source === 'watchlist' && (
              <button
                type="button"
                onClick={() => remove.mutate(entry)}
                aria-label={t('comets.remove', { name: entry.body.label })}
                title={t('comets.remove', { name: entry.body.label })}
                className={`shrink-0 rounded-full p-0.5 ${subtle} transition hover:bg-black/10`}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="mt-1.5">{cometStatusLine(entry, t, observerTimezone)}</p>
          <NightChips nights={entry.nights} isDark={isDark} observerTimezone={observerTimezone} />
        </div>
      ))}
    </div>
  );
}

/** The next nights it is observable, as small chips: amber when the Moon is close, red when it would wash it out. */
function NightChips({ nights, isDark, observerTimezone }: { nights: BodyNight[]; isDark: boolean; observerTimezone?: string }) {
  const { t } = useTranslation('planner');
  const shown = nights.filter(n => n.observable).slice(0, NIGHTS_SHOWN);
  if (shown.length === 0) return null;
  const tone = (n: BodyNight) => n.moonVerdict === 'warning'
    ? (isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-50 text-red-700')
    : n.moonVerdict === 'caution'
      ? (isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-50 text-amber-700')
      : (isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700');
  return (
    <div className="mt-1.5 flex flex-wrap gap-1" aria-label={t('comets.bestNights')}>
      {shown.map(n => (
        <span
          key={n.start}
          className={`rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums ${tone(n)}`}
          title={t('comets.nightTitle', {
            time: n.bestTime ? formatHm(new Date(n.bestTime), observerTimezone) : '',
            moon: n.moonIllumination,
          })}
        >
          {dayLabel(n.start, observerTimezone)} · {Math.round(n.maxAlt ?? 0)}°
        </span>
      ))}
    </div>
  );
}
