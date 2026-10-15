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
import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDraggable } from '@dnd-kit/core';
import { Search, Eye, EyeOff, Info, MoonStar, ArrowUp, Check, Plus, Shuffle, Star, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IntegrationRemainingChips } from './IntegrationRemainingChips';
import { rankTargets, resultsWithoutTarget, serverResultKeys, targetMatches } from '../../lib/plannerSearch';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { useTheme } from '../../hooks/useTheme';
import { formatObjectName } from '../../lib/utils';
import { formatHm } from '../../lib/timeFormat';
import { searchDsoCatalog, type PlannerTarget } from '../../lib/api/planner';
import { filterRecommendations } from '../../lib/filterRecommendations';
import { typeInClass } from '../../lib/objectCategories';
import { variedMix } from '../../lib/variedMix';
import { FilterRecommendationChip } from '../catalogs/FilterRecommendationPanel';
import type { LibraryDragData } from './dragData';
import { computeAltitudeCurve } from '../../lib/altaz';
import { AltitudeChart } from '../AltitudeChart';
import { objectEverVisible, type VisibleSkyMap } from '../../lib/visibilityCheck';
import { useResolvedFov } from '../../hooks/useResolvedFov';
import { useWishlist } from '../../hooks/useWishlist';
import { classifyFit, fitDisplayStrings, objectExtentArcmin } from '../../lib/telescopeFov';
import { FitBadge } from '../FitBadge';

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

