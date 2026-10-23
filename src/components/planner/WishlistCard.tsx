/**
 * One wishlist target in the full page's grid. A card, not an overlaid photo
 * tile like CatalogTile: this is a management surface as much as a browse
 * one, so priority and schedule stay visible without a hover, and only the
 * remove button and select checkbox stay hover/selection-gated.
 */
import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarPlus, Check, Compass, Crosshair, EyeOff, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IntegrationRemainingChips } from './IntegrationRemainingChips';
import { formatObjectName } from '../../lib/utils';
import { exploreCategoryForType } from '../../lib/exploreCategory';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { formatHm } from '../../lib/timeFormat';
import { formatPlannerDate } from '../../lib/nightWindow';
import { formatDuration } from '../../lib/plannerNight';
import { StatCell } from '../ui/StatCell';
import { BestImagingChart } from '../ui/BestImagingChart';
import { computeBestImagingWindow } from '../../lib/bestImagingWindow';
import { WISHLIST_PRIORITIES, type WishlistItem, type WishlistPriority } from '../../lib/api/wishlist';
import { searchDsoCatalog, type PlannerTarget } from '../../lib/api/planner';

const PRIORITY_DOT: Record<WishlistPriority, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-slate-400',
};
const PRIORITY_LABEL_KEY: Record<WishlistPriority, string> = {
  high: 'wishlistPanel.priorityHigh',
  medium: 'wishlistPanel.priorityMedium',
  low: 'wishlistPanel.priorityLow',
};

interface Props {
  item: WishlistItem;
  target?: PlannerTarget;
  isImaged: boolean;
  isScheduled: boolean;
  selected: boolean;
  observerTimezone?: string;
  observerLat: number | null;
  observerLon: number | null;
  minAlt: number;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  onOpen: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onSetPriority: (id: string, priority: WishlistPriority) => void;
  onRemove: (id: string) => void;
  onQuickAdd?: (target: PlannerTarget) => void;
}

