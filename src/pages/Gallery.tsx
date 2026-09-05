import { useState, useMemo, useEffect, useRef, useDeferredValue } from 'react';
import { useQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Telescope, AlertCircle, Filter, Download, RotateCw, Upload, PlusCircle, Star, ArrowUpDown, Check, ChevronDown } from 'lucide-react';
import { getLibraryObjects, getLibraryObjectFilters, triggerImport, getImportStatus } from '../lib/api/library';
import { listTelescopes } from '../lib/api/telescopes';
import { ObjectCard } from '../components/ObjectCard';
import { LibraryHero } from '../components/library/LibraryHero';
import { ImportModal } from '../components/ImportModal';
import { FolderImportWizard } from '../components/folderImport/FolderImportWizard';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import { useClickOutside } from '../hooks/useClickOutside';
import { useFilterChipPrefs } from '../hooks/useFilterChipPrefs';
import { FilterCustomizeMenu } from '../components/filters/FilterCustomizeMenu';
import { NewObservationModal } from '../components/NewObservationModal';
import { TourAnchor } from '../components/tour/TourAnchor';
import { buildTypeFilters, matchesFilter, defaultEnabledIds, ALL_FILTER_ID, FAVORITES_FILTER_ID } from '../lib/objectTypeFilters';
import { isOptionValue } from '../lib/typeGuards';

type SortKey = 'name-asc' | 'name-desc' | 'session-date-desc' | 'session-date-asc' | 'session-count-desc' | 'import-desc';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name-asc',           label: 'Name (A–Z)' },
  { value: 'name-desc',          label: 'Name (Z–A)' },
  { value: 'session-date-desc',  label: 'Latest observation' },
  { value: 'session-date-asc',   label: 'Oldest observation' },
  { value: 'session-count-desc', label: 'Most sessions' },
  { value: 'import-desc',        label: 'Recently imported' },
];

const SORT_STORAGE_KEY = 'nebulis-library-sort';

function readStoredSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v !== null && isOptionValue(SORT_OPTIONS, v)) return v;
  } catch { /* ignore */ }
  return 'name-asc';
}

const ALL_TELESCOPES_FILTER = '__all__';

// Catalog "family" keywords. Searching a bare family name (e.g. "Messier")
// surfaces every object in that catalog by testing its catalogId + aliases,
// so M81 ("Bode's Galaxy") shows up even though its name has no "Messier".
// `numbered` turns "messier 81" → "m81", "caldwell 20" → "c20", etc.
const CATALOG_FAMILIES: { name: string; prefix: string; test: (id: string) => boolean }[] = [
  { name: 'messier',   prefix: 'm',     test: id => /^M\d{1,3}$/i.test(id) },
  { name: 'caldwell',  prefix: 'c',     test: id => /^C\d{1,3}$/i.test(id) },
  { name: 'sharpless', prefix: 'sh2-',  test: id => /^SH2-\d+$/i.test(id) },
];

