/**
 * Sticky control bar for a catalog board.
 *
 * The progress readout lives in the hero above, so this stays slim: it is
 * what remains pinned under the nav once the hero scrolls away, and it has
 * to work for a 400-object board as well as a 110-object one.
 */
import { Search, X } from 'lucide-react';
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
}

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  imaged: 'Imaged',
  remaining: 'Remaining',
};

const SORT_LABELS: Record<SortKey, string> = {
  catalog: 'Catalog order',
  name: 'Name',
  magnitude: 'Brightest first',
  constellation: 'Constellation',
};

export function CatalogToolbar({
  filter, onFilterChange, counts,
  search, onSearchChange,
  sort, onSortChange,
  shownCount, isDark,
}: Props) {
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
          aria-label="Filter by imaging status"
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
                className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40
                  ${active
                    ? `bg-accent-500/15 ${isDark ? 'text-accent-400' : 'text-accent-700'}`
                    : isDark
                      ? 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/70'
                      : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                  }`}
              >
                {FILTER_LABELS[f]}
                <span className={`tabular-nums opacity-60 ${active ? '' : isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  {counts[f]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex-1" />

        {/* Result count, shown only once a filter is actually narrowing things */}
        <span className={`text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {shownCount === counts.all ? `${shownCount} objects` : `${shownCount} of ${counts.all} shown`}
        </span>

        {/* Search */}
        <div className="relative">
          <Search className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name, id, constellation"
            aria-label="Search this catalog"
            className={`w-48 sm:w-64 rounded-full py-1.5 pl-8 pr-8 text-xs ring-1 ring-inset transition
              focus:outline-none focus:ring-2 focus:ring-accent-500/40
              [&::-webkit-search-cancel-button]:appearance-none ${controlBase}`}
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className={`absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 transition-colors ${
                isDark ? 'text-slate-500 hover:text-slate-200' : 'text-slate-400 hover:text-slate-700'
              }`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Sort */}
        <select
          value={sort}
          onChange={(e) => { if (isSortKey(e.target.value)) onSortChange(e.target.value); }}
          aria-label="Sort objects"
          className={`rounded-full py-1.5 pl-3 pr-7 text-xs ring-1 ring-inset transition cursor-pointer
            focus:outline-none focus:ring-2 focus:ring-accent-500/40 ${controlBase}`}
        >
          {SORT_KEYS.map((key) => (
            <option key={key} value={key}>{SORT_LABELS[key]}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
