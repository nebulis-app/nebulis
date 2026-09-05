/**
 * Left pane of the planner: searchable, filterable object library.
 *
 * Each row is a @dnd-kit draggable that hands its DSO entry to the schedule
 * timeline on drop. Rows that never pass through a visible cell in the user's
 * sky map tonight are dimmed but still draggable (user can override).
 *
 * Searching also reaches past tonight's observable set: objects that never
 * clear the horizon (or the user's minimum altitude) on the selected night are
 * filtered out of /planner/tonight server-side, so a search for, say, M37 in
 * summer would otherwise return nothing. We backfill those from the full DSO
 * catalog and render them as dimmed, non-draggable rows. The user can open
 * their details but cannot schedule them.
 */
import { memo, useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDraggable } from '@dnd-kit/core';
import { Search, Star, Eye, EyeOff, Info, MoonStar, ArrowUp, Check, Plus } from 'lucide-react';
import { matchesSearch } from '../../lib/dsoSearch';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { useTheme } from '../../hooks/useTheme';
import { formatObjectName } from '../../lib/utils';
import { formatHm } from '../../lib/timeFormat';
import { searchDsoCatalog, type PlannerTarget } from '../../lib/api/planner';
import type { LibraryDragData } from './dragData';
import { computeAltitudeCurve } from '../../lib/altaz';
import { objectEverVisible, type VisibleSkyMap } from '../../lib/visibilityCheck';

/** Minimal shape the details modal needs — satisfied by both observable
 *  targets and unobservable catalog entries. */
type DetailsTarget = Pick<PlannerTarget, 'id' | 'name' | 'ra' | 'dec' | 'majorAxisArcmin'>;

/** An object that matched the search but isn't observable on the selected
 *  night (never rises, or never clears the user's minimum altitude). Shown
 *  dimmed and non-draggable, with a one-line reason. */
interface UnobservableEntry {
  id: string;
  name: string;
  type: string;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  ra: number;
  dec: number;
  commonNames: string[];
  reason: string;
}

type LibraryFilter = 'all' | 'galaxies' | 'nebulae' | 'clusters' | 'wishlist';

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

/** Chip render order. Object.keys() returns string[], so listing the filters
 *  explicitly keeps the array typed without asserting over Object.keys. */
const FILTER_ORDER: readonly LibraryFilter[] = ['all', 'galaxies', 'nebulae', 'clusters', 'wishlist'];

interface LibraryPanelProps {
  targets: PlannerTarget[];
  initialQuery?: string;
  observerLat: number | null;
  observerLon: number | null;
  nightStart: Date | null;
  nightEnd: Date | null;
  /** Observer's minimum imaging altitude (degrees). Used to explain why a
   *  searched object isn't observable tonight. */
  minAlt: number | null;
  visibleSkyMap: VisibleSkyMap | null | undefined;
  onShowDetails: (target: DetailsTarget) => void;
  /** Schedule a target without dragging: the planner drops it at its highest
   *  free point in the night. This is the only way to add a target on touch
   *  devices, where a drag from a scrolling list is not workable. */
  onQuickAdd?: (target: PlannerTarget) => void;
  /** Ids already on this night's timeline, shown as a tick instead of a plus. */
  scheduledIds?: Set<string>;
  observerTimezone?: string;
}

