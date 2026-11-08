/**
 * Sticky control bar for a catalog board.
 *
 * The progress readout lives in the hero above, so this stays slim: it is
 * what remains pinned under the nav once the hero scrolls away, and it has
 * to work for a 400-object board as well as a 110-object one.
 */
import { useRef, useState } from 'react';
import { ArrowUpDown, Check, Filter, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useClickOutside } from '../../hooks/useClickOutside';
import { POPOVER, TOOLBAR_BTN, popoverSurface } from '../filters/toolbarStyles';
import { SORT_KEYS, STATUS_FILTERS, isSortKey } from '../../lib/catalogSort';
import type { SortKey, StatusFilter } from '../../lib/catalogSort';

export type { SortKey, StatusFilter };

interface Props {
  filter: StatusFilter;
  onFilterChange: (f: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
  search: string;
  onSearchChange: (v: string) => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  /** How many tiles the grid is about to render, after every filter. */
  shownCount: number;
  isDark: boolean;
  /** Hide objects that never rise above the site's minimum altitude. */
  observableOnly: boolean;
  onObservableOnlyChange: (v: boolean) => void;
  /** How many objects in the catalog are observable from the active site. */
  observableCount: number;
  /** False when no site coordinates are configured; the toggle is disabled. */
  hasLocation: boolean;
  /** The site's minimum imaging altitude, in degrees. */
  minAlt: number;
}

const FILTER_LABEL_KEYS: Record<StatusFilter, string> = {
  all: 'catalogToolbar.filterAll',
  imaged: 'catalogToolbar.filterImaged',
  remaining: 'catalogToolbar.filterRemaining',
};

const SORT_LABEL_KEYS: Record<SortKey, string> = {
  catalog: 'catalogToolbar.sortCatalogOrder',
  name: 'catalogToolbar.sortName',
  magnitude: 'catalogToolbar.sortBrightestFirst',
  constellation: 'catalogToolbar.sortConstellation',
  frameFit: 'catalogToolbar.sortFrameFit',
};

export function CatalogToolbar({
  filter, onFilterChange, counts,
  search, onSearchChange,
  sort, onSortChange,
  shownCount, isDark,
  observableOnly, onObservableOnlyChange, observableCount, hasLocation, minAlt,
}: Props) {
  const { t } = useTranslation('catalogs');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const closeFilters = () => setFiltersOpen(false);
  const closeSort = () => setSortOpen(false);
  useClickOutside(filtersRef, closeFilters, { enabled: filtersOpen, closeOnEscape: true });
  useClickOutside(sortRef, closeSort, { enabled: sortOpen, closeOnEscape: true });
  const activeFilterCount = observableOnly ? 1 : 0;
  const controlBase = isDark
    ? 'bg-slate-900/70 ring-slate-700/60 text-slate-200 placeholder:text-slate-500'
    : 'bg-white ring-slate-200 text-slate-800 placeholder:text-slate-400';

  return (
    <div
      className={`sticky top-16 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-3
        border-b backdrop-blur-xl
        ${isDark ? 'border-slate-800 bg-slate-950/80' : 'border-slate-200 bg-slate-50/85'}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">

        {/* Status segments */}
        <div
          role="group"
          aria-label={t('catalogToolbar.filterByStatus')}
          className={`inline-flex items-center gap-0.5 rounded-full p-0.5 ring-1 ring-inset ${
            isDark ? 'bg-slate-900/70 ring-slate-700/60' : 'bg-white ring-slate-200'
          }`}
        >
          {STATUS_FILTERS.map((f) => {
            const active = filter === f;
            // bg-accent-500/15 and text-accent-400 are both re-mapped by the
            // .night and .space blocks, so the active pill follows the theme.
            return (
              <button
                key={f}
                onClick={() => onFilterChange(f)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40
                  ${active
                    ? `bg-accent-500/15 ${isDark ? 'text-accent-400' : 'text-accent-700'}`
                    : isDark
                      ? 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/70'
                      : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                  }`}
              >
                {t(FILTER_LABEL_KEYS[f])}
                <span className={`tabular-nums opacity-60 ${active ? '' : isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  {counts[f]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex-1" />

        {/* Result count, shown only once a filter is actually narrowing things */}
        {shownCount !== counts.all && (
          <span className={`text-sm tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('catalogToolbar.shownOfTotal', { shown: shownCount, total: counts.all })}
          </span>
        )}

