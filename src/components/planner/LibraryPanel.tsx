/**
 * Left pane of the planner: searchable, filterable object library.
 *
 * Each row is a @dnd-kit draggable that hands its DSO entry to the schedule
 * timeline on drop. Rows that never pass through a visible cell in the user's
 * sky map tonight are dimmed but still draggable (user can override).
 */
import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Search, Star, Eye, EyeOff, Info } from 'lucide-react';
import { matchesSearch } from '../../lib/dsoSearch';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { useTheme } from '../../hooks/useTheme';
import type { PlannerTarget } from '../../lib/api/planner';
import { objectEverVisible, type VisibleSkyMap } from '../../lib/visibilityCheck';

export type LibraryFilter = 'all' | 'galaxies' | 'nebulae' | 'clusters' | 'wishlist';

/** Default-view size. With no search/filter, only this many popular targets
 *  render. Picked so the DOM stays light on first paint; anything beyond is
 *  one keystroke away via search. */
const POPULAR_LIMIT = 100;
/** Soft cap for search / filter results. Past this we render the top matches
 *  and a "and N more — refine your search" footer to keep the DOM bounded
 *  even when a broad filter matches thousands of objects. */
const RESULT_CAP = 200;

const FILTER_LABEL: Record<LibraryFilter, string> = {
  all: 'All',
  galaxies: 'Galaxies',
  nebulae: 'Nebulae',
  clusters: 'Clusters',
  wishlist: 'Wishlist',
};

interface LibraryPanelProps {
  targets: PlannerTarget[];
  observerLat: number | null;
  observerLon: number | null;
  nightStart: Date | null;
  nightEnd: Date | null;
  visibleSkyMap: VisibleSkyMap | null | undefined;
  onShowDetails: (target: PlannerTarget) => void;
}

