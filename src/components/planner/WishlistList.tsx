/**
 * The wishlist's toolbar (search/sort/bulk actions) and row list. Shared by
 * `WishlistModal` (a small popup opened from the Planner) and the full
 * `/wishlist` page (reached via the modal's expand button, or directly from
 * the top nav, where it is on by default) — the list itself doesn't care which
 * chrome it's sitting in.
 *
 * Clicking a row opens `WishlistObjectModal` with the same full-detail view
 * regardless of which chrome hosts this list, with prev/next over the
 * currently sorted/filtered order.
 */
import { useMemo, useState } from 'react';
import { ArrowUp, CalendarPlus, Check, Search, Sparkles, Star, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IntegrationRemainingChips } from './IntegrationRemainingChips';
import { formatObjectName } from '../../lib/utils';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { formatHm } from '../../lib/timeFormat';
import { formatPlannerDate } from '../../lib/nightWindow';
import { useLibraryIdByObjectId } from '../../hooks/useLibraryIdByObjectId';
import type { WishlistItem, WishlistPriority } from '../../lib/api/wishlist';
import type { PlannerTarget } from '../../lib/api/planner';
import { WishlistObjectModal } from './WishlistObjectModal';
import { WishlistCard } from './WishlistCard';

export interface WishlistListProps {
  items: WishlistItem[];
  /** 'list' (default): compact rows, used by the popup where space is tight.
   *  'grid': picture-forward cards that fill the available width, used by
   *  the full `/wishlist` page. */
  layout?: 'list' | 'grid';
  /** Tonight's observable targets, used to say which wishlist items are up
   *  tonight and to feed "add to plan" real coordinates. An item not in here
   *  either isn't visible tonight or the site/night hasn't loaded yet. */
  targets: PlannerTarget[];
  /** Object ids already on tonight's timeline, so a scheduled item shows a
   *  check instead of an add button. */
  scheduledIds: Set<string>;
  observerLat: number | null;
  observerLon: number | null;
  minAlt: number;
  /** Tonight's moon illumination (0-100), threaded to WishlistObjectModal's
   *  altitude chart for its moon interference strip. */
  moonIllumination?: number;
  observerTimezone?: string;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  onSetPriority: (id: string, priority: WishlistPriority) => void;
  onSetNotes: (id: string, notes: string) => void;
  onRemove: (id: string) => void;
  /** Schedule one target at its highest free point tonight. Undefined when
   *  there's no night window to schedule into, in which case the per-row
   *  schedule button is omitted rather than shown disabled. */
  onQuickAdd?: (target: PlannerTarget) => void;
  /** Schedule every wishlist item that's visible tonight and not already
   *  scheduled, in one pass. */
  onAddAllVisibleToPlan: (items: WishlistItem[]) => void;
  addingAll: boolean;
}

type SortKey = 'priority' | 'name' | 'magnitude' | 'added';

const PRIORITY_ORDER: readonly WishlistPriority[] = ['high', 'medium', 'low'];
const PRIORITY_RANK: Record<WishlistPriority, number> = { high: 0, medium: 1, low: 2 };
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
const SORT_LABEL_KEY: Record<SortKey, string> = {
  priority: 'wishlistPanel.sortPriority',
  name: 'wishlistPanel.sortName',
  magnitude: 'wishlistPanel.sortMagnitude',
  added: 'wishlistPanel.sortAdded',
};
const SORT_ORDER: readonly SortKey[] = ['priority', 'name', 'magnitude', 'added'];

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function matchesQuery(item: WishlistItem, needle: string): boolean {
  const n = normalize(needle);
  return [item.objectId, item.name, item.type, item.constellation ?? '']
    .some(field => normalize(field).includes(n));
}