const FILTER_LABEL_KEY: Record<LibraryFilter, string> = {
  all: 'libraryPanel.filterAll',
  galaxies: 'libraryPanel.filterGalaxies',
  nebulae: 'libraryPanel.filterNebulae',
  clusters: 'libraryPanel.filterClusters',
  wishlist: 'libraryPanel.filterWishlist',
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
  const { t } = useTranslation('planner');
  const { isDark } = useTheme();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [hideBlocked, setHideBlocked] = useState(false);
  const [varied, setVaried] = useState(false);

  // The rig currently in effect for framing previews (Settings → Telescopes,
  // or the Framing modal's saved override) — used below to badge each row
  // with whether the object fits that frame.
  const fov = useResolvedFov();

  // Rows whose chevron is open, showing their condensed altitude sparkline.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Shared with the Catalogs board and the dedicated Wishlist panel, so
  // starring a target here shows up everywhere else immediately.
  const wishlist = useWishlist();
  const targetsById = useMemo(() => {
    const map = new Map<string, PlannerTarget>();
    for (const t of targets) map.set(t.id, t);
    return map;
  }, [targets]);
  const handleToggleWishlist = useCallback((id: string) => {
    const target = targetsById.get(id);
    if (!target) return;
    wishlist.toggle({
      objectId: target.id,
      name: target.name,
      type: target.type,
      constellation: target.constellation,
      magnitude: target.magnitude,
      majorAxisArcmin: target.majorAxisArcmin,
    });
  }, [targetsById, wishlist]);

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

  // Targets the server's results name, even where the browser's own match misses.
  const serverKeys = useMemo(() => serverResultKeys(dsoSearchQuery.data?.results), [dsoSearchQuery.data]);

  const filtered = useMemo(() => {
    if (isNarrowing) {
      const matched = targets.filter(t => {
        if (filter === 'galaxies' && !typeInClass(t.type, 'galaxy')) return false;
        if (filter === 'nebulae' && !typeInClass(t.type, 'nebula')) return false;
        if (filter === 'clusters' && !typeInClass(t.type, 'cluster')) return false;
        if (filter === 'wishlist' && !wishlist.idSet.has(t.id)) return false;
        if (deferredQuery && !targetMatches(t, deferredQuery, serverKeys)) return false;
        return true;
      });
      // An exact designation or name ("C39", "Eskimo Nebula") outranks objects
      // that merely contain the text (NGC3900).
      return deferredQuery ? rankTargets(matched, deferredQuery) : matched;
    }
    // Default view: already-imaged + top "popular" by best-tonight.
    // "Popular" = has at least one human-friendly common name (Messier, named
    // galaxies, well-known NGC/IC). Cap at POPULAR_LIMIT so the DOM stays light.
    const seen = new Set<string>();
    const out: PlannerTarget[] = [];
    const push = (t: PlannerTarget) => { if (!seen.has(t.id)) { seen.add(t.id); out.push(t); } };

    // Already-imaged objects are always relevant, so pin them at the top.
    for (const t of targets) if (t.isAlreadyImaged) push(t);

    // Then fill with popular objects sorted by tonight's max altitude.
    const popular = targets.filter(t => t.commonNames.length > 0);
    for (const t of popular) {
      if (out.length >= POPULAR_LIMIT) break;
      push(t);
    }
    return out;
  }, [targets, filter, deferredQuery, isNarrowing, wishlist.idSet, serverKeys]);

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
  // already-imaged rows are kept in the default view by construction; in
  // narrowed mode the cap is purely a soft limit.
  // Ordering runs before the cap, so a varied mix decides which rows survive it
  // rather than only reshuffling the ones that did. variedMix is a permutation,
  // so hiddenCount below is unaffected.
  const ordered = useMemo(
    () => (varied ? variedMix(afterHide) : afterHide),
    [afterHide, varied],
  );
  const visibleRows = useMemo(() => ordered.slice(0, RESULT_CAP), [ordered]);
  const hiddenCount = Math.max(0, afterHide.length - visibleRows.length);

  // Catalog matches that aren't in tonight's observable set, annotated with the
  // reason they're unobservable. Hidden when "Hide blocked" is on (these are the
  // most blocked of all) or when filtering by a category tab.
  const unobservable = useMemo<UnobservableEntry[]>(() => {
    if (hideBlocked || filter !== 'all' || trimmedQuery.length === 0) return [];
    const results = dsoSearchQuery.data?.results;
    if (!results) return [];
    const out: UnobservableEntry[] = [];
    // Only results no target already stands for (by id or alias), so an object
    // is never listed both as a target and as "not observable".
    for (const d of resultsWithoutTarget(results, targets)) {
      let reason = t('libraryPanel.notObservableTonight');
      if (observerLat != null && observerLon != null && nightStart && nightEnd) {
        const curve = computeAltitudeCurve(d.ra, d.dec, observerLat, observerLon, nightStart, nightEnd, 15);
        let maxAlt = -Infinity;
        for (const s of curve) if (s.alt > maxAlt) maxAlt = s.alt;
        if (maxAlt < 0) reason = t('libraryPanel.belowHorizonAllNight');
        else if (minAlt != null && maxAlt < minAlt) reason = t('libraryPanel.peaksBelowMinimum', { maxAlt: Math.round(maxAlt), minAlt: Math.round(minAlt) });
        else reason = t('libraryPanel.peaksTonight', { maxAlt: Math.round(maxAlt) });
      }
      out.push({
        id: d.id,
        name: d.name,
        type: d.type,
        magnitude: d.magnitude,
        majorAxisArcmin: d.majorAxisArcmin,
        ra: d.ra,
        dec: d.dec,
        commonNames: d.commonNames,
        reason,
      });
    }
    return out;
  }, [dsoSearchQuery.data, targets, hideBlocked, filter, trimmedQuery, observerLat, observerLon, nightStart, nightEnd, minAlt, t]);

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border ${
        isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
      }`}
    >
      <div className={`space-y-2.5 border-b p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{t('libraryPanel.targets')}</h2>
          <span className={`text-[11px] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            {t('libraryPanel.upThisNight', { count: targets.length })}
          </span>
        </div>
        <div className="relative">
          <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
          <input
            type="text"
            placeholder={t('libraryPanel.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            className={`w-full rounded-xl py-2 pl-9 pr-9 text-sm outline-none transition ${
              isDark
                ? 'border border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500 focus:border-accent-500'
                : 'border border-slate-200 bg-slate-100 text-slate-900 placeholder:text-slate-500 focus:border-accent-500'
            }`}
          />
          {/* Arriving from "Open in planner" seeds this box with the object,
              so without a clear affordance the only way back to the full list
              was to select the text and delete it. */}
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('libraryPanel.clearSearch')}
              className={`absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 transition-colors ${
                isDark ? 'text-slate-500 hover:text-slate-200' : 'text-slate-400 hover:text-slate-700'
              }`}
            >
              <X className="w-4 h-4" />
            </button>
          )}
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
              {t(FILTER_LABEL_KEY[f])}
            </button>
          ))}
        </div>
        {/* Paired with the count it affects, on its own row, rather than
            wedged into the category-filter pills above: it's a visibility
            toggle, not another category, and grouping it with All/Galaxies/
            Nebulae/etc. read as a mismatched extra pill that wrapped alone. */}
        <div className="flex items-center justify-between gap-2">
          <span className={`min-w-0 truncate text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {isNarrowing
              ? (hiddenCount > 0
                  ? t('libraryPanel.matchesOf', { count: afterHide.length, shown: visibleRows.length })
                  : t('libraryPanel.matches', { count: afterHide.length }))
              : t('libraryPanel.popularPicks', { count: visibleRows.length })}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => setVaried(v => !v)}
              className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
                varied
                  ? 'bg-amber-500 text-white'
                  : isDark
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
              title={t('libraryPanel.variedMixTitle')}
            >
              <Shuffle className="h-3 w-3" />
              {t('libraryPanel.variedMix')}
            </button>
            <button
              onClick={() => setHideBlocked(v => !v)}
              className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
                hideBlocked
                  ? 'bg-amber-500 text-white'
                  : isDark
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
              title={t('libraryPanel.hideBlockedTitle')}
            >
              {hideBlocked ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {t('libraryPanel.hideBlocked')}
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length === 0 && unobservable.length === 0 && (
          <div className={`p-6 text-center text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {t('libraryPanel.noTargetsMatch')}
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
            fov={fov}
            isDark={isDark}
            hideType={filter !== 'all'}
            inWishlist={wishlist.idSet.has(target.id)}
            onToggleWishlist={handleToggleWishlist}
            observerLat={observerLat}
            observerLon={observerLon}
            minAlt={minAlt}
            isExpanded={expandedIds.has(target.id)}
            onToggleExpand={handleToggleExpand}
          />
        ))}
        {hiddenCount > 0 && (
          <div className={`px-3 py-3 text-center text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            {t('libraryPanel.moreMatches', { count: hiddenCount })}
          </div>
        )}
        {unobservable.length > 0 && (
          <>
            <div className={`flex items-center gap-2 px-3 pt-4 pb-2 text-[11px] font-medium uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              <MoonStar className="w-3.5 h-3.5" />
              {t('libraryPanel.notObservableHeading')}
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
  fov: ReturnType<typeof useResolvedFov>;
  isDark: boolean;
  /** True while a type filter is active, which makes the type printed on every
   *  row redundant: the filter already guarantees it. */
  hideType: boolean;
  inWishlist: boolean;
  onToggleWishlist: (id: string) => void;
  observerLat: number | null;
  observerLon: number | null;
  minAlt: number | null;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
}

const LibraryRow = memo(function LibraryRow({
  target,
  blockedBySky,
  onShowDetails,
  onQuickAdd,
  isScheduled,
  observerTimezone,
  fov,
  isDark,
  hideType,
  inWishlist,
  onToggleWishlist,
  observerLat,
  observerLon,
  minAlt,
  isExpanded,
  onToggleExpand,
}: LibraryRowProps) {
  const { t } = useTranslation('planner');
  const { t: tCatalogs } = useTranslation('catalogs');
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
  const fit = useMemo(
    () => classifyFit(fov, objectExtentArcmin(null, target.majorAxisArcmin)),
    [fov, target.majorAxisArcmin],
  );
  const fitStrings = useMemo(() => (fit ? fitDisplayStrings(fit, tCatalogs) : null), [fit, tCatalogs]);
  // Filter guidance for this target's type, as the compact chip so the row
  // stays one glance wide.
  const filterRec = useMemo(() => filterRecommendations(target.type), [target.type]);
  const hasLocation = observerLat != null && observerLon != null;

  // Everything the meta line shows, in one place so the separator logic lives
  // with the list itself. The constellation is deliberately absent: nothing the
  // Planner does with a row depends on it (visibility and altitude come from
  // the observer's site), and the object page hero already shows it.
  const metaParts = [
    hideType ? null : target.type,
    target.magnitude != null ? t('libraryPanel.magnitude', { value: target.magnitude.toFixed(1) }) : null,
  ].filter((part): part is string => !!part);

  return (
    <div className={`border-b ${isDark ? 'border-slate-800/70' : 'border-slate-200'}`}>
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`group flex cursor-grab items-center gap-3 px-3 py-2 transition active:cursor-grabbing ${
        isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
      } ${isDragging ? 'opacity-40' : ''} ${blockedBySky ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleExpand(target.id); }}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={!hasLocation}
        aria-expanded={isExpanded}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-30 ${
          isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
        }`}
        aria-label={isExpanded
          ? t('libraryPanel.hideAltitudeChartFor', { name: target.name })
          : t('libraryPanel.showAltitudeChartFor', { name: target.name })}
        title={isExpanded ? t('libraryPanel.hideAltitudeChart') : t('libraryPanel.showAltitudeChart')}
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
      </button>
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
            title={t('libraryPanel.alreadyInLibrary')}
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
        </div>
        {metaParts.length > 0 && (
          <div className={`truncate text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {metaParts.join(' · ')}
          </div>
        )}
        {/* The altitude reads as just the two numbers the row actually needs;
            the sentence that explains them moves into the tooltip, which is
            what keeps this line from wrapping once the filter chip is on it. */}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {blockedBySky ? (
            <span className="text-[10px] text-amber-500">{t('libraryPanel.notInVisibleSky')}</span>
          ) : (
            <span
              title={peakAt
                ? t('libraryPanel.peaksAtAroundTitle', { deg: Math.round(target.maxAlt), time: peakAt })
                : t('libraryPanel.peaksAtTitle', { deg: Math.round(target.maxAlt) })}
              className={`flex items-center gap-1 text-[10px] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-500'}`}
            >
              <ArrowUp className="h-2.5 w-2.5" />
              {peakAt ? t('libraryPanel.peaksAtAround', { deg: Math.round(target.maxAlt), time: peakAt }) : t('libraryPanel.peaksAt', { deg: Math.round(target.maxAlt) })}
            </span>
          )}
          {fit && fitStrings && <FitBadge tag={fit.tag} label={fitStrings.short} title={fitStrings.label} isDark={isDark} />}
          <FilterRecommendationChip recommendations={filterRec} isDark={isDark} />
          <IntegrationRemainingChips objectId={target.id} isDark={isDark} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleWishlist(target.id); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-pressed={inWishlist}
          className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
            inWishlist
              ? 'bg-amber-500/15 text-amber-400'
              : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
          aria-label={inWishlist
            ? t('libraryPanel.removeFromWishlistFor', { name: target.name })
            : t('libraryPanel.addToWishlistFor', { name: target.name })}
          title={inWishlist ? t('libraryPanel.removeFromWishlist') : t('libraryPanel.addToWishlist')}
        >
          <Star className={`h-3.5 w-3.5 ${inWishlist ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onShowDetails(target); }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
            isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
          aria-label={t('libraryPanel.showDetailsFor', { name: target.name })}
          title={t('libraryPanel.showDetails')}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
        {onQuickAdd && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onQuickAdd(target); }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`relative flex h-7 w-7 items-center justify-center rounded-full transition ${
              isScheduled
                ? isDark ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25' : 'bg-emerald-600/15 text-emerald-700 hover:bg-emerald-600/25'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
            aria-label={t('libraryPanel.addToSchedule', { name: target.name })}
            title={isScheduled ? t('libraryPanel.alreadyScheduled') : t('libraryPanel.scheduleAtHighest')}
          >
            {isScheduled ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {/* On the night already, but another block is one tap away. */}
            {isScheduled && (
              <span className={`absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ${
                isDark ? 'bg-emerald-500 text-slate-950 ring-slate-900' : 'bg-emerald-600 text-white ring-white'
              }`}>
                <Plus className="h-2.5 w-2.5" strokeWidth={3} />
              </span>
            )}
          </button>
        )}
      </div>
    </div>
    {isExpanded && hasLocation && (
      <div className="px-3 pb-2">
        <AltitudeChart
          ra={target.ra}
          dec={target.dec}
          lat={observerLat as number}
          lon={observerLon as number}
          minAlt={minAlt ?? undefined}
          timeZone={observerTimezone}
          isDark={isDark}
        />
      </div>
    )}
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
  const { t } = useTranslation('planner');
  const thumbnailUrl = getCatalogThumbnailUrl(entry.id, entry.majorAxisArcmin);

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 border-b cursor-not-allowed ${
        isDark ? 'border-slate-800' : 'border-slate-200'
      }`}
      title={t('libraryPanel.unobservableTitle')}
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
          {[
            entry.type,
            entry.magnitude != null ? t('libraryPanel.magnitude', { value: entry.magnitude.toFixed(1) }) : null,
          ].filter((part): part is string => !!part).join(' · ')}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">{entry.reason}</div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onShowDetails(entry); }}
        className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition ${
          isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
        }`}
        aria-label={t('libraryPanel.showDetailsFor', { name: entry.name })}
        title={t('libraryPanel.showDetails')}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});
