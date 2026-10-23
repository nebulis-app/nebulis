import { useState, useMemo, useEffect, useRef, useDeferredValue } from 'react';
import { useQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Telescope, AlertCircle, Filter, Download, RotateCw, Upload, PlusCircle, Star, ChevronDown, LayoutGrid, LayoutDashboard, Grid3x3, SlidersHorizontal, X } from 'lucide-react';
import {
  getLibraryObjects, getLibraryObjectFilters, getLibraryCluster, triggerImport, getImportStatus,
  getLibraryFileThumbnailUrl, getLibraryObjectThumbnailUrl,
} from '../lib/api/library';
import { listTelescopes } from '../lib/api/telescopes';
import { ObjectCard } from '../components/ObjectCard';
import { MosaicWall, type MosaicTile } from '../components/mosaic/MosaicWall';
import { mosaicScore } from '../lib/mosaic/mosaicPacker';
import { PROCESSING_STATUS_ORDER, processingStatusLabel } from '../lib/processingStatus';
import type { ProcessingStatus } from '../types';
import { LibraryHero } from '../components/library/LibraryHero';
import { ImportModal } from '../components/ImportModal';
import { FolderImportWizard } from '../components/folderImport/FolderImportWizard';
import { LinkFolderWizard } from '../components/folderImport/LinkFolderWizard';
import { useTheme } from '../hooks/useTheme';
import { nightSafeColor } from '../lib/nightSafeColor';
import { useAuth } from '../contexts/AuthContext';
import { useClickOutside } from '../hooks/useClickOutside';
import { NewObservationModal } from '../components/NewObservationModal';
import { TourAnchor } from '../components/tour/TourAnchor';
import { FilterSection, Pill, TypeFilterSection, ActiveFilterChips, PopoverResetButton } from '../components/filters/toolbarParts';
import { TOOLBAR_BTN, POPOVER, popoverSurface } from '../components/filters/toolbarStyles';
import { buildTypeFilters, countGroupChips, matchesFilter, ALL_FILTER_ID, FAVORITES_FILTER_ID } from '../lib/objectTypeFilters';
import { isOptionValue } from '../lib/typeGuards';
import { isObjectFavoriteVars, type ObjectFavoriteVars } from '../lib/favoriteMutations';
import { compareDesignations, catalogFamilyOf, CATALOG_FAMILY_ORDER, type CatalogFamily } from '../lib/designationSort';

type SortKey = 'catalog-asc' | 'name-asc' | 'name-desc' | 'session-date-desc' | 'session-date-asc' | 'session-count-desc' | 'import-desc';

// labelKey rather than literal text: this array is built at module load,
// before any component's useTranslation() hook exists.
const SORT_OPTIONS: { value: SortKey; labelKey: string }[] = [
  { value: 'catalog-asc',        labelKey: 'gallery.sortOptions.catalogAsc' },
  { value: 'name-asc',           labelKey: 'gallery.sortOptions.nameAsc' },
  { value: 'name-desc',          labelKey: 'gallery.sortOptions.nameDesc' },
  { value: 'session-date-desc',  labelKey: 'gallery.sortOptions.latestObservation' },
  { value: 'session-date-asc',   labelKey: 'gallery.sortOptions.oldestObservation' },
  { value: 'session-count-desc', labelKey: 'gallery.sortOptions.mostSessions' },
  { value: 'import-desc',        labelKey: 'gallery.sortOptions.recentlyImported' },
];

type LayoutMode = 'grid' | 'mosaic';
const LAYOUT_STORAGE_KEY = 'nebulis-library-layout';
const MOSAIC_LABELS_STORAGE_KEY = 'nebulis-mosaic-labels';

function readStoredLayout(): LayoutMode {
  try { return localStorage.getItem(LAYOUT_STORAGE_KEY) === 'mosaic' ? 'mosaic' : 'grid'; } catch { return 'grid'; }
}

const NAME_COLLATION: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' };

const SORT_STORAGE_KEY = 'nebulis-library-sort';
const DEFAULT_SORT: SortKey = 'name-asc';

function readStoredSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v !== null && isOptionValue(SORT_OPTIONS, v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_SORT;
}

type GroupKey = 'none' | 'catalog' | 'type' | 'constellation';
const GROUP_OPTIONS: { value: GroupKey; labelKey: string }[] = [
  { value: 'none',          labelKey: 'gallery.groupOptions.none' },
  { value: 'catalog',       labelKey: 'gallery.groupOptions.catalog' },
  { value: 'type',          labelKey: 'gallery.groupOptions.type' },
  { value: 'constellation', labelKey: 'gallery.groupOptions.constellation' },
];
const GROUP_STORAGE_KEY = 'nebulis-library-group';
const DEFAULT_GROUP: GroupKey = 'none';
const COLLAPSED_STORAGE_KEY = 'nebulis-library-collapsed-groups';