export function WishlistList({
  items,
  layout = 'list',
  targets,
  scheduledIds,
  observerLat,
  observerLon,
  minAlt,
  moonIllumination,
  observerTimezone,
  isDark,
  isNight,
  isSpace,
  onSetPriority,
  onSetNotes,
  onRemove,
  onQuickAdd,
  onAddAllVisibleToPlan,
  addingAll,
}: WishlistListProps) {
  const { t } = useTranslation('planner');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);

  const targetsById = useMemo(() => {
    const map = new Map<string, PlannerTarget>();
    for (const target of targets) map.set(target.id, target);
    return map;
  }, [targets]);

  // Which wishlist objects have already been imaged, so a row can badge it and
  // the detail modal can offer "View observations" instead of just "Plan".
  // A wishlist entry's objectId is always the canonical catalog id.
  const libraryIdByObjectId = useLibraryIdByObjectId();

  const visibleTonightItems = useMemo(
    () => items.filter(i => targetsById.has(i.objectId)),
    [items, targetsById],
  );
  const schedulableTonight = useMemo(
    () => visibleTonightItems.filter(i => !scheduledIds.has(i.objectId)),
    [visibleTonightItems, scheduledIds],
  );

  const filtered = useMemo(() => {
    const needle = search.trim();
    return needle ? items.filter(i => matchesQuery(i, needle)) : items;
  }, [items, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    switch (sortKey) {
      case 'name':
        copy.sort((a, b) => formatObjectName(a.objectId, a.name).localeCompare(formatObjectName(b.objectId, b.name)));
        break;
      case 'magnitude':
        copy.sort((a, b) => (a.magnitude ?? Infinity) - (b.magnitude ?? Infinity));
        break;
      case 'added':
        copy.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
        break;
      case 'priority':
      default:
        copy.sort((a, b) => {
          const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
          return rank !== 0 ? rank : b.addedAt.localeCompare(a.addedAt);
        });
        break;
    }
    return copy;
  }, [filtered, sortKey]);

  const allFilteredSelected = sorted.length > 0 && sorted.every(i => selected.has(i.id));
  const openIndex = openId ? sorted.findIndex(i => i.id === openId) : -1;
  const openItem = openIndex >= 0 ? sorted[openIndex] : null;

  function toggleSelected(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allFilteredSelected ? new Set() : new Set(sorted.map(i => i.id)));
  }

  function removeSelected() {
    for (const id of selected) onRemove(id);
    setSelected(new Set());
  }

  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';

  return (
    <div>
      {/* Toolbar. Not sticky: this list tops out around a few dozen items, so
          scrolling it away with the rest of the body (the same tradeoff
          CatalogPlanModal's simpler slider-then-list body already makes) beats
          the extra layout machinery a pinned header needs in both the modal
          and the plain page this component renders inside of. "Select all"
          lives here now instead of as its own row above the grid, so the
          toolbar is the one place bulk actions live. */}
      <div className={`pb-2.5 border-b ${border} flex flex-wrap items-center gap-2`}>
        <label className={`flex shrink-0 items-center gap-1.5 text-xs ${subtle}`}>
          <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll} className="rounded" />
          {t('wishlistPanel.selectAll')}
        </label>
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className={`absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${subtle}`} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('wishlistPanel.searchPlaceholder')}
            className={`w-full rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none transition ${
              isDark
                ? 'border border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500 focus:border-amber-500'
                : 'border border-slate-200 bg-slate-100 text-slate-900 placeholder:text-slate-500 focus:border-amber-500'
            }`}
          />
        </div>

        <div className="flex items-center gap-1">
          <span className={`text-xs mr-1 ${subtle}`}>{t('wishlistPanel.sortLabel')}</span>
          {SORT_ORDER.map(key => (
            <button
              key={key}
              onClick={() => setSortKey(key)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                sortKey === key
                  ? 'bg-amber-500 text-white'
                  : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {t(SORT_LABEL_KEY[key])}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <button
              onClick={removeSelected}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('wishlistPanel.removeSelected', { count: selected.size })}
            </button>
          )}
          <button
            onClick={() => onAddAllVisibleToPlan(schedulableTonight)}
            disabled={schedulableTonight.length === 0 || addingAll}
            title={schedulableTonight.length === 0 ? t('wishlistPanel.nothingToAddTonight') : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {addingAll
              ? t('wishlistPanel.addingAll')
              : t('wishlistPanel.addAllVisibleTonight', { count: schedulableTonight.length })}
          </button>
        </div>
      </div>

      {/* List */}
      <div>
        {sorted.length === 0 ? (
          <div className={`text-center py-16 ${subtle}`}>
            <Star className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm max-w-sm mx-auto">
              {items.length === 0 ? t('wishlistPanel.empty') : t('wishlistPanel.noSearchMatch')}
            </p>
          </div>
        ) : (
          <div className="pt-3">
            <div className={layout === 'grid' ? 'grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4' : 'space-y-2'}>
              {layout === 'grid' ? sorted.map(item => (
                <WishlistCard
                  key={item.id}
                  item={item}
                  target={targetsById.get(item.objectId)}
                  isImaged={libraryIdByObjectId.has(item.objectId)}
                  isScheduled={scheduledIds.has(item.objectId)}
                  selected={selected.has(item.id)}
                  observerTimezone={observerTimezone}
                  observerLat={observerLat}
                  observerLon={observerLon}
                  minAlt={minAlt}
                  isDark={isDark}
                  isNight={isNight}
                  isSpace={isSpace}
                  onOpen={setOpenId}
                  onToggleSelected={toggleSelected}
                  onSetPriority={onSetPriority}
                  onRemove={onRemove}
                  onQuickAdd={onQuickAdd}
                />
              )) : sorted.map(item => {
                const target = targetsById.get(item.objectId);
                const isScheduled = scheduledIds.has(item.objectId);
                const isImaged = libraryIdByObjectId.has(item.objectId);
                const peakAt = target?.maxAltTime ? formatHm(new Date(target.maxAltTime), observerTimezone) : null;
                // The night "Schedule" actually targets: whatever night `target`
                // was computed for (see WishlistCard's identical note).
                const scheduleNightLabel = target?.maxAltTime ? formatPlannerDate(new Date(target.maxAltTime)) : null;
                return (
                  <div
                    key={item.id}
                    onClick={() => setOpenId(item.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(item.id); }}
                    className={`rounded-xl border ${border} ${isDark ? 'bg-slate-900/60 hover:bg-slate-900' : 'bg-slate-50 hover:bg-slate-100'} cursor-pointer transition`}
                  >
                    <div className="flex items-start gap-3 p-3">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleSelected(item.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-4 rounded shrink-0"
                        aria-label={t('wishlistPanel.selectItem', { name: item.name })}
                      />
                      <div className="relative shrink-0">
                        <img
                          src={getCatalogThumbnailUrl(item.objectId, item.majorAxisArcmin)}
                          alt=""
                          loading="lazy"
                          className={`w-14 h-14 rounded-lg object-cover bg-slate-800 ${!target ? 'opacity-80' : ''}`}
                        />
                        {isImaged && (
                          <span
                            className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-slate-900"
                            title={t('wishlistObjectModal.imaged')}
                          >
                            <Check className="h-2.5 w-2.5" />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm truncate">{formatObjectName(item.objectId, item.name)}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
                            className={`shrink-0 p-1 rounded-lg transition ${isDark ? 'text-slate-500 hover:text-red-400 hover:bg-white/5' : 'text-slate-400 hover:text-red-500 hover:bg-slate-100'}`}
                            aria-label={t('wishlistPanel.remove', { name: item.name })}
                            title={t('wishlistPanel.remove', { name: item.name })}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className={`text-xs truncate ${subtle}`}>
                          {[item.type, item.constellation, item.magnitude != null ? t('wishlistPanel.mag', { value: item.magnitude.toFixed(1) }) : null]
                            .filter(Boolean).join(' · ')}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1 empty:hidden">
                          <IntegrationRemainingChips objectId={item.objectId} isDark={isDark} />
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 mt-1.5">
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            {PRIORITY_ORDER.map(p => (
                              <button
                                key={p}
                                onClick={() => onSetPriority(item.id, p)}
                                aria-pressed={item.priority === p}
                                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
                                  item.priority === p
                                    ? isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-900'
                                    : isDark ? 'text-slate-500 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                                }`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[p]}`} />
                                {t(PRIORITY_LABEL_KEY[p])}
                              </button>
                            ))}
                          </div>

                          <div className="flex items-center gap-2">
                            {target ? (
                              <span className="flex items-center gap-1 text-[10px] tabular-nums text-emerald-500">
                                <ArrowUp className="h-2.5 w-2.5" />
                                {peakAt ? t('wishlistPanel.visibleTonightAt', { deg: Math.round(target.maxAlt), time: peakAt }) : t('wishlistPanel.visibleTonight', { deg: Math.round(target.maxAlt) })}
                              </span>
                            ) : (
                              <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                {t('wishlistPanel.notVisibleTonight')}
                              </span>
                            )}

                            {target && (
                              isScheduled ? (
                                <span className="flex items-center gap-2">
                                  <span className={`flex items-center gap-1 text-[10px] font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                                    <Check className="h-3 w-3" />
                                    {t('wishlistPanel.scheduled')}
                                  </span>
                                  {onQuickAdd && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); onQuickAdd(target); }}
                                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border border-accent-500/50 text-accent-400 hover:bg-accent-500/10 transition"
                                      title={scheduleNightLabel ? t('wishlistPanel.scheduleAtHighestOn', { date: scheduleNightLabel }) : t('wishlistPanel.scheduleAtHighest')}
                                    >
                                      <CalendarPlus className="h-2.5 w-2.5" />
                                      {t('wishlistPanel.addAnother')}
                                    </button>
                                  )}
                                </span>
                              ) : onQuickAdd ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onQuickAdd(target); }}
                                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
                                  title={scheduleNightLabel ? t('wishlistPanel.scheduleAtHighestOn', { date: scheduleNightLabel }) : t('wishlistPanel.scheduleAtHighest')}
                                >
                                  <CalendarPlus className="h-2.5 w-2.5" />
                                  {t('wishlistPanel.schedule')}
                                </button>
                              ) : null
                            )}
                          </div>
                        </div>

                        <div onClick={(e) => e.stopPropagation()}>
                          <NotesField
                            value={item.notes}
                            isDark={isDark}
                            onSave={(notes) => onSetNotes(item.id, notes)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {openItem && (
        <WishlistObjectModal
          item={openItem}
          target={targetsById.get(openItem.objectId)}
          isImaged={libraryIdByObjectId.has(openItem.objectId)}
          libraryObjectId={libraryIdByObjectId.get(openItem.objectId) ?? null}
          observerLat={observerLat}
          observerLon={observerLon}
          minAlt={minAlt}
          moonIllumination={moonIllumination}
          observerTimezone={observerTimezone}
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          onSetPriority={onSetPriority}
          onSetNotes={onSetNotes}
          onRemove={onRemove}
          onClose={() => setOpenId(null)}
          hasPrev={openIndex > 0}
          hasNext={openIndex < sorted.length - 1}
          onPrev={() => setOpenId(sorted[Math.max(0, openIndex - 1)].id)}
          onNext={() => setOpenId(sorted[Math.min(sorted.length - 1, openIndex + 1)].id)}
        />
      )}
    </div>
  );
}

function NotesField({ value, isDark, onSave }: { value: string; isDark: boolean; onSave: (notes: string) => void }) {
  const { t } = useTranslation('planner');
  const [draft, setDraft] = useState(value);

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft); }}
      placeholder={t('wishlistPanel.notesPlaceholder')}
      className={`mt-1.5 w-full rounded-lg px-2 py-1 text-xs outline-none transition ${
        isDark
          ? 'bg-slate-900 text-slate-200 placeholder:text-slate-600 focus:ring-1 focus:ring-amber-500/50'
          : 'bg-white text-slate-800 placeholder:text-slate-400 focus:ring-1 focus:ring-amber-500/50'
      }`}
    />
  );
}