export function LibraryPanel({
  targets,
  observerLat,
  observerLon,
  nightStart,
  nightEnd,
  visibleSkyMap,
  onShowDetails,
}: LibraryPanelProps) {
  const { isDark } = useTheme();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [hideBlocked, setHideBlocked] = useState(false);

  /** True when the user is narrowing the catalog (search or non-default filter).
   *  In that mode we scan all 2000+ targets so they can find anything. With no
   *  query and the "all" filter we instead show a curated default list — see
   *  popularDefault below. */
  const isNarrowing = query.trim().length > 0 || filter !== 'all';

  const filtered = useMemo(() => {
    if (isNarrowing) {
      return targets.filter(t => {
        if (filter === 'galaxies' && !t.type.toLowerCase().includes('galaxy')) return false;
        if (filter === 'nebulae' && !/nebula|emission|reflection|planetary/i.test(t.type)) return false;
        if (filter === 'clusters' && !/cluster/i.test(t.type)) return false;
        if (filter === 'wishlist' && !t.isInWishlist) return false;
        if (query && !matchesSearch(t, query)) return false;
        return true;
      });
    }
    // Default view: wishlist + already-imaged + top "popular" by best-tonight.
    // "Popular" = has at least one human-friendly common name (Messier, named
    // galaxies, well-known NGC/IC). Cap at POPULAR_LIMIT so the DOM stays light.
    const seen = new Set<string>();
    const out: PlannerTarget[] = [];
    const push = (t: PlannerTarget) => { if (!seen.has(t.id)) { seen.add(t.id); out.push(t); } };

    // Wishlist and already-imaged are always relevant — pin them at the top.
    for (const t of targets) if (t.isInWishlist) push(t);
    for (const t of targets) if (t.isAlreadyImaged) push(t);

    // Then fill with popular objects sorted by tonight's max altitude.
    const popular = targets.filter(t => t.commonNames.length > 0);
    for (const t of popular) {
      if (out.length >= POPULAR_LIMIT) break;
      push(t);
    }
    return out;
  }, [targets, filter, query, isNarrowing]);

  // Pre-compute per-row visibility against the sky map. Skipped when the
  // observer location or night window is missing.
  const visibilityById = useMemo(() => {
    const map = new Map<string, boolean>();
    if (observerLat == null || observerLon == null || !nightStart || !nightEnd) return map;
    for (const t of filtered) {
      map.set(t.id, objectEverVisible(t.ra, t.dec, observerLat, observerLon, nightStart, nightEnd, visibleSkyMap));
    }
    return map;
  }, [filtered, observerLat, observerLon, nightStart, nightEnd, visibleSkyMap]);

  const afterHide = useMemo(() => {
    if (!hideBlocked) return filtered;
    return filtered.filter(t => visibilityById.get(t.id) !== false);
  }, [filtered, visibilityById, hideBlocked]);

  // Cap rendered rows to keep the DOM light even on broad filters. Pinned
  // rows (wishlist + already-imaged) are kept in the default view by
  // construction; in narrowed mode the cap is purely a soft limit.
  const visibleRows = useMemo(() => afterHide.slice(0, RESULT_CAP), [afterHide]);
  const hiddenCount = Math.max(0, afterHide.length - visibleRows.length);

  return (
    <div className={`flex flex-col h-full min-h-0 border-r ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'}`}>
      <div className="p-3 space-y-2 border-b border-slate-700/30">
        <div className="relative">
          <Search className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
          <input
            type="text"
            placeholder="Search M81, NGC 7000, Orion..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none ${
              isDark
                ? 'bg-slate-800 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-emerald-500'
                : 'bg-slate-100 text-slate-900 placeholder:text-slate-500 border border-slate-200 focus:border-emerald-500'
            }`}
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(Object.keys(FILTER_LABEL) as LibraryFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-xs rounded-full transition ${
                filter === f
                  ? 'bg-emerald-600 text-white'
                  : isDark
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
          <button
            onClick={() => setHideBlocked(v => !v)}
            className={`px-2.5 py-1 text-xs rounded-full transition flex items-center gap-1 ${
              hideBlocked
                ? 'bg-amber-500 text-white'
                : isDark
                  ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
            title="Hide objects that never enter a visible cell tonight"
          >
            {hideBlocked ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            Hide blocked
          </button>
        </div>
        <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {isNarrowing
            ? `${visibleRows.length}${hiddenCount > 0 ? ` of ${afterHide.length}` : ''} match${afterHide.length === 1 ? '' : 'es'} · ${targets.length} total`
            : `Showing ${visibleRows.length} popular targets · ${targets.length} total. Search to see the rest.`}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visibleRows.length === 0 && (
          <div className={`p-6 text-center text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            No targets match your filters.
          </div>
        )}
        {visibleRows.map(target => (
          <LibraryRow
            key={target.id}
            target={target}
            blockedBySky={visibilityById.get(target.id) === false}
            onShowDetails={() => onShowDetails(target)}
          />
        ))}
        {hiddenCount > 0 && (
          <div className={`px-3 py-3 text-center text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            {hiddenCount} more match{hiddenCount === 1 ? '' : 'es'}. Refine your search to narrow down.
          </div>
        )}
      </div>
    </div>
  );
}

interface LibraryRowProps {
  target: PlannerTarget;
  blockedBySky: boolean;
  onShowDetails: () => void;
}

function LibraryRow({ target, blockedBySky, onShowDetails }: LibraryRowProps) {
  const { isDark } = useTheme();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `library:${target.id}`,
    data: {
      kind: 'library',
      objectId: target.id,
      objectName: target.name,
      ra: target.ra,
      dec: target.dec,
    },
  });

  const thumbnailUrl = getCatalogThumbnailUrl(target.id, target.majorAxisArcmin);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-3 px-3 py-2 border-b cursor-grab active:cursor-grabbing transition ${
        isDark ? 'border-slate-800 hover:bg-slate-800/60' : 'border-slate-200 hover:bg-slate-50'
      } ${isDragging ? 'opacity-40' : ''} ${blockedBySky ? 'opacity-50' : ''}`}
    >
      <img
        src={thumbnailUrl}
        alt=""
        className="w-12 h-12 rounded object-cover bg-slate-800 shrink-0"
        loading="lazy"
        draggable={false}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`font-medium text-sm truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
            {target.name}
          </span>
          {target.isInWishlist && <Star className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" />}
        </div>
        <div className={`text-xs truncate ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {target.type}
          {target.constellation ? ` · ${target.constellation}` : ''}
          {target.magnitude != null ? ` · mag ${target.magnitude.toFixed(1)}` : ''}
        </div>
        {blockedBySky && (
          <div className="text-[10px] text-amber-500 mt-0.5">Not in visible sky tonight</div>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onShowDetails(); }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition ${
          isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
        }`}
        aria-label={`Show details for ${target.name}`}
        title="Show details"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