export function Gallery() {
  const { isDark, isNight, isSpace } = useTheme();
  // The hero is night-side in every theme (a picture of the sky), so it takes
  // the bright accent hex directly rather than the light-mode-darkened token,
  // matching the Observations, Planner and Catalog banners.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const [activeFilterId, setActiveFilterId] = useState<string>(ALL_FILTER_ID);
  const [telescopeFilter, setTelescopeFilter] = useState<string>(ALL_TELESCOPES_FILTER);
  const [showImportModal, setShowImportModal] = useState(false);
  const [newObservationOpen, setNewObservationOpen] = useState(false);
  const [wizardPath, setWizardPath] = useState<string | null>(null);
  const [wizardSubframes, setWizardSubframes] = useState(false);
  const [wizardFits, setWizardFits] = useState(true);
  const [wizardArchiveAll, setWizardArchiveAll] = useState(false);
  const [wizardTelescopeId, setWizardTelescopeId] = useState<string | null>(null);
  const [wizardTmpId, setWizardTmpId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(readStoredSort);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const [telescopeMenuOpen, setTelescopeMenuOpen] = useState(false);
  const telescopeMenuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: objects, isLoading, error } = useQuery({
    queryKey: ['library-objects'],
    queryFn: getLibraryObjects,
    // Building this list does a DB read plus a stat per object server-side, so
    // avoid refetching it on every navigation back to the library. Favorite and
    // import mutations invalidate this key explicitly when the data changes.
    staleTime: 60_000,
  });

  const { data: objectFilters = [] } = useQuery({
    queryKey: ['library-object-filters'],
    queryFn: getLibraryObjectFilters,
  });

  // Unifying Lens: overlay every in-flight favorite toggle (from any
  // ObjectCard — they share this mutationKey) onto the server list, so the
  // Favorites chip reacts immediately without either card writing into the
  // shared query cache. No setQueryData, no rollback; the overlay disappears
  // on its own once each mutation settles and 'library-objects' re-fetches.
  const pendingFavorites = useMutationState<{ objectId: string; next: boolean }>({
    filters: { mutationKey: ['toggle-object-favorite'], status: 'pending' },
    select: m => m.state.variables as { objectId: string; next: boolean },
  });
  const objectsWithPendingFavorites = useMemo(() => {
    if (!objects) return objects;
    if (pendingFavorites.length === 0) return objects;
    const overlay = new Map(pendingFavorites.map(p => [p.objectId, p.next]));
    return objects.map(o => (overlay.has(o.id) ? { ...o, isFavorite: overlay.get(o.id)! } : o));
  }, [objects, pendingFavorites]);

  // Granular filters for every distinct object type in the library, with
  // counts. Excludes any type whose label already matches a curated group
  // (e.g. exact "Galaxy" vs the "Galaxy" group) to avoid two identically
  // labeled chips.
  const typeFilters = useMemo(
    () => buildTypeFilters((objectsWithPendingFavorites ?? []).map(o => o.type), objectFilters),
    [objectsWithPendingFavorites, objectFilters],
  );
  const defaultIds = useMemo(() => defaultEnabledIds(objectFilters), [objectFilters]);
  const { enabledIds, toggle: toggleChip, clearAll: clearAllChips } = useFilterChipPrefs(defaultIds);

  // Clearing unpins every chip AND resets the active selection (Favorites
  // isn't gated by enabledIds, so it needs an explicit reset too).
  function handleClearAllFilters() {
    clearAllChips();
    setActiveFilterId(ALL_FILTER_ID);
  }

  // The chips shown on the top row: enabled curated groups, then enabled types.
  const chips = useMemo(() => {
    const groupChips = objectFilters
      .filter(f => f.id !== ALL_FILTER_ID && enabledIds.has(f.id))
      .map(f => ({ id: f.id, label: f.label }));
    const typeChips = typeFilters
      .filter(t => enabledIds.has(t.id))
      .map(t => ({ id: t.id, label: t.label }));
    return [...groupChips, ...typeChips];
  }, [objectFilters, typeFilters, enabledIds]);

  // If the active chip was removed via the customize menu (or no longer
  // corresponds to a visible chip, e.g. a type suppressed by the group-label
  // collision check above) fall back to All during render (deriving avoids a
  // corrective setState-in-effect).
  const effectiveFilterId =
    activeFilterId === ALL_FILTER_ID ||
    activeFilterId === FAVORITES_FILTER_ID ||
    chips.some(c => c.id === activeFilterId)
      ? activeFilterId
      : ALL_FILTER_ID;

  useClickOutside(filterMenuRef, () => setFilterMenuOpen(false), {
    enabled: filterMenuOpen,
    closeOnEscape: true,
  });
  useClickOutside(telescopeMenuRef, () => setTelescopeMenuOpen(false), {
    enabled: telescopeMenuOpen,
    closeOnEscape: true,
  });

  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
  });
  const showTelescopeUI = telescopes.length >= 2;
  // If the selected scope was deleted, fall back to "All" during render rather
  // than via a corrective setState-in-effect (which flashed one frame of an
  // empty library). Same approach as effectiveFilterId above.
  const effectiveTelescopeFilter =
    telescopeFilter === ALL_TELESCOPES_FILTER || telescopes.some(t => t.id === telescopeFilter)
      ? telescopeFilter
      : ALL_TELESCOPES_FILTER;

  useEffect(() => {
    if (!sortOpen) return;
    function handleClick(e: MouseEvent) {
      // `target` is `EventTarget | null`; only a Node can be "inside" the menu.
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (sortRef.current && !sortRef.current.contains(target)) {
        setSortOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [sortOpen]);

  function applySort(key: SortKey) {
    setSortKey(key);
    setSortOpen(false);
    try { localStorage.setItem(SORT_STORAGE_KEY, key); } catch { /* ignore */ }
  }



  const { data: importStatus } = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.running ? 2000 : false;
    },
  });

  // Auto-import-enabled scopes drive the manual import default. With one
  // scope this matches the legacy single-scope behavior; with several, the
  // button kicks off a sequential fan-out across every enabled scope so the
  // user doesn't have to switch the active telescope and click again.
  const enabledTelescopes = telescopes.filter(t => t.autoImportEnabled);
  const importsAllScopes = enabledTelescopes.length >= 2;

  const importResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (importResetTimerRef.current) clearTimeout(importResetTimerRef.current); }, []);

  const importMutation = useMutation({
    mutationFn: () => triggerImport(importsAllScopes ? { all: true } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
      // Reset success state after 3 seconds so the checkmark doesn't persist forever
      importResetTimerRef.current = setTimeout(() => importMutation.reset(), 3000);
    },
    onError: () => {
      // Refresh in case the failure (e.g. a 409 lock conflict) means an import
      // is actually running under someone else's request right now.
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
    },
  });

  // Deferred so typing stays responsive while the object list re-filters + re-sorts.
  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(() => {
    const s = deferredSearch.toLowerCase().trim();
    // "messier 81" → "m81", "caldwell 20" → "c20", "sharpless 298" → "sh2-298"
    const numbered = s.match(/^(messier|caldwell|sharpless)\s*(\d+)$/);
    const effectiveTerm = numbered
      ? `${CATALOG_FAMILIES.find(f => f.name === numbered[1])!.prefix}${numbered[2]}`
      : s;
    // Bare family keyword (≥3 chars, no number) → show the whole catalog.
    const family = !numbered && s.length >= 3
      ? CATALOG_FAMILIES.find(f => f.name.startsWith(s))
      : undefined;

    const list = objectsWithPendingFavorites?.filter(obj => {
      const matchesFamily = family
        ? [obj.catalogId, ...(obj.aliases ?? [])].some(id => family.test(id))
        : false;
      const matchesSearch =
        !s ||
        matchesFamily ||
        obj.name.toLowerCase().includes(effectiveTerm) ||
        obj.catalogId.toLowerCase().includes(effectiveTerm) ||
        obj.constellation.toLowerCase().includes(effectiveTerm) ||
        (obj.aliases ?? []).some(a => a.toLowerCase().startsWith(effectiveTerm));

      const matchesType = matchesFilter(
        effectiveFilterId,
        { objectType: obj.type, filterTags: obj.filterTags, isFavorite: obj.isFavorite },
        objectFilters,
      );

      const matchesTelescope =
        effectiveTelescopeFilter === ALL_TELESCOPES_FILTER ||
        (obj.telescopeIds?.includes(effectiveTelescopeFilter) ?? false);

      return matchesSearch && matchesType && matchesTelescope;
    });

    if (!list) return list;

    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'session-date-desc':
          return (b.lastSessionDate ?? '').localeCompare(a.lastSessionDate ?? '');
        case 'session-date-asc':
          return (a.lastSessionDate ?? '').localeCompare(b.lastSessionDate ?? '');
        case 'session-count-desc':
          return (b.sessionCount ?? 0) - (a.sessionCount ?? 0);
        case 'import-desc':
          return (b.lastImport ?? '').localeCompare(a.lastImport ?? '');
        default: {
          // Every SORT_OPTIONS entry must define an order here. Unreachable at
          // runtime (readStoredSort narrows), so it keeps the neutral compare.
          const _exhaustive: never = sortKey;
          void _exhaustive;
          return 0;
        }
      }
    });
  }, [objectsWithPendingFavorites, deferredSearch, effectiveFilterId, effectiveTelescopeFilter, objectFilters, sortKey]);

  // The hero describes the whole library, so it ignores the search box and the
  // type chips. It does honor the telescope facet (a persistent lens on the
  // collection), and says so via filteredLabel when one is active.
  const heroObjects = useMemo(() => {
    if (effectiveTelescopeFilter === ALL_TELESCOPES_FILTER) return objectsWithPendingFavorites ?? [];
    return (objectsWithPendingFavorites ?? []).filter(o => o.telescopeIds?.includes(effectiveTelescopeFilter) ?? false);
  }, [objectsWithPendingFavorites, effectiveTelescopeFilter]);
  const heroFilteredLabel =
    effectiveTelescopeFilter === ALL_TELESCOPES_FILTER
      ? null
      : telescopes.find(t => t.id === effectiveTelescopeFilter)?.name ?? null;

  const isImporting = importStatus?.running ?? false;

  return (
    <div className="space-y-6">
      <TourAnchor id="library" className="block space-y-6">
        <LibraryHero objects={heroObjects} accent={accent} filteredLabel={heroFilteredLabel} />

      {/* Import failure, either a synchronous rejection (e.g. lock conflict)
          or a backend-reported error from a run that already finished. A
          cancelled run is deliberately excluded: the user just did that
          themselves, so it needs no banner here — it's recorded in Sync
          History (Backup Status page) as "Cancelled" instead. */}
      {!isImporting && (importMutation.isError || (importStatus?.error && !importStatus.cancelled)) && (
        <div className={`flex items-center gap-3 px-5 py-3 rounded-xl border ${
          isDark ? 'bg-red-500/5 border-red-500/20 text-red-400' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-sm font-medium">
            {importMutation.isError
              ? (importMutation.error instanceof Error ? importMutation.error.message : 'Failed to start import')
              : importStatus?.error}
          </span>
        </div>
      )}

      {/* Search and action buttons */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className={`relative flex-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
          <Search className={`absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 ${
            isDark ? 'text-slate-500' : 'text-slate-400'
          }`} />
          <input
            type="text"
            placeholder="Search objects, constellations..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full pl-11 pr-4 py-2.5 rounded-full text-sm ring-1 ring-inset transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50 ${
              isDark
                ? 'bg-slate-900/70 ring-slate-700/60 placeholder-slate-600'
                : 'bg-white ring-slate-200 placeholder-slate-400'
            }`}
          />
        </div>

        {/* Import buttons — admin only. Triggering a sync moved to the
            telescope indicator's dropdown in the nav (one place for it,
            reachable from every page), so only file-based import actions
            live here now. */}
        {!isImporting && isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowImportModal(true)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium whitespace-nowrap ring-1 ring-inset transition-colors ${
                isDark
                  ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800'
                  : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              <Upload className="w-4 h-4" />
              Upload Files
            </button>
            <button
              onClick={() => setNewObservationOpen(true)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${
                isDark
                  ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 ring-1 ring-inset ring-accent-500/30'
                  : 'bg-accent-500 text-white hover:bg-accent-600'
              }`}
            >
              <PlusCircle className="w-4 h-4" />
              New Observation
            </button>
          </div>
        )}
      </div>

      {/* Object type filter bar */}
      {/*
        Two grid columns, not a flex row: a nested flex-wrap child's preferred
        (max-content) width is the width of ALL its chips laid out on one
        line, so in a plain flex row it out-competes the telescope block for
        space and both end up wrapping together. A grid column sized
        `minmax(0, 1fr)` is genuinely constrained to the space left after the
        `auto`-sized telescope column, so the chips wrap inside their own
        column while the telescope column stays put at the top.
      */}
      <div
        className={`${showTelescopeUI ? 'grid grid-cols-[minmax(0,1fr)_auto]' : 'flex'} items-start gap-3 ${
          isDark ? 'text-slate-400' : 'text-slate-500'
        }`}
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {/* Filter icon opens the customize menu (pick which chips show). */}
          <div ref={filterMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setFilterMenuOpen(o => !o)}
              aria-label="Customize filters"
              aria-haspopup="menu"
              aria-expanded={filterMenuOpen}
              title="Customize filters"
              className={`flex items-center justify-center w-8 h-8 rounded-full ring-1 ring-inset transition-colors ${
                filterMenuOpen
                  ? isDark ? 'bg-slate-800 ring-slate-600 text-slate-200' : 'bg-slate-100 ring-slate-300 text-slate-700'
                  : isDark
                    ? 'bg-slate-900/70 ring-slate-700/60 hover:bg-slate-800 hover:text-slate-300'
                    : 'bg-white ring-slate-200 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              <Filter className="w-4 h-4" />
            </button>
            {filterMenuOpen && (
              <FilterCustomizeMenu
                groups={objectFilters}
                typeFilters={typeFilters}
                enabledIds={enabledIds}
                onToggle={toggleChip}
                onClearAll={handleClearAllFilters}
                isDark={isDark}
              />
            )}
          </div>
          {/* Favorites filter — special case that checks isFavorite */}
          <button
            onClick={() => setActiveFilterId(effectiveFilterId === FAVORITES_FILTER_ID ? ALL_FILTER_ID : FAVORITES_FILTER_ID)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              effectiveFilterId === FAVORITES_FILTER_ID
                ? isDark
                  ? 'bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/30'
                  : 'bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-300'
                : isDark
                  ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <Star className={`w-3.5 h-3.5 ${effectiveFilterId === FAVORITES_FILTER_ID ? 'fill-current' : ''}`} />
            Favorites
          </button>
          <button
            onClick={() => setActiveFilterId(ALL_FILTER_ID)}
            className={`px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              effectiveFilterId === ALL_FILTER_ID
                ? isDark
                  ? 'bg-accent-500/15 text-accent-400 ring-1 ring-inset ring-accent-500/30'
                  : 'bg-accent-500 text-white'
                : isDark
                  ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            All
          </button>
          {chips.map(chip => (
            <button
              key={chip.id}
              onClick={() => setActiveFilterId(chip.id)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                effectiveFilterId === chip.id
                  ? isDark
                    ? 'bg-accent-500/15 text-accent-400 ring-1 ring-inset ring-accent-500/30'
                    : 'bg-accent-500 text-white'
                  : isDark
                    ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        {/* Telescope facet — only when more than one telescope is configured.
            A single dropdown trigger rather than one chip per scope, so
            adding telescopes doesn't keep growing this row; a sibling flex
            item (not part of the chip row above) so it stays anchored in its
            own corner regardless of how many rows the chips wrap to. */}
        {showTelescopeUI && (() => {
          const selectedTelescope = effectiveTelescopeFilter === ALL_TELESCOPES_FILTER
            ? null
            : telescopes.find(t => t.id === effectiveTelescopeFilter) ?? null;
          return (
            <div ref={telescopeMenuRef} className="relative shrink-0">
              <button
                onClick={() => setTelescopeMenuOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={telescopeMenuOpen}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ring-1 ring-inset transition-colors ${
                  selectedTelescope
                    ? isDark
                      ? 'bg-accent-500/15 text-accent-400 ring-accent-500/30'
                      : 'bg-accent-500 text-white ring-accent-500'
                    : isDark
                      ? 'bg-slate-900/70 ring-slate-700/60 text-slate-300 hover:bg-slate-800'
                      : 'bg-white ring-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                {selectedTelescope ? (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: selectedTelescope.color }}
                    aria-hidden="true"
                  />
                ) : (
                  <Telescope className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className="truncate max-w-[9rem]">
                  {selectedTelescope ? selectedTelescope.name : 'All scopes'}
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 shrink-0 transition-transform ${telescopeMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {telescopeMenuOpen && (
                <div className={`absolute right-0 top-full mt-1.5 z-20 w-56 rounded-2xl border shadow-lg overflow-hidden ${
                  isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
                }`}>
                  <button
                    onClick={() => { setTelescopeFilter(ALL_TELESCOPES_FILTER); setTelescopeMenuOpen(false); }}
                    className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-left transition-colors ${
                      effectiveTelescopeFilter === ALL_TELESCOPES_FILTER
                        ? isDark ? 'bg-slate-800 text-white' : 'bg-slate-50 text-slate-900'
                        : isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Telescope className="w-3.5 h-3.5 shrink-0" />
                      All scopes
                    </span>
                    {effectiveTelescopeFilter === ALL_TELESCOPES_FILTER && <Check className="w-3.5 h-3.5 shrink-0" />}
                  </button>
                  {telescopes.map(t => {
                    const selected = effectiveTelescopeFilter === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => { setTelescopeFilter(t.id); setTelescopeMenuOpen(false); }}
                        className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-left transition-colors ${
                          selected
                            ? isDark ? 'bg-slate-800 text-white' : 'bg-slate-50 text-slate-900'
                            : isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: t.color }}
                            aria-hidden="true"
                          />
                          <span className="truncate">{t.name}</span>
                        </span>
                        {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}
      </div>
      </TourAnchor>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={`rounded-2xl overflow-hidden border ${
                isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="h-48 img-placeholder" />
              <div className="p-5 space-y-3">
                <div className={`h-5 rounded w-3/4 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`} />
                <div className={`h-4 rounded w-1/2 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`} />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className={`text-center py-16 space-y-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <AlertCircle className="w-12 h-12 mx-auto text-accent-500/50" />
          <div>
            <p className={`text-lg font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              Unable to load library
            </p>
            <p className="mt-1 text-sm">
              {error instanceof Error ? error.message : "We couldn't reach your library. Check that the Nebulis server is running, then refresh to try again."}
            </p>
          </div>
        </div>
      ) : filtered && filtered.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {filtered.length} object{filtered.length !== 1 ? 's' : ''} in library
            </p>
            <div ref={sortRef} className="relative">
              <button
                onClick={() => setSortOpen(o => !o)}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium ring-1 ring-inset transition-colors ${
                  isDark
                    ? 'bg-slate-900/70 ring-slate-700/60 text-slate-300 hover:bg-slate-800'
                    : 'bg-white ring-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                {SORT_OPTIONS.find(o => o.value === sortKey)?.label}
              </button>
              {sortOpen && (
                <div className={`absolute right-0 top-full mt-1.5 z-20 w-52 rounded-2xl border shadow-lg overflow-hidden ${
                  isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
                }`}>
                  {SORT_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => applySort(opt.value)}
                      className={`w-full flex items-center justify-between px-4 py-2.5 text-sm text-left transition-colors ${
                        sortKey === opt.value
                          ? isDark
                            ? 'bg-slate-800 text-white'
                            : 'bg-slate-50 text-slate-900'
                          : isDark
                            ? 'text-slate-300 hover:bg-slate-800'
                            : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {opt.label}
                      {sortKey === opt.value && <Check className="w-3.5 h-3.5 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
            {filtered.map(obj => (
              <ObjectCard key={obj.id} object={obj} isDark={isDark} telescopes={telescopes} />
            ))}
          </div>
        </>
      ) : (
        <div className={`text-center py-20 space-y-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <div className={`inline-flex p-6 rounded-full ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
            <Telescope className="w-12 h-12 opacity-40" />
          </div>
          <div className="space-y-2">
            <p className={`text-xl font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {effectiveFilterId === FAVORITES_FILTER_ID
                ? 'No favorites yet'
                : search || effectiveFilterId !== ALL_FILTER_ID
                  ? 'No objects match your search'
                  : 'Your library is empty'}
            </p>
            {effectiveFilterId === FAVORITES_FILTER_ID && (
              <p className="text-sm max-w-sm mx-auto">
                Star an object from its detail page to add it to your favorites.
              </p>
            )}
            {!search && effectiveFilterId === ALL_FILTER_ID && (
              <p className="text-sm max-w-sm mx-auto">
                Import images from your SeeStar to build your local library. Configure your telescope connection in Settings first.
              </p>
            )}
          </div>
          {!search && effectiveFilterId === ALL_FILTER_ID && isAdmin && (
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => importMutation.mutate()}
                disabled={isImporting || importMutation.isPending}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-accent-500 text-white font-medium text-sm hover:bg-accent-600 transition disabled:opacity-50"
              >
                {isImporting ? <RotateCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {importsAllScopes ? `Import from all ${enabledTelescopes.length} telescopes` : 'Import from Telescope'}
              </button>
              <button
                onClick={() => setShowImportModal(true)}
                disabled={isImporting}
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-sm transition border disabled:opacity-50 ${
                  isDark
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Upload className="w-4 h-4" />
                Upload Observation
              </button>
              <a
                href="/settings"
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-sm transition border ${
                  isDark
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                Configure Settings
              </a>
            </div>
          )}
        </div>
      )}

      {/* Import modal — drop zone → review wizard */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onReview={(folderPath, includeSubframes, includeFits, telescopeId, archiveAll, tmpId) => {
            setShowImportModal(false);
            setWizardSubframes(includeSubframes);
            setWizardFits(includeFits);
            setWizardArchiveAll(archiveAll);
            setWizardTelescopeId(telescopeId);
            setWizardTmpId(tmpId);
            setWizardPath(folderPath);
          }}
        />
      )}

      <NewObservationModal
        isOpen={newObservationOpen}
        onClose={() => setNewObservationOpen(false)}
        onSuccess={result => {
          setNewObservationOpen(false);
          queryClient.invalidateQueries({ queryKey: ['library-objects'] });
          navigate(`/observations/${encodeURIComponent(result.objectId)}/${encodeURIComponent(result.date)}`);
        }}
      />

      {/* Guided folder-import wizard (scan → review sessions → commit) */}
      {wizardPath && (
        <FolderImportWizard
          rootPath={wizardPath}
          includeSubframes={wizardSubframes}
          includeFits={wizardFits}
          archiveAll={wizardArchiveAll}
          telescopeId={wizardTelescopeId}
          tmpId={wizardTmpId}
          onClose={() => { setWizardPath(null); setWizardTmpId(null); }}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['library-objects'] })}
        />
      )}


    </div>
  );
}