export function LibraryPanel({
  targets,
  initialQuery = '',
  observerLat,
  observerLon,
  nightStart,
  nightEnd,
  minAlt,
  visibleSkyMap,
  onShowDetails,
  onQuickAdd,
  scheduledIds,
  observerTimezone,
}: LibraryPanelProps) {
  const { isDark } = useTheme();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [hideBlocked, setHideBlocked] = useState(false);

  // Filter against a deferred copy: the input stays at 60fps while the memo
  // below (a scan of 2000+ targets + per-row astronomy math in visibilityById)
  // catches up, and the DSO backfill request fires once typing settles instead
  // of once per keystroke.
  const deferredQuery = useDeferredValue(query);

  /** True when the user is narrowing the catalog (search or non-default filter).
   *  In that mode we scan all 2000+ targets so they can find anything. With no
   *  query and the "all" filter we instead show a curated default list — see
   *  popularDefault below. */
  const isNarrowing = deferredQuery.trim().length > 0 || filter !== 'all';

  const filtered = useMemo(() => {
    if (isNarrowing) {
      return targets.filter(t => {
        if (filter === 'galaxies' && !t.type.toLowerCase().includes('galaxy')) return false;
        if (filter === 'nebulae' && !/nebula|emission|reflection|planetary/i.test(t.type)) return false;
        if (filter === 'clusters' && !/cluster/i.test(t.type)) return false;
        if (filter === 'wishlist' && !t.isInWishlist) return false;
        if (deferredQuery && !matchesSearch(t, deferredQuery)) return false;
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
  }, [targets, filter, deferredQuery, isNarrowing]);

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

  // Backfill from the full DSO catalog while searching. Objects that never
  // clear the horizon tonight are absent from `targets` (the server drops
  // them), so a text search would otherwise return nothing for them.
  const trimmedQuery = deferredQuery.trim();
  const dsoSearchQuery = useQuery({
    // Limit is part of the key: other callers query ['dso-search', q] with
    // smaller limits, and a shared key would serve this panel a truncated list.
    queryKey: ['dso-search', trimmedQuery, 40],
    queryFn: () => searchDsoCatalog(trimmedQuery, 40),
    enabled: trimmedQuery.length > 0,
    staleTime: 5 * 60_000,
  });

  // Catalog matches that aren't in tonight's observable set, annotated with the
  // reason they're unobservable. Hidden when "Hide blocked" is on (these are the
  // most blocked of all) or when filtering by a category/wishlist tab.
  const unobservable = useMemo<UnobservableEntry[]>(() => {
    if (hideBlocked || filter !== 'all' || trimmedQuery.length === 0) return [];
    const results = dsoSearchQuery.data?.results;
    if (!results) return [];
    const targetIds = new Set(targets.map(t => t.id));
    const out: UnobservableEntry[] = [];
    for (const d of results) {
      if (targetIds.has(d.id)) continue; // observable — already shown above
      let reason = 'Not observable on this night';
      if (observerLat != null && observerLon != null && nightStart && nightEnd) {
        const curve = computeAltitudeCurve(d.ra, d.dec, observerLat, observerLon, nightStart, nightEnd, 15);
        let maxAlt = -Infinity;
        for (const s of curve) if (s.alt > maxAlt) maxAlt = s.alt;
        if (maxAlt < 0) reason = 'Below the horizon all night';
        else if (minAlt != null && maxAlt < minAlt) reason = `Peaks at only ${Math.round(maxAlt)}°, below your ${Math.round(minAlt)}° minimum`;
        else reason = `Peaks at only ${Math.round(maxAlt)}° tonight`;
      }
      out.push({
        id: d.id,
        name: d.name,
        type: d.type,
        constellation: d.constellation,
        magnitude: d.magnitude,
        majorAxisArcmin: d.majorAxisArcmin,
        ra: d.ra,
        dec: d.dec,
        commonNames: d.commonNames,
        reason,
      });
    }
    return out;
  }, [dsoSearchQuery.data, targets, hideBlocked, filter, trimmedQuery, observerLat, observerLon, nightStart, nightEnd, minAlt]);

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border ${
        isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
      }`}
    >
      <div className={`space-y-2.5 border-b p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Targets</h2>
          <span className={`text-[11px] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            {targets.length} up this night
          </span>
        </div>
        <div className="relative">
          <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
          <input
            type="text"
            placeholder="Search M81, NGC 7000, Orion..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`w-full rounded-xl py-2 pl-9 pr-3 text-sm outline-none transition ${
              isDark
                ? 'border border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500 focus:border-accent-500'
                : 'border border-slate-200 bg-slate-100 text-slate-900 placeholder:text-slate-500 focus:border-accent-500'
            }`}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTER_ORDER.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-2.5 py-1 text-xs transition ${
                filter === f
                  ? 'bg-accent-500 text-white'
                  : isDark
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
        {/* Paired with the count it affects, on its own row, rather than
            wedged into the category-filter pills above: it's a visibility
            toggle, not another category, and grouping it with All/Galaxies/
            Nebulae/etc. read as a mismatched extra pill that wrapped alone. */}
        <div className="flex items-center justify-between gap-2">
          <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {isNarrowing
              ? `${visibleRows.length}${hiddenCount > 0 ? ` of ${afterHide.length}` : ''} match${afterHide.length === 1 ? '' : 'es'}`
              : `${visibleRows.length} popular picks. Search to reach the rest.`}
          </span>
          <button
            onClick={() => setHideBlocked(v => !v)}
            className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
              hideBlocked
                ? 'bg-amber-500 text-white'
                : isDark
                  ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
            title="Hide objects that never enter a visible cell tonight"
          >
            {hideBlocked ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            Hide blocked
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length === 0 && unobservable.length === 0 && (
          <div className={`p-6 text-center text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            No targets match your filters.
          </div>
        )}
        {visibleRows.map(target => (
          <LibraryRow
            key={target.id}
            target={target}
            blockedBySky={visibilityById.get(target.id) === false}
            onShowDetails={onShowDetails}
            onQuickAdd={onQuickAdd}
            isScheduled={scheduledIds?.has(target.id) ?? false}
            observerTimezone={observerTimezone}
            isDark={isDark}
          />
        ))}
        {hiddenCount > 0 && (
          <div className={`px-3 py-3 text-center text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            {hiddenCount} more match{hiddenCount === 1 ? '' : 'es'}. Refine your search to narrow down.
          </div>
        )}
        {unobservable.length > 0 && (
          <>
            <div className={`flex items-center gap-2 px-3 pt-4 pb-2 text-[11px] font-medium uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              <MoonStar className="w-3.5 h-3.5" />
              Not observable on this night
            </div>
            {unobservable.map(entry => (
              <UnobservableRow
                key={entry.id}
                entry={entry}
                onShowDetails={onShowDetails}
                isDark={isDark}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

interface LibraryRowProps {
  target: PlannerTarget;
  blockedBySky: boolean;
  onShowDetails: (target: DetailsTarget) => void;
  onQuickAdd?: (target: PlannerTarget) => void;
  isScheduled: boolean;
  observerTimezone?: string;
  isDark: boolean;
}

const LibraryRow = memo(function LibraryRow({
  target,
  blockedBySky,
  onShowDetails,
  onQuickAdd,
  isScheduled,
  observerTimezone,
  isDark,
}: LibraryRowProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `library:${target.id}`,
    data: {
      kind: 'library',
      objectId: target.id,
      objectName: target.name,
      ra: target.ra,
      dec: target.dec,
    } satisfies LibraryDragData,
  });

  const thumbnailUrl = getCatalogThumbnailUrl(target.id, target.majorAxisArcmin);
  const peakAt = target.maxAltTime ? formatHm(new Date(target.maxAltTime), observerTimezone) : null;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`group flex cursor-grab items-center gap-3 border-b px-3 py-2 transition active:cursor-grabbing ${
        isDark ? 'border-slate-800/70 hover:bg-slate-800/60' : 'border-slate-200 hover:bg-slate-50'
      } ${isDragging ? 'opacity-40' : ''} ${blockedBySky ? 'opacity-50' : ''}`}
    >
      <div className="relative shrink-0">
        <img
          src={thumbnailUrl}
          alt=""
          className="h-12 w-12 rounded-xl bg-slate-800 object-cover ring-1 ring-inset ring-white/10"
          loading="lazy"
          draggable={false}
        />
        {target.isAlreadyImaged && (
          <span
            className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-slate-900"
            title="Already in your library"
          >
            <Check className="h-2.5 w-2.5" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-sm font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
            {formatObjectName(target.id, target.name)}
          </span>
          {target.isInWishlist && <Star className="h-3 w-3 shrink-0 text-amber-400" fill="currentColor" />}
        </div>
        <div className={`truncate text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {target.type}
          {target.constellation ? ` · ${target.constellation}` : ''}
          {target.magnitude != null ? ` · mag ${target.magnitude.toFixed(1)}` : ''}
        </div>
        {blockedBySky ? (
          <div className="mt-0.5 text-[10px] text-amber-500">Not in your visible sky this night</div>
        ) : (
          <div className={`mt-0.5 flex items-center gap-1 text-[10px] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            <ArrowUp className="h-2.5 w-2.5" />
            Peaks at {Math.round(target.maxAlt)}°{peakAt ? ` around ${peakAt}` : ''}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onShowDetails(target); }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
            isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
          aria-label={`Show details for ${target.name}`}
          title="Show details"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
        {onQuickAdd && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onQuickAdd(target); }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
              isScheduled
                ? isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-600/15 text-emerald-700'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
            aria-label={`Add ${target.name} to the schedule`}
            title={isScheduled ? 'Already scheduled. Add another block.' : 'Schedule at its highest free point'}
          >
            {isScheduled ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
});

interface UnobservableRowProps {
  entry: UnobservableEntry;
  onShowDetails: (target: DetailsTarget) => void;
  isDark: boolean;
}

/**
 * A search hit that can't be imaged on the selected night. Visually dimmed and
 * deliberately NOT a draggable (no useDraggable), so it can never be dropped on
 * the timeline. The details button still works so users can read about it.
 */
const UnobservableRow = memo(function UnobservableRow({ entry, onShowDetails, isDark }: UnobservableRowProps) {
  const thumbnailUrl = getCatalogThumbnailUrl(entry.id, entry.majorAxisArcmin);

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 border-b cursor-not-allowed ${
        isDark ? 'border-slate-800' : 'border-slate-200'
      }`}
      title="Not observable on this night — cannot be added to your plan"
    >
      <img
        src={thumbnailUrl}
        alt=""
        className="h-12 w-12 shrink-0 rounded-xl bg-slate-800 object-cover opacity-40 grayscale"
        loading="lazy"
        draggable={false}
      />
      <div className="min-w-0 flex-1 opacity-50">
        <div className="flex items-center gap-1.5">
          <span className={`font-medium text-sm truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
            {formatObjectName(entry.id, entry.name)}
          </span>
        </div>
        <div className={`text-xs truncate ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {entry.type}
          {entry.constellation ? ` · ${entry.constellation}` : ''}
          {entry.magnitude != null ? ` · mag ${entry.magnitude.toFixed(1)}` : ''}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">{entry.reason}</div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onShowDetails(entry); }}
        className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition ${
          isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
        }`}
        aria-label={`Show details for ${entry.name}`}
        title="Show details"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});