        {/* Search */}
        <div className="relative">
          <Search className={`pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('catalogToolbar.searchPlaceholder')}
            aria-label={t('catalogToolbar.searchAriaLabel')}
            className={`w-48 sm:w-80 rounded-full py-2.5 pl-10 pr-9 text-sm ring-1 ring-inset transition
              focus:outline-none focus:ring-2 focus:ring-accent-500/40
              [&::-webkit-search-cancel-button]:appearance-none ${controlBase}`}
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              aria-label={t('catalogToolbar.clearSearch')}
              className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 transition-colors ${
                isDark ? 'text-slate-500 hover:text-slate-200' : 'text-slate-400 hover:text-slate-700'
              }`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filters: visibility lives here so the bar stays to the status switch */}
        <div ref={filtersRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => { setFiltersOpen((o) => !o); setSortOpen(false); }}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            className={`${TOOLBAR_BTN} ${
              activeFilterCount > 0
                ? isDark ? 'bg-accent-500/15 text-accent-400 ring-accent-500/30' : 'bg-accent-500 text-white ring-accent-500'
                : isDark ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
            }`}
          >
            <Filter className="w-4 h-4" />
            {t('catalogToolbar.filters')}
            {activeFilterCount > 0 && (
              <span className={`min-w-[1.25rem] px-1 rounded-full text-xs text-center ${isDark ? 'bg-accent-500/25' : 'bg-white/25'}`}>
                {activeFilterCount}
              </span>
            )}
          </button>
          {filtersOpen && (
            <div className={`${POPOVER} w-72 max-w-[calc(100vw-2rem)] p-2 ${popoverSurface(isDark)}`}>
              <label
                title={hasLocation
                  ? t('catalogToolbar.observableOnlyHelp', { deg: minAlt })
                  : t('catalogToolbar.observableOnlyNoLocation')}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${
                  hasLocation
                    ? `cursor-pointer ${isDark ? 'text-slate-200 hover:bg-slate-800' : 'text-slate-700 hover:bg-slate-50'}`
                    : 'cursor-not-allowed opacity-45'
                }`}
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={observableOnly}
                  disabled={!hasLocation}
                  onChange={() => onObservableOnlyChange(!observableOnly)}
                />
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ring-1 ring-inset peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 ${
                    observableOnly ? 'bg-accent-500 ring-transparent' : isDark ? 'ring-slate-600' : 'ring-slate-300'
                  }`}
                >
                  {observableOnly && <Check className="h-3 w-3 text-slate-950" strokeWidth={3.5} />}
                </span>
                <span className="flex-1">{t('catalogToolbar.observableOnly')}</span>
                <span className={`text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{observableCount}</span>
              </label>
              <p className={`px-3 pb-1.5 pt-0.5 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {hasLocation
                  ? t('catalogToolbar.observableOnlyHelp', { deg: minAlt })
                  : t('catalogToolbar.observableOnlyNoLocation')}
              </p>
            </div>
          )}
        </div>

        {/* Sort */}
        <div ref={sortRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => { setSortOpen((o) => !o); setFiltersOpen(false); }}
            aria-haspopup="listbox"
            aria-expanded={sortOpen}
            aria-label={t('catalogToolbar.sortObjects')}
            className={`${TOOLBAR_BTN} ${
              isDark
                ? 'bg-slate-900/70 text-slate-300 ring-slate-700/60 hover:bg-slate-800'
                : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-100'
            }`}
          >
            <ArrowUpDown className="w-4 h-4" />
            {t(SORT_LABEL_KEYS[sort])}
          </button>
          {sortOpen && (
            <div role="listbox" className={`${POPOVER} w-52 overflow-hidden ${popoverSurface(isDark)}`}>
              {SORT_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={sort === key}
                  onClick={() => { if (isSortKey(key)) onSortChange(key); setSortOpen(false); }}
                  className={`w-full flex items-center justify-between px-4 py-2.5 text-sm text-left transition-colors ${
                    sort === key
                      ? isDark ? 'bg-slate-800 text-white' : 'bg-slate-50 text-slate-900'
                      : isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {t(SORT_LABEL_KEYS[key])}
                  {sort === key && <Check className="w-3.5 h-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
