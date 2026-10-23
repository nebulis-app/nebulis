import { useState } from 'react';
import { Check, CalendarPlus, Crosshair, Plus, Sparkles, Telescope } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatObjectName } from '../../lib/utils';
import { monthLabel } from '../../lib/exploreFormat';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import type { ExploreRow } from '../../lib/api/explore';
import { VisibilityChip } from './VisibilityChip';
import { FitBadge } from '../FitBadge';
import { fitDisplayStrings } from '../../lib/telescopeFov';

interface Props {
  row: ExploreRow;
  isDark: boolean;
  /** Overrides row.isInWishlist so a just-added card flips before a refetch. */
  inWishlist: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onPlanTonight: () => void;
  /** Opens the Planner on the night Explore is looking at, with this object searched for. */
  onOpenPlanner: () => void;
  /** "Up tonight", or "Up on Sat, Oct 11" when Explore is showing another night. */
  upLabel?: string;
  /** Disabled while a plan request for this card is in flight. */
  planning?: boolean;
  /** Short result shown in place of the plan button after it ran. */
  planNote?: string | null;
  /** Compact variant for horizontal rails. */
  compact?: boolean;
}

/**
 * The large Explore card: picture first, with the name over it, then one line
 * of facts, the visibility chip and two actions. Clicking the picture opens
 * the full object sheet; the buttons act without leaving the page.
 */
export function ExploreCard({ row, isDark, inWishlist, onOpen, onAdd, onPlanTonight, onOpenPlanner, upLabel, planning = false, planNote, compact = false }: Props) {
  const { t, i18n } = useTranslation('catalogs');
  const displayName = formatObjectName(row.id, row.name);
  const subtle = isDark ? 'text-slate-400' : 'text-slate-500';
  const fit = row.fit ? fitDisplayStrings(row.fit, t) : null;
  // A picture that was never cached and cannot be fetched (no internet) 404s.
  // Say so quietly instead of leaving a black box with a broken-image icon.
  const [imageFailed, setImageFailed] = useState(false);
  const canPlanTonight = row.visibility?.kind === 'tonight';
  const facts = [
    row.type,
    row.constellation,
  ].filter(Boolean).join(' · ');
  const vis = row.visibility;
  const alt = vis ? Math.round(vis.kind === 'tonight' && vis.tonightMaxAlt != null ? vis.tonightMaxAlt : vis.maxAlt) : null;
  const altTone = alt == null ? '' : alt >= 60 ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : alt >= 30 ? (isDark ? 'text-amber-400' : 'text-amber-600') : (isDark ? 'text-rose-400' : 'text-rose-600');
  const best = vis?.bestFrom && vis.bestTo
    ? vis.bestFrom === vis.bestTo
      ? monthLabel(vis.bestFrom, i18n.language)
      : `${monthLabel(vis.bestFrom, i18n.language)}–${monthLabel(vis.bestTo, i18n.language)}`
    : null;
  const stats: { label: string; value: string; tone?: string }[] = [];
  if (alt != null) stats.push({ label: t('explore.card.maxAlt'), value: `${alt}°`, tone: altTone });
  if (best) stats.push({ label: t('explore.card.best'), value: best });
  if (row.magnitude != null) stats.push({ label: t('explore.card.magLabel'), value: row.magnitude.toFixed(1) });

  return (
    <div className={`group flex flex-col overflow-hidden rounded-2xl border ${
      isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
    } ${compact ? 'w-60 shrink-0' : ''}`}>
      <button
        type="button"
        onClick={onOpen}
        className="relative block aspect-[4/3] w-full overflow-hidden bg-slate-950 text-left"
        aria-label={t('explore.card.open', { name: displayName })}
      >
        {imageFailed ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-900 to-slate-950 text-white/20" aria-hidden>
            <Sparkles className="h-10 w-10" />
          </div>
        ) : (
          <img
            src={getCatalogThumbnailUrl(row.id, row.majorAxisArcmin)}
            alt=""
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
        <div className="absolute left-2.5 top-2.5 flex max-w-[75%] flex-wrap gap-1">
          <VisibilityChip visibility={row.visibility} isDark={isDark} onImage upLabel={upLabel} />
        </div>
        <div className="absolute right-2.5 top-2.5 flex gap-1">
          {row.isImaged && (
            <span className="flex h-6 items-center gap-1 rounded-full bg-sky-500 px-2 text-[0.6875rem] font-medium text-white" title={t('explore.card.imaged')}>
              <Telescope className="h-3 w-3" />
            </span>
          )}
          {inWishlist && (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-500 text-white" title={t('explore.card.onWishlist')}>
              <Check className="h-3.5 w-3.5" strokeWidth={3} />
            </span>
          )}
        </div>
        <div className="absolute inset-x-3 bottom-2.5">
          <div className="truncate font-display text-base font-semibold leading-tight text-white drop-shadow">{displayName}</div>
          <div className="truncate text-xs text-white/70">{row.designation}{row.aliases[0] ? ` · ${row.aliases[0]}` : ''}</div>
        </div>
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className={`min-w-0 flex-1 truncate text-xs ${subtle}`}>{facts}</div>
          {row.fit && fit && <FitBadge tag={row.fit.tag} label={fit.short} title={fit.label} isDark={isDark} className="shrink-0" />}
        </div>
        {stats.length > 0 && (
          <dl className={`grid gap-1.5 ${stats.length === 3 ? 'grid-cols-3' : stats.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {stats.map((st) => (
              <div key={st.label} className={`min-w-0 rounded-lg px-2 py-1 ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
                <dt className={`text-[0.5625rem] font-medium uppercase tracking-wider ${subtle}`}>{st.label}</dt>
                <dd className={`truncate text-xs font-semibold ${st.tone ?? (isDark ? 'text-slate-100' : 'text-slate-800')}`}>{st.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAdd}
            disabled={inWishlist}
            className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition ${
              inWishlist
                ? isDark ? 'cursor-default bg-emerald-500/15 text-emerald-400' : 'cursor-default bg-emerald-600/15 text-emerald-700'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
          >
            {inWishlist ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {inWishlist ? t('explore.card.added') : t('explore.card.add')}
          </button>
          {planNote ? (
            <span className={`flex-1 truncate text-center text-xs ${subtle}`} role="status">{planNote}</span>
          ) : (
            <button
              type="button"
              onClick={onPlanTonight}
              disabled={planning || !canPlanTonight}
              title={canPlanTonight ? undefined : t('explore.card.notUpTonight')}
              className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              {t('explore.card.planTonight')}
            </button>
          )}
          <button
            type="button"
            onClick={onOpenPlanner}
            title={t('explore.card.openPlanner')}
            aria-label={t('explore.card.openPlannerNamed', { name: displayName })}
            className={`flex items-center justify-center rounded-lg p-1.5 transition ${
              isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