export const WishlistCard = memo(function WishlistCard({
  item,
  target,
  isImaged,
  isScheduled,
  selected,
  observerTimezone,
  observerLat,
  observerLon,
  minAlt,
  isDark,
  isNight,
  isSpace,
  onOpen,
  onToggleSelected,
  onSetPriority,
  onRemove,
  onQuickAdd,
}: Props) {
  const { t } = useTranslation('planner');
  const navigate = useNavigate();
  // The Explore tile this object is listed under, for "Find similar".
  const similarCategory = exploreCategoryForType(item.type);
  const { t: tCatalogs } = useTranslation('catalogs');
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const accentColor = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  // The night this schedules into if you click it: whichever night `target`
  // was computed for (tonight on the standalone page, or whatever night the
  // Planner popup currently has open). Spelled out in the tooltip since the
  // button itself never asks.
  const scheduleNightLabel = target?.maxAltTime ? formatPlannerDate(new Date(target.maxAltTime)) : null;

  const altColor = target == null ? undefined
    : target.maxAlt >= 60 ? 'text-emerald-500'
    : target.maxAlt >= 30 ? (isDark ? 'text-slate-200' : 'text-slate-700')
    : 'text-amber-500';

  const risesAt = target?.risesAt ? new Date(target.risesAt) : null;
  const setsAt = target?.setsAt ? new Date(target.setsAt) : null;
  const windowLabel = risesAt && setsAt
    ? `${formatHm(risesAt, observerTimezone)}–${formatHm(setsAt, observerTimezone)}`
    : '–';
  const durationMs = risesAt && setsAt ? setsAt.getTime() - risesAt.getTime() : 0;
  const durationValue = durationMs > 0 ? formatDuration(durationMs / 60_000) : '–';

  // Coordinates for the "when is this actually visible" chart below. Free from
  // tonight's target when the object is up tonight; otherwise the same by-id
  // catalog lookup WishlistObjectModal does, under the same query key so
  // opening the card reuses the answer instead of asking again.
  const coordsQuery = useQuery({
    queryKey: ['dso-lookup', item.objectId],
    queryFn: () => searchDsoCatalog(item.objectId, 5),
    enabled: !target,
    staleTime: 5 * 60_000,
  });
  const resolvedEntry = coordsQuery.data?.results.find(r => r.id === item.objectId);
  const ra = target?.ra ?? resolvedEntry?.ra ?? null;
  const dec = target?.dec ?? resolvedEntry?.dec ?? null;

  // Only worth computing for an object that is NOT up tonight, which is exactly
  // the card state this fills in; a card with a target shows stats instead.
  // Cheap either way: 12 monthly night windows at 15-minute sampling measures
  // at under a millisecond.
  const hasLocation = observerLat != null && observerLon != null;
  const bestWindow = useMemo(
    () => (!target && hasLocation && ra != null && dec != null
      ? computeBestImagingWindow(ra, dec, observerLat, observerLon, minAlt)
      : null),
    [target, hasLocation, ra, dec, observerLat, observerLon, minAlt],
  );

  return (
    <div
      onClick={() => onOpen(item.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(item.id); }}
      className={`group flex h-full flex-col cursor-pointer overflow-hidden rounded-2xl border ${border} ${
        isDark ? 'bg-slate-900/60 hover:bg-slate-900' : 'bg-white hover:shadow-md'
      } transition`}
    >
      <div className="relative aspect-[4/3] shrink-0 bg-slate-950">
        <img
          src={getCatalogThumbnailUrl(item.objectId, item.majorAxisArcmin)}
          alt=""
          loading="lazy"
          className={`h-full w-full object-cover transition ${!target ? 'opacity-80' : ''}`}
        />
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelected(item.id)}
          onClick={(e) => e.stopPropagation()}
          className="absolute left-2 top-2 z-10 rounded"
          aria-label={t('wishlistPanel.selectItem', { name: item.name })}
        />
        {isImaged && (
          <span
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white shadow"
            title={t('wishlistObjectModal.imaged')}
          >
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-semibold">{formatObjectName(item.objectId, item.name)}</span>
          <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <button
              onClick={(e) => { e.stopPropagation(); navigate('/planner', { state: { searchQuery: item.objectId } }); }}
              className={`rounded-lg p-1 transition ${isDark ? 'text-slate-500 hover:text-slate-100 hover:bg-white/5' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'}`}
              aria-label={t('wishlistPanel.openInPlanner', { name: item.name })}
              title={t('wishlistPanel.openInPlanner', { name: item.name })}
            >
              <Crosshair className="h-3.5 w-3.5" />
            </button>
            {similarCategory && (
              <button
                onClick={(e) => { e.stopPropagation(); navigate(`/explore/${similarCategory}`); }}
                className={`rounded-lg p-1 transition ${isDark ? 'text-slate-500 hover:text-slate-100 hover:bg-white/5' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'}`}
                aria-label={t('wishlistPanel.findSimilar', { name: item.name })}
                title={t('wishlistPanel.findSimilar', { name: item.name })}
              >
                <Compass className="h-3.5 w-3.5" />
              </button>
            )}
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
            className={`rounded-lg p-1 transition ${
              isDark ? 'text-slate-500 hover:text-red-400 hover:bg-white/5' : 'text-slate-400 hover:text-red-500 hover:bg-slate-100'
            }`}
            aria-label={t('wishlistPanel.remove', { name: item.name })}
            title={t('wishlistPanel.remove', { name: item.name })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          </div>
        </div>
        <div className={`truncate text-xs ${subtle}`}>
          {[item.type, item.constellation, !target && item.magnitude != null ? t('wishlistPanel.mag', { value: item.magnitude.toFixed(1) }) : null]
            .filter(Boolean).join(' · ')}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 empty:hidden">
          <IntegrationRemainingChips objectId={item.objectId} isDark={isDark} />
        </div>

        <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {WISHLIST_PRIORITIES.map(p => (
            <button
              key={p}
              onClick={() => onSetPriority(item.id, p)}
              aria-pressed={item.priority === p}
              title={t(PRIORITY_LABEL_KEY[p])}
              className={`flex h-5 w-5 items-center justify-center rounded-full transition ${
                item.priority === p
                  ? isDark ? 'ring-2 ring-slate-500' : 'ring-2 ring-slate-400'
                  : 'opacity-40 hover:opacity-80'
              }`}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${PRIORITY_DOT[p]}`} />
            </button>
          ))}
        </div>

        {target ? (
          <>
            <div className="mt-2.5 grid grid-cols-2 gap-1.5">
              <StatCell label={t('wishlistPanel.maxAlt')} value={<span className={altColor}>{Math.round(target.maxAlt)}°</span>} isDark={isDark} />
              <StatCell label={t('wishlistPanel.window')} value={<span className="tabular-nums">{windowLabel}</span>} isDark={isDark} />
              <StatCell label={t('wishlistPanel.duration')} value={durationValue} isDark={isDark} />
              <StatCell
                label={t('wishlistPanel.magnitude')}
                value={item.magnitude != null ? item.magnitude.toFixed(1) : <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>–</span>}
                isDark={isDark}
              />
            </div>

            <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
              {isScheduled ? (
                <span className="flex items-center gap-2">
                  <span className={`flex items-center gap-1 text-[0.625rem] font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                    <Check className="h-3 w-3" />
                    {t('wishlistPanel.scheduled')}
                  </span>
                  {onQuickAdd && (
                <button
                  onClick={() => onQuickAdd(target)}
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium border border-accent-500/50 text-accent-400 hover:bg-accent-500/10 transition"
                  title={scheduleNightLabel ? t('wishlistPanel.scheduleAtHighestOn', { date: scheduleNightLabel }) : t('wishlistPanel.scheduleAtHighest')}
                >
                  <CalendarPlus className="h-2.5 w-2.5" />
                  {t('wishlistPanel.addAnother')}
                </button>
                  )}
                </span>
              ) : onQuickAdd ? (
                <button
                  onClick={() => onQuickAdd(target)}
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
                  title={scheduleNightLabel ? t('wishlistPanel.scheduleAtHighestOn', { date: scheduleNightLabel }) : t('wishlistPanel.scheduleAtHighest')}
                >
                  <CalendarPlus className="h-2.5 w-2.5" />
                  {t('wishlistPanel.schedule')}
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <div className={`mt-2.5 flex flex-1 flex-col rounded-lg p-2 ${
            isDark ? 'bg-slate-800/30' : 'bg-slate-100/60'
          }`}>
            {/* "Not visible tonight" alone left the obvious follow-up ("so when
                is it?") unanswered without opening the card. Where the object
                does clear the horizon at some point, the month chart answers it
                in place: the caption carries the verdict and the season, the
                chart carries the shape of the year. */}
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <EyeOff className={`h-3 w-3 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
              <span className={`min-w-0 truncate text-[0.625rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {t('wishlistPanel.notVisibleTonight')}
              </span>
              {bestWindow?.windowStart && bestWindow.windowEnd && (
                <span className="ml-auto shrink-0 text-[0.625rem] font-semibold" style={{ color: accentColor }}>
                  {bestWindow.windowStart === bestWindow.windowEnd
                    ? tCatalogs('catalogObjectModal.bestSingle', { date: bestWindow.windowStart })
                    : tCatalogs('catalogObjectModal.bestRange', { start: bestWindow.windowStart, end: bestWindow.windowEnd })}
                </span>
              )}
            </div>
            {/* An object that never clears the observer's minimum altitude has
                no season to chart, and one that never rises at all draws twelve
                zero-height bars, i.e. an empty box. Say it in words instead. */}
            {bestWindow && !bestWindow.everVisible ? (
              <p className={`mt-1 text-[0.625rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {t('wishlistPanel.neverAboveMinimum', { deg: minAlt })}
              </p>
            ) : bestWindow ? (
              <div className="mt-1 flex flex-1 items-center">
                <div className="w-full">
                  <BestImagingChart
                    compact
                    months={bestWindow.months}
                    windowStart={bestWindow.windowStart}
                    windowEnd={bestWindow.windowEnd}
                    minAlt={minAlt}
                    isDark={isDark}
                    isNight={isNight}
                    isSpace={isSpace}
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}

        {item.notes && (
          <p className={`mt-2 truncate text-[0.6875rem] italic ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {item.notes}
          </p>
        )}
      </div>
    </div>
  );
});