function readStoredGroup(): GroupKey {
  try {
    const v = localStorage.getItem(GROUP_STORAGE_KEY);
    if (v !== null && isOptionValue(GROUP_OPTIONS, v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_GROUP;
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch { /* ignore */ }
  return new Set();
}

// Grid size slider: number of columns on screens >= sm. Phones stay at 2.
const COLUMNS_STORAGE_KEY = 'nebulis-library-columns';
const COLUMNS_MIN = 2;
const COLUMNS_MAX = 10;
const COLUMNS_DEFAULT = 4;
/** From this many columns the cards switch to their compact layout. */
const COMPACT_FROM_COLUMNS = 6;

function readStoredColumns(): number {
  try {
    const n = Number(localStorage.getItem(COLUMNS_STORAGE_KEY));
    if (Number.isInteger(n) && n >= COLUMNS_MIN && n <= COLUMNS_MAX) return n;
  } catch { /* ignore */ }
  return COLUMNS_DEFAULT;
}

const CATALOG_FAMILY_LABELS: Record<CatalogFamily, string> = {
  M: 'Messier', C: 'Caldwell', NGC: 'NGC', IC: 'IC', Sh2: 'Sharpless', Other: 'Other',
};

const ALL_TELESCOPES_FILTER = '__all__';
// 2 columns on phones; from sm up the slider's --lib-cols takes over.
const GRID_CLASS = 'grid grid-cols-2 sm:[grid-template-columns:repeat(var(--lib-cols),minmax(0,1fr))] gap-3 sm:gap-6';
const ALL_PROCESSING_FILTER = '__all__';

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
  const { t } = useTranslation('library');
  const { isDark, isNight, isSpace } = useTheme();
  // The hero is night-side in every theme (a picture of the sky), so it takes
  // the bright accent hex directly rather than the light-mode-darkened token,
  // matching the Observations, Planner and Catalog banners.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const [activeFilterId, setActiveFilterId] = useState<string>(ALL_FILTER_ID);
  const [telescopeFilter, setTelescopeFilter] = useState<string>(ALL_TELESCOPES_FILTER);
  const [processingFilter, setProcessingFilter] = useState<ProcessingStatus | typeof ALL_PROCESSING_FILTER>(ALL_PROCESSING_FILTER);
  const [showImportModal, setShowImportModal] = useState(false);
  const [linkTarget, setLinkTarget] = useState<{ path: string; subframes: boolean; fits: boolean } | null>(null);
  // Set when the user steps back out of the link review: the import dialog reopens on its options step with these.
  const [resumeLink, setResumeLink] = useState<{ path: string; includeSubframes: boolean } | null>(null);
  const [newObservationOpen, setNewObservationOpen] = useState(false);
  const [wizardPath, setWizardPath] = useState<string | null>(null);
  const [wizardSubframes, setWizardSubframes] = useState(false);
  const [wizardFits, setWizardFits] = useState(true);
  const [wizardArchiveAll, setWizardArchiveAll] = useState(false);
  const [wizardTelescopeId, setWizardTelescopeId] = useState<string | null>(null);
  const [wizardOpticalConfigId, setWizardOpticalConfigId] = useState<string | null>(null);
  const [wizardTmpId, setWizardTmpId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(readStoredSort);
  const [groupKey, setGroupKey] = useState<GroupKey>(readStoredGroup);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(readCollapsed);
  const [columns, setColumns] = useState<number>(readStoredColumns);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayout);
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
  const pendingFavorites = useMutationState<ObjectFavoriteVars | null>({
    filters: { mutationKey: ['toggle-object-favorite'], status: 'pending' },
    select: m => (isObjectFavoriteVars(m.state.variables) ? m.state.variables : null),
  });
  const objectsWithPendingFavorites = useMemo(() => {
    if (!objects) return objects;
    if (pendingFavorites.length === 0) return objects;
    const overlay = new Map<string, boolean>();
    for (const p of pendingFavorites) if (p) overlay.set(p.objectId, p.next);
    return objects.map(o => {
      const pending = overlay.get(o.id);
      return pending === undefined ? o : { ...o, isFavorite: pending };
    });
  }, [objects, pendingFavorites]);

  // Granular filters for every distinct object type in the library, with
  // counts. Excludes any type whose label already matches a curated group
  // (e.g. exact "Galaxy" vs the "Galaxy" group) to avoid two identically
  // labeled chips.
  const typeFilters = useMemo(
    () => buildTypeFilters((objectsWithPendingFavorites ?? []).map(o => o.type), objectFilters),
    [objectsWithPendingFavorites, objectFilters],
  );

  // Every curated group that actually has objects in the library, with counts,
  // so the Filters popover never offers a type that would show an empty grid.
  const chips = useMemo(() => {
    const objs = objectsWithPendingFavorites ?? [];
    const tagged = objs.filter(o => o.filterTags);
    // Objects without precomputed filterTags are matched on their raw type, the
    // same fallback matchesFilter uses, so counts agree with what filtering shows.
    const fromTags = new Map<string, number>();
    for (const o of tagged) for (const tag of o.filterTags ?? []) fromTags.set(tag, (fromTags.get(tag) ?? 0) + 1);
    const untyped = countGroupChips(objectFilters, objs.filter(o => !o.filterTags).map(o => o.type));
    const counts = new Map(fromTags);
    for (const g of untyped) counts.set(g.id, (counts.get(g.id) ?? 0) + g.count);
    return objectFilters
      .filter(f => f.id !== ALL_FILTER_ID && f.id !== FAVORITES_FILTER_ID && (counts.get(f.id) ?? 0) > 0)
      .map(f => ({ id: f.id, label: f.label, count: counts.get(f.id) ?? 0 }));
  }, [objectFilters, objectsWithPendingFavorites]);

  // If the active chip was removed via the customize menu (or no longer
  // corresponds to a visible chip, e.g. a type suppressed by the group-label
  // collision check above) fall back to All during render (deriving avoids a
  // corrective setState-in-effect).
  const effectiveFilterId =
    activeFilterId === ALL_FILTER_ID ||
    activeFilterId === FAVORITES_FILTER_ID ||
    chips.some(c => c.id === activeFilterId) ||
    typeFilters.some(tf => tf.id === activeFilterId)
      ? activeFilterId
      : ALL_FILTER_ID;

  useClickOutside(filtersRef, () => setFiltersOpen(false), { enabled: filtersOpen, closeOnEscape: true });
  useClickOutside(viewRef, () => setViewOpen(false), { enabled: viewOpen, closeOnEscape: true });
  useClickOutside(addRef, () => setAddOpen(false), { enabled: addOpen, closeOnEscape: true });

  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
  });
  const showTelescopeUI = telescopes.length >= 2;
  // If the selected scope was deleted, fall back to "All" during render rather
  // than via a corrective setState-in-effect (which flashed one frame of an
  // empty library). Same approach as effectiveFilterId above.
  const effectiveTelescopeFilter =
    telescopeFilter === ALL_TELESCOPES_FILTER || telescopes.some(scope => scope.id === telescopeFilter)
      ? telescopeFilter
      : ALL_TELESCOPES_FILTER;


  function applyGroup(key: GroupKey) {
    setGroupKey(key);
    try { localStorage.setItem(GROUP_STORAGE_KEY, key); } catch { /* ignore */ }
  }

  function toggleGroupCollapsed(id: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }

  function applyLayout(mode: LayoutMode) {
    setLayoutMode(mode);
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, mode); } catch { /* ignore */ }
  }

  function applyColumns(n: number) {
    setColumns(n);
    try { localStorage.setItem(COLUMNS_STORAGE_KEY, String(n)); } catch { /* ignore */ }
  }

  const viewIsCustom = groupKey !== DEFAULT_GROUP || sortKey !== DEFAULT_SORT || columns !== COLUMNS_DEFAULT;
  function resetView() {
    applyGroup(DEFAULT_GROUP);
    applySort(DEFAULT_SORT);
    applyColumns(COLUMNS_DEFAULT);
  }

  function applySort(key: SortKey) {
    setSortKey(key);
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
  const enabledTelescopes = telescopes.filter(scope => scope.autoImportEnabled);
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
    // The regex alternation is exactly the family names, so this always hits.
    const numberedFamily = numbered ? CATALOG_FAMILIES.find(f => f.name === numbered[1]) : undefined;
    const effectiveTerm = numbered && numberedFamily
      ? `${numberedFamily.prefix}${numbered[2]}`
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
        (obj.aliases ?? []).some(a => a.toLowerCase().startsWith(effectiveTerm)) ||
        (obj.nicknames ?? []).some(n => n.toLowerCase().includes(effectiveTerm));

      const matchesType = matchesFilter(
        effectiveFilterId,
        { objectType: obj.type, filterTags: obj.filterTags, isFavorite: obj.isFavorite },
        objectFilters,
      );

      const matchesTelescope =
        effectiveTelescopeFilter === ALL_TELESCOPES_FILTER ||
        (obj.telescopeIds?.includes(effectiveTelescopeFilter) ?? false);

      const matchesProcessing =
        processingFilter === ALL_PROCESSING_FILTER ||
        (obj.processingStatus ?? 'unprocessed') === processingFilter;

      return matchesSearch && matchesType && matchesTelescope && matchesProcessing;
    });

    if (!list) return list;

    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'catalog-asc':
          return compareDesignations(a.catalogId, b.catalogId) || a.name.localeCompare(b.name);
        case 'name-asc':
          return a.name.localeCompare(b.name, undefined, NAME_COLLATION);
        case 'name-desc':
          return b.name.localeCompare(a.name, undefined, NAME_COLLATION);
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
  }, [objectsWithPendingFavorites, deferredSearch, effectiveFilterId, effectiveTelescopeFilter, processingFilter, objectFilters, sortKey]);

  // Sections for Group-by. Applied after filter + sort, so each section keeps
  // the active sort order. Every object lands in exactly one section (M31 is
  // "Messier" only, never also under NGC 224).
  const groups = useMemo(() => {
    if (!filtered || groupKey === 'none') return null;
    const sections = new Map<string, { id: string; label: string; order: number; items: typeof filtered }>();
    const put = (id: string, label: string, order: number, obj: (typeof filtered)[number]) => {
      const sec = sections.get(id);
      if (sec) sec.items.push(obj);
      else sections.set(id, { id, label, order, items: [obj] });
    };
    const typeGroups = objectFilters.filter(f => f.id !== ALL_FILTER_ID && f.id !== FAVORITES_FILTER_ID);
    for (const obj of filtered) {
      if (groupKey === 'catalog') {
        const fam = catalogFamilyOf(obj.catalogId);
        put(`catalog:${fam}`, CATALOG_FAMILY_LABELS[fam], CATALOG_FAMILY_ORDER.indexOf(fam), obj);
      } else if (groupKey === 'type') {
        const idx = typeGroups.findIndex(g => obj.filterTags?.includes(g.id));
        if (idx >= 0) put(`type:${typeGroups[idx].id}`, typeGroups[idx].label, idx, obj);
        else put('type:other', 'Other', Number.MAX_SAFE_INTEGER, obj);
      } else {
        const c = obj.constellation?.trim();
        put(`constellation:${c || 'unknown'}`, c || 'Unknown', c ? 0 : 1, obj);
      }
    }
    return [...sections.values()].sort((a, b) =>
      a.order - b.order || a.label.localeCompare(b.label));
  }, [filtered, groupKey, objectFilters]);

  // The Mosaic sizes each object by how much has been done with it. Only fetched once the layout is chosen; if the
  // totals cannot be loaded the wall still shows, sized by the number of nights.
  const mosaicOn = layoutMode === 'mosaic';
  const { data: clusterStats, isError: clusterFailed } = useQuery({
    queryKey: ['library-cluster'],
    queryFn: getLibraryCluster,
    enabled: mosaicOn,
    staleTime: 60_000,
  });

  const mosaicTiles = useMemo<MosaicTile[]>(() => {
    if (!mosaicOn || !filtered) return [];
    const byObject = new Map((clusterStats ?? []).map(c => [c.objectId, c]));
    const tiles: MosaicTile[] = [];
    for (const obj of filtered) {
      let processed = 0;
      let stacks = 0;
      let subs = 0;
      let best: { path: string; kind: string } | null = null;
      for (const id of [obj.id, ...(obj.variants ?? []).map(v => v.objectId)]) {
        const c = byObject.get(id);
        if (!c) continue;
        processed += c.processedCount;
        stacks += c.stackedCount;
        subs += c.subCount;
        if (c.image && (!best || (c.image.kind === 'processed' && best.kind !== 'processed'))) best = c.image;
      }
      // An older server, or a failed fetch: nights stand in for stacks so sizes still vary.
      if (clusterFailed && stacks === 0) stacks = obj.sessionCount ?? 0;
      const parts: string[] = [];
      if (processed > 0) parts.push(t('mosaic.processed', { count: processed }));
      if (stacks > 0) parts.push(t('mosaic.stacks', { count: stacks }));
      if (subs > 0) parts.push(t('mosaic.subs', { count: subs }));
      const title = obj.name || obj.catalogId || obj.id;
      const subtitle = obj.catalogId && obj.catalogId.toLowerCase() !== title.toLowerCase() ? obj.catalogId : undefined;
      const picture = best?.path;
      // With the totals loaded, an object that has no picture of its own would be a blank hole on the wall.
      if (!picture && !clusterFailed && clusterStats) continue;
      tiles.push({
        id: obj.id,
        title,
        subtitle,
        detail: parts.length > 0 ? parts.join(' · ') : t('mosaic.nothing'),
        score: mosaicScore(processed, stacks, subs),
        href: `/object/${encodeURIComponent(obj.id)}`,
        // Their own best picture; an object with none falls back to its card thumbnail so no tile is blank.
        imageUrl: (px: number) => picture
          ? getLibraryFileThumbnailUrl(picture, px, px)
          : getLibraryObjectThumbnailUrl(obj.id, px, px, obj.galleryImageVersion),
      });
    }
    return tiles;
  }, [mosaicOn, filtered, clusterStats, clusterFailed, t]);
  const mosaicHidden = mosaicOn && filtered ? filtered.length - mosaicTiles.length : 0;

  const compact = columns >= COMPACT_FROM_COLUMNS;
  // Custom properties aren't in CSSProperties; the intersection names this one.
  const gridStyle: React.CSSProperties & { '--lib-cols': number } = { '--lib-cols': columns };

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
      : telescopes.find(scope => scope.id === effectiveTelescopeFilter)?.name ?? null;

  const isImporting = importStatus?.running ?? false;

  // Favorites is its own toggle in the toolbar, so it isn't counted here.
  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  const activeTypeChip = chips.find(c => c.id === effectiveFilterId) ?? typeFilters.find(tf => tf.id === effectiveFilterId);
  if (activeTypeChip) activeChips.push({ key: 'type', label: activeTypeChip.label, clear: () => setActiveFilterId(ALL_FILTER_ID) });
  if (effectiveTelescopeFilter !== ALL_TELESCOPES_FILTER) {
    const scope = telescopes.find(sc => sc.id === effectiveTelescopeFilter);
    if (scope) activeChips.push({ key: 'scope', label: scope.name, clear: () => setTelescopeFilter(ALL_TELESCOPES_FILTER) });
  }
  if (processingFilter !== ALL_PROCESSING_FILTER) {
    activeChips.push({ key: 'status', label: processingStatusLabel(processingFilter, t), clear: () => setProcessingFilter(ALL_PROCESSING_FILTER) });
  }
  const activeFilterCount = activeChips.length;
  function clearAllActive() {
    setActiveFilterId(ALL_FILTER_ID);
    setTelescopeFilter(ALL_TELESCOPES_FILTER);
    setProcessingFilter(ALL_PROCESSING_FILTER);
  }

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
              ? (importMutation.error instanceof Error ? importMutation.error.message : t('gallery.importStartFailed'))
              : importStatus?.error}
          </span>
        </div>
      )}

      {/* One toolbar row: search, Filters, Favorites, View, Add. Everything
          that narrows the list lives in the Filters popover; everything that
          only changes how the list is laid out lives in View. Active filters
          surface as removable chips underneath, and only while they exist. */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className={`relative flex-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
          <Search className={`absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 ${
            isDark ? 'text-slate-500' : 'text-slate-400'
          }`} />
          <input
            type="text"
            placeholder={t('gallery.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full pl-11 pr-4 py-2.5 rounded-full text-sm ring-1 ring-inset transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50 ${
              isDark
                ? 'bg-slate-900/70 ring-slate-700/60 placeholder-slate-600'
                : 'bg-white ring-slate-200 placeholder-slate-400'
            }`}
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Filters */}
          <div ref={filtersRef} className="relative">
            <button
              type="button"
              onClick={() => setFiltersOpen(o => !o)}
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
              className={`${TOOLBAR_BTN} ${
                activeFilterCount > 0
                  ? isDark ? 'bg-accent-500/15 text-accent-400 ring-accent-500/30' : 'bg-accent-500 text-white ring-accent-500'
                  : isDark ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              <Filter className="w-4 h-4" />
              {t('gallery.filters')}
              {activeFilterCount > 0 && (
                <span className={`min-w-[1.25rem] px-1 rounded-full text-xs text-center ${isDark ? 'bg-accent-500/25' : 'bg-white/25'}`}>
                  {activeFilterCount}
                </span>
              )}
            </button>
            {filtersOpen && (
              <div className={`${POPOVER} w-[22rem] max-w-[calc(100vw-2rem)] max-h-[75vh] overflow-y-auto p-4 space-y-4 ${popoverSurface(isDark)}`}>
                <PopoverResetButton isDark={isDark} label={t('gallery.reset')} disabled={activeFilterCount === 0 && effectiveFilterId !== FAVORITES_FILTER_ID} onReset={clearAllActive} />
                <TypeFilterSection
                  isDark={isDark}
                  activeId={effectiveFilterId}
                  allId={ALL_FILTER_ID}
                  groups={chips}
                  types={typeFilters}
                  onSelect={setActiveFilterId}
                  labels={{
                    title: t('gallery.filterType'),
                    all: t('gallery.all'),
                    more: count => t('gallery.moreTypes', { count }),
                    fewer: t('gallery.fewerTypes'),
                  }}
                />
                {showTelescopeUI && (
                  <FilterSection title={t('gallery.filterScope')} isDark={isDark}>
                    <Pill active={effectiveTelescopeFilter === ALL_TELESCOPES_FILTER} isDark={isDark} onClick={() => setTelescopeFilter(ALL_TELESCOPES_FILTER)}>
                      {t('gallery.allScopes')}
                    </Pill>
                    {telescopes.map(scope => (
                      <Pill key={scope.id} active={effectiveTelescopeFilter === scope.id} isDark={isDark} onClick={() => setTelescopeFilter(scope.id)}>
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: nightSafeColor(scope.color, isNight) }}
                          aria-hidden="true"
                        />
                        {scope.name}
                      </Pill>
                    ))}
                  </FilterSection>
                )}
                <FilterSection title={t('gallery.filterStatus')} isDark={isDark}>
                  <Pill active={processingFilter === ALL_PROCESSING_FILTER} isDark={isDark} onClick={() => setProcessingFilter(ALL_PROCESSING_FILTER)}>
                    {t('gallery.allStatuses')}
                  </Pill>
                  {PROCESSING_STATUS_ORDER.map(s => (
                    <Pill key={s} active={processingFilter === s} isDark={isDark} onClick={() => setProcessingFilter(s)}>
                      {processingStatusLabel(s, t)}
                    </Pill>
                  ))}
                </FilterSection>
              </div>
            )}
          </div>

          {/* Favorites: a single star toggle instead of a two-chip Favorites/All pair. */}
          <button
            type="button"
            onClick={() => setActiveFilterId(effectiveFilterId === FAVORITES_FILTER_ID ? ALL_FILTER_ID : FAVORITES_FILTER_ID)}
            aria-pressed={effectiveFilterId === FAVORITES_FILTER_ID}
            aria-label={t('gallery.favorites')}
            title={t('gallery.favorites')}
            className={`flex items-center justify-center w-10 h-10 rounded-full ring-1 ring-inset transition-colors ${
              effectiveFilterId === FAVORITES_FILTER_ID
                ? isDark ? 'bg-amber-500/15 text-amber-400 ring-amber-500/30' : 'bg-amber-100 text-amber-700 ring-amber-300'
                : isDark ? 'bg-slate-900/70 text-slate-400 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-100'
            }`}
          >
            <Star className={`w-4 h-4 ${effectiveFilterId === FAVORITES_FILTER_ID ? 'fill-current' : ''}`} />
          </button>

          {/* Grid or Mosaic: the same objects, laid out as cards or as one wall of pictures. */}
          <div role="group" aria-label={t('mosaic.layout')} className={`flex items-center p-0.5 rounded-full ring-1 ring-inset ${
            isDark ? 'bg-slate-900/70 ring-slate-700/60' : 'bg-white ring-slate-200'
          }`}>
            {([
              { mode: 'grid' as const, icon: LayoutGrid, label: t('mosaic.grid') },
              { mode: 'mosaic' as const, icon: LayoutDashboard, label: t('mosaic.mosaic') },
            ]).map(opt => (
              <button
                key={opt.mode}
                type="button"
                onClick={() => applyLayout(opt.mode)}
                aria-pressed={layoutMode === opt.mode}
                aria-label={opt.label}
                title={opt.label}
                className={`flex items-center justify-center w-9 h-9 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50 ${
                  layoutMode === opt.mode
                    ? isDark ? 'bg-accent-500/20 text-accent-400' : 'bg-accent-500 text-white'
                    : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <opt.icon className="w-4 h-4" />
              </button>
            ))}
          </div>

          {/* View: layout only (grouping, sort, grid size). */}
          <div ref={viewRef} className="relative">
            <button
              type="button"
              onClick={() => setViewOpen(o => !o)}
              aria-haspopup="dialog"
              aria-expanded={viewOpen}
              className={`${TOOLBAR_BTN} ${
                isDark ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              <SlidersHorizontal className="w-4 h-4" />
              {t('gallery.view')}
              {groupKey !== DEFAULT_GROUP && <span className="w-1.5 h-1.5 rounded-full bg-accent-400" aria-hidden="true" />}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${viewOpen ? 'rotate-180' : ''}`} />
            </button>
            {viewOpen && (
              <div className={`${POPOVER} w-[22rem] max-w-[calc(100vw-2rem)] p-4 space-y-4 ${popoverSurface(isDark)}`}>
                <PopoverResetButton isDark={isDark} label={t('gallery.reset')} disabled={!viewIsCustom} onReset={resetView} />
                <FilterSection title={t('gallery.groupBy')} isDark={isDark}>
                  {GROUP_OPTIONS.map(opt => (
                    <Pill key={opt.value} active={groupKey === opt.value} isDark={isDark} onClick={() => applyGroup(opt.value)}>
                      {t(opt.labelKey)}
                    </Pill>
                  ))}
                </FilterSection>
                <FilterSection title={t('gallery.sortBy')} isDark={isDark}>
                  {SORT_OPTIONS.map(opt => (
                    <Pill key={opt.value} active={sortKey === opt.value} isDark={isDark} onClick={() => applySort(opt.value)}>
                      {t(opt.labelKey)}
                    </Pill>
                  ))}
                </FilterSection>
                <div className="hidden sm:block">
                  <FilterSection title={t('gallery.gridSize')} isDark={isDark}>
                    <div className="flex items-center gap-2 w-full">
                      <Grid3x3 className={`w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                      <input
                        type="range"
                        min={COLUMNS_MIN}
                        max={COLUMNS_MAX}
                        step={1}
                        value={COLUMNS_MIN + COLUMNS_MAX - columns}
                        onChange={e => applyColumns(COLUMNS_MIN + COLUMNS_MAX - Number(e.target.value))}
                        aria-label={t('gallery.gridSize')}
                        className="flex-1 accent-amber-400 cursor-pointer"
                      />
                      <LayoutGrid className={`w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                    </div>
                  </FilterSection>
                </div>
              </div>
            )}
          </div>

          {/* Add: file-based import actions, admin only. Triggering a sync
              lives in the telescope indicator's dropdown in the nav. */}
          {!isImporting && isAdmin && (
            <div ref={addRef} className="relative">
              <button
                type="button"
                onClick={() => setAddOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={addOpen}
                className={`${TOOLBAR_BTN} font-semibold ${
                  isDark
                    ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 ring-accent-500/30'
                    : 'bg-accent-500 text-white hover:bg-accent-600 ring-accent-500'
                }`}
              >
                <PlusCircle className="w-4 h-4" />
                {t('gallery.add')}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${addOpen ? 'rotate-180' : ''}`} />
              </button>
              {addOpen && (
                <div role="menu" className={`${POPOVER} w-56 overflow-hidden ${popoverSurface(isDark)}`}>
                  {[
                    { icon: PlusCircle, label: t('gallery.newObservation'), onClick: () => setNewObservationOpen(true) },
                    { icon: Upload, label: t('gallery.uploadFiles'), onClick: () => setShowImportModal(true) },
                  ].map(item => (
                    <button
                      key={item.label}
                      role="menuitem"
                      type="button"
                      onClick={() => { setAddOpen(false); item.onClick(); }}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors ${
                        isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <item.icon className="w-4 h-4 shrink-0" />
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ActiveFilterChips
        chips={activeChips}
        isDark={isDark}
        removeLabel={name => t('gallery.removeFilter', { name })}
        clearAllLabel={t('gallery.clearFilters')}
        onClearAll={clearAllActive}
      />
      </TourAnchor>

      {/* Content */}
      {isLoading ? (
        <div className={GRID_CLASS} style={gridStyle}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={`rounded-2xl overflow-hidden border ${
                isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="h-28 sm:h-48 img-placeholder" />
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
              {t('gallery.unableToLoad')}
            </p>
            <p className="mt-1 text-sm">
              {error instanceof Error ? error.message : t('gallery.loadErrorFallback')}
            </p>
          </div>
        </div>
      ) : filtered && filtered.length > 0 ? (
        <>
          <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('gallery.objectCount', { count: filtered.length })}
          </p>
          {mosaicOn ? (
            <div className="space-y-2">
              {clusterFailed && (
                <p className="text-xs text-slate-500">{t('mosaic.estimated')}</p>
              )}
              <MosaicWall
                tiles={mosaicTiles}
                onOpen={id => navigate(`/object/${encodeURIComponent(id)}`)}
                labelsStorageKey={MOSAIC_LABELS_STORAGE_KEY}
                ariaLabel={t('mosaic.objectsLabel')}
                shareFileBase="nebulis-library"
              />
              <p className="text-xs text-slate-500">
                {t('mosaic.hint')}
                {mosaicHidden > 0 && ` ${t('mosaic.hiddenNoPicture', { count: mosaicHidden })}`}
              </p>
            </div>
          ) : groups ? (
            <div className="space-y-6">
              {groups.map(g => {
                const collapsed = collapsedGroups.has(g.id);
                return (
                  <section key={g.id}>
                    <button
                      onClick={() => toggleGroupCollapsed(g.id)}
                      aria-expanded={!collapsed}
                      className={`sticky top-0 z-10 w-full flex items-center gap-2 py-2 px-1 text-left backdrop-blur ${
                        isDark ? 'bg-slate-950/85 text-slate-200' : 'bg-slate-50/90 text-slate-700'
                      }`}
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                      <span className="font-display font-semibold">{g.label}</span>
                      <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{g.items.length}</span>
                    </button>
                    {!collapsed && (
                      <div className={`${GRID_CLASS} mt-2`} style={gridStyle}>
                        {g.items.map(obj => (
                          <ObjectCard key={obj.id} object={obj} isDark={isDark} telescopes={telescopes} compact={compact} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className={GRID_CLASS} style={gridStyle}>
              {filtered.map(obj => (
                <ObjectCard key={obj.id} object={obj} isDark={isDark} telescopes={telescopes} compact={compact} />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className={`text-center py-20 space-y-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <div className={`inline-flex p-6 rounded-full ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
            <Telescope className="w-12 h-12 opacity-40" />
          </div>
          <div className="space-y-2">
            <p className={`text-xl font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {effectiveFilterId === FAVORITES_FILTER_ID
                ? t('gallery.noFavoritesYet')
                : search || effectiveFilterId !== ALL_FILTER_ID || processingFilter !== ALL_PROCESSING_FILTER
                  ? t('gallery.noSearchMatches')
                  : t('gallery.libraryEmpty')}
            </p>
            {effectiveFilterId === FAVORITES_FILTER_ID && (
              <p className="text-sm max-w-sm mx-auto">
                {t('gallery.noFavoritesHint')}
              </p>
            )}
            {(search || effectiveFilterId !== ALL_FILTER_ID || effectiveTelescopeFilter !== ALL_TELESCOPES_FILTER || processingFilter !== ALL_PROCESSING_FILTER) && (
              <button
                type="button"
                onClick={() => { setSearch(''); clearAllActive(); setActiveFilterId(ALL_FILTER_ID); }}
                className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium ring-1 ring-inset transition-colors ${
                  isDark ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
                }`}
              >
                <X className="w-4 h-4" />
                {t('gallery.clearFilters')}
              </button>
            )}
            {!search && effectiveFilterId === ALL_FILTER_ID && processingFilter === ALL_PROCESSING_FILTER && (
              <p className="text-sm max-w-sm mx-auto">
                {t('gallery.libraryEmptyHint')}
              </p>
            )}
          </div>
          {!search && effectiveFilterId === ALL_FILTER_ID && processingFilter === ALL_PROCESSING_FILTER && isAdmin && (
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => importMutation.mutate()}
                disabled={isImporting || importMutation.isPending}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-accent-500 text-white font-medium text-sm hover:bg-accent-600 transition disabled:opacity-50"
              >
                {isImporting ? <RotateCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {importsAllScopes ? t('gallery.importFromAllTelescopes', { count: enabledTelescopes.length }) : t('gallery.importFromTelescope')}
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
                {t('gallery.uploadObservation')}
              </button>
              <a
                href="/settings"
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-sm transition border ${
                  isDark
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {t('gallery.configureSettings')}
              </a>
            </div>
          )}
        </div>
      )}

      {/* Import modal — drop zone → review wizard */}
      {showImportModal && (
        <ImportModal
          resume={resumeLink ?? undefined}
          onClose={() => { setShowImportModal(false); setResumeLink(null); }}
          onReview={(folderPath, includeSubframes, includeFits, telescopeId, archiveAll, tmpId, opticalConfigId) => {
            setShowImportModal(false);
            setWizardSubframes(includeSubframes);
            setWizardFits(includeFits);
            setWizardArchiveAll(archiveAll);
            setWizardTelescopeId(telescopeId);
            setWizardOpticalConfigId(opticalConfigId);
            setWizardTmpId(tmpId);
            setWizardPath(folderPath);
          }}
          onLink={(folderPath, includeSubframes, includeFits) => {
            setShowImportModal(false);
            setResumeLink(null);
            setLinkTarget({ path: folderPath, subframes: includeSubframes, fits: includeFits });
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

      {/* Link a folder in place: nothing is copied into the library */}
      {linkTarget && (
        <LinkFolderWizard
          rootPath={linkTarget.path}
          includeSubframes={linkTarget.subframes}
          includeFits={linkTarget.fits}
          onClose={() => setLinkTarget(null)}
          onBack={() => {
            setResumeLink({ path: linkTarget.path, includeSubframes: linkTarget.subframes });
            setLinkTarget(null);
            setShowImportModal(true);
          }}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['library-objects'] })}
        />
      )}

      {/* Guided folder-import wizard (scan → review sessions → commit) */}
      {wizardPath && (
        <FolderImportWizard
          rootPath={wizardPath}
          includeSubframes={wizardSubframes}
          includeFits={wizardFits}
          archiveAll={wizardArchiveAll}
          telescopeId={wizardTelescopeId}
          opticalConfigId={wizardOpticalConfigId}
          tmpId={wizardTmpId}
          onClose={() => { setWizardPath(null); setWizardTmpId(null); }}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['library-objects'] })}
        />
      )}


    </div>
  );
}
