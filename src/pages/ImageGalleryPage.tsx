import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { isImageFavoriteVars, type ImageFavoriteVars } from '../lib/favoriteMutations';
import { useAuth } from '../contexts/AuthContext';
import {
  Star, Images, AlertCircle, Search, Filter, ArrowUpDown, Check, Sparkles, X, LayoutGrid, LayoutDashboard,
} from 'lucide-react';
import {
  getAllLibraryImages, toggleImageFavorite, getLibraryObjectFilters, type LibraryImage,
} from '../lib/api/library';
import { getSettings } from '../lib/api/settings';
import { normalizeSearch } from '../lib/dsoSearch';
import { useTheme } from '../hooks/useTheme';
import { PlanetariumMode } from '../components/gallery/PlanetariumMode';
import { ImageGalleryHero } from '../components/gallery/ImageGalleryHero';
import { ImageViewer } from '../components/gallery/ImageViewer';
import { ObjectImageEditor } from '../components/objectDetail/ObjectImageEditor';
import type { ObjectEditRequest } from '../components/objectDetail/objectEditRequest';
import { ImageCard } from '../components/gallery/ImageCard';
import { MosaicWall, type MosaicTile } from '../components/mosaic/MosaicWall';
import { useClickOutside } from '../hooks/useClickOutside';
import { FilterSection, Pill, TypeFilterSection, ActiveFilterChips, PopoverResetButton } from '../components/filters/toolbarParts';
import { TOOLBAR_BTN, POPOVER, popoverSurface } from '../components/filters/toolbarStyles';
import { TourAnchor } from '../components/tour/TourAnchor';
import { buildTypeFilters, countGroupChips, matchesFilter, filterLabel, ALL_FILTER_ID, FAVORITES_FILTER_ID } from '../lib/objectTypeFilters';
import { isOptionValue } from '../lib/typeGuards';

type SortKey = 'name-asc' | 'name-desc' | 'date-desc' | 'date-asc';

const SORT_OPTIONS: { value: SortKey; labelKey: string }[] = [
  { value: 'name-asc',  labelKey: 'galleryPage.sortNameAsc' },
  { value: 'name-desc', labelKey: 'galleryPage.sortNameDesc' },
  { value: 'date-desc', labelKey: 'galleryPage.sortDateDesc' },
  { value: 'date-asc',  labelKey: 'galleryPage.sortDateAsc' },
];

const SORT_STORAGE_KEY = 'nebulis-gallery-sort';
const LAYOUT_STORAGE_KEY = 'nebulis-gallery-layout';
const MOSAIC_LABELS_STORAGE_KEY = 'nebulis-mosaic-labels';
/** The wall shows this many pictures at most, favorites and processed ones first. */
const MOSAIC_LIMIT = 600;

type LayoutMode = 'grid' | 'mosaic';

function readStoredLayout(): LayoutMode {
  try { return localStorage.getItem(LAYOUT_STORAGE_KEY) === 'mosaic' ? 'mosaic' : 'grid'; } catch { return 'grid'; }
}

function readStoredSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v !== null && isOptionValue(SORT_OPTIONS, v)) return v;
  } catch { /* ignore */ }
  return 'name-asc';
}

export function ImageGalleryPage() {
  const { t } = useTranslation('library');
  const { isDark, isNight, isSpace } = useTheme();
  const { isAdmin } = useAuth();
  // The hero is night-side in every theme (a picture of the sky), so it takes
  // the bright accent hex directly rather than the light-mode-darkened token,
  // matching the Observations, Planner and Catalog banners.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const queryClient = useQueryClient();

  const [activeFilterId, setActiveFilterId] = useState<string>(ALL_FILTER_ID);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>(readStoredSort);
  const [sortOpen, setSortOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayout);
  const sortRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [editRequest, setEditRequest] = useState<ObjectEditRequest | null>(null);
  const [planetariumImages, setPlanetariumImages] = useState<LibraryImage[] | null>(null);

  const { data: serverImages, isLoading, error } = useQuery({
    queryKey: ['all-library-images'],
    queryFn: getAllLibraryImages,
    staleTime: 5 * 60 * 1000,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  // Independent of activeFilterId: "kind" (processed vs raw) is orthogonal to
  // object type and to Favorites, so it layers on top of whichever of those is
  // selected rather than replacing it — a user can ask for processed Galaxies,
  // or processed Favorites, not just one or the other.
  //
  // Starts from the settings default once that query resolves; a click on the
  // toggle overrides it for the rest of the visit. Derived rather than seeded
  // via a setState-in-effect once settings arrives — same reasoning as
  // effectiveFilterId below.
  const [processedOnlyOverride, setProcessedOnlyOverride] = useState<boolean | null>(null);
  const processedOnly = processedOnlyOverride ?? settings?.galleryProcessedOnlyDefault ?? false;

  const { data: objectFilters = [] } = useQuery({
    queryKey: ['library-object-filters'],
    queryFn: getLibraryObjectFilters,
  });

  // Granular filters for every distinct object type across the images, with
  // counts. Excludes any type whose label already matches a curated group
  // (e.g. exact "Galaxy" vs the "Galaxy" group) to avoid two identically
  // labeled chips.
  const typeFilters = useMemo(
    () => buildTypeFilters((serverImages ?? []).map(i => i.objectType), objectFilters),
    [serverImages, objectFilters],
  );
  // Curated groups that actually cover some image, with counts, so the Filters
  // popover never offers a type that would show an empty grid.
  const chips = useMemo(
    () => countGroupChips(objectFilters, (serverImages ?? []).map(i => i.objectType)),
    [serverImages, objectFilters],
  );

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

  const favMutation = useMutation({
    mutationKey: ['toggle-image-favorite'],
    mutationFn: ({ imagePath, isFavorite }: { imagePath: string; isFavorite: boolean }) =>
      toggleImageFavorite(imagePath, isFavorite),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
      queryClient.invalidateQueries({ queryKey: ['image-favorites'] });
    },
  });

  // Unifying Lens: derive the displayed favorite state by overlaying any
  // in-flight favorite mutations on top of the server cache. No setQueryData,
  // no rollback — when the mutation settles, the overlay disappears naturally.
  const pendingFavorites = useMutationState<ImageFavoriteVars | null>({
    filters: { mutationKey: ['toggle-image-favorite'], status: 'pending' },
    select: m => (isImageFavoriteVars(m.state.variables) ? m.state.variables : null),
  });
  const images = useMemo(() => {
    if (!serverImages) return serverImages;
    if (pendingFavorites.length === 0) return serverImages;
    const overlay = new Map<string, boolean>();
    for (const p of pendingFavorites) if (p) overlay.set(p.imagePath, p.isFavorite);
    return serverImages.map(img => {
      const pending = overlay.get(img.path);
      return pending === undefined ? img : { ...img, isFavorite: pending };
    });
  }, [serverImages, pendingFavorites]);

  // Filter/sort against a deferred copy of the search string so typing stays at
  // 60fps while a 1k-10k image grid reconciles behind it.
  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(() => {
    if (!images) return [];
    const q = normalizeSearch(deferredSearch);
    const list = images.filter(img => {
      if (!matchesFilter(effectiveFilterId, { objectType: img.objectType, isFavorite: img.isFavorite }, objectFilters)) {
        return false;
      }
      if (processedOnly && !img.isProcessed) return false;
      if (q) {
        // Match the catalog designation (objectId, e.g. "M33", "NGC598") as
        // well as the common name and filename, all normalized so "M33",
        // "M 33" and "NGC0598" resolve the same way.
        const fields = [img.objectName, img.name, img.objectId];
        if (!fields.some(f => normalizeSearch(f).includes(q))) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'name-asc':
          return (a.objectName ?? '').localeCompare(b.objectName ?? '') || (a.name ?? '').localeCompare(b.name ?? '');
        case 'name-desc':
          return (b.objectName ?? '').localeCompare(a.objectName ?? '') || (b.name ?? '').localeCompare(a.name ?? '');
        case 'date-desc':
          return (b.date ?? '').localeCompare(a.date ?? '');
        case 'date-asc':
          return (a.date ?? '').localeCompare(b.date ?? '');
        default: {
          // Every SORT_OPTIONS entry must define an order here. Unreachable at
          // runtime (readStoredSort narrows), so it keeps the neutral compare.
          const _exhaustive: never = sortKey;
          void _exhaustive;
          return 0;
        }
      }
    });
  }, [images, effectiveFilterId, objectFilters, processedOnly, deferredSearch, sortKey]);

  // Depend on favMutation.mutate, not favMutation itself: useMutation returns a
  // fresh object every render (`{ ...result, mutate, mutateAsync }`), so
  // `[favMutation]` makes this callback unstable every render and defeats
  // ImageCard's memo on an unpaginated grid that can hold thousands of images.
  // `mutate` is a useCallback keyed on the observer, so it IS stable.
  const favMutate = favMutation.mutate;
  const handleToggleFavorite = useCallback((img: LibraryImage) => {
    favMutate({ imagePath: img.path, isFavorite: !img.isFavorite });
  }, [favMutate]);

  const handleOpenImage = useCallback((img: LibraryImage) => {
    const idx = filtered.findIndex(f => f.path === img.path);
    if (idx >= 0) setViewerIndex(idx);
  }, [filtered]);

  // Capture a stable snapshot at launch time so Planetarium never re-pools
  // from parent re-renders caused by optimistic updates.
  function launchPlanetarium() {
    if (!images || images.length === 0) return;
    setPlanetariumImages([...images]);
  }

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

  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  if (effectiveFilterId !== ALL_FILTER_ID && effectiveFilterId !== FAVORITES_FILTER_ID) {
    activeChips.push({ key: 'type', label: filterLabel(effectiveFilterId, objectFilters, typeFilters), clear: () => setActiveFilterId(ALL_FILTER_ID) });
  }
  if (processedOnly) {
    activeChips.push({ key: 'processed', label: t('galleryPage.processedOnly'), clear: () => setProcessedOnlyOverride(false) });
  }
  const activeFilterCount = activeChips.length;
  function clearAllActive() {
    setActiveFilterId(ALL_FILTER_ID);
    setProcessedOnlyOverride(false);
  }

  // Back to defaults: the Settings default decides Processed only, so drop the override.
  function resetFilters() {
    setActiveFilterId(ALL_FILTER_ID);
    setProcessedOnlyOverride(null);
  }

  function applyLayout(mode: LayoutMode) {
    setLayoutMode(mode);
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, mode); } catch { /* ignore */ }
  }

  // Mosaic: favorites and processed pictures first, then newest; a tile's size follows that order. The sort menu
  // does not apply here, since position on the wall is not a list order.
  const mosaicOn = layoutMode === 'mosaic';
  const mosaicImages = useMemo(() => {
    if (!mosaicOn) return [];
    const rank = (i: LibraryImage) => (i.isFavorite ? 2 : 0) + (i.isProcessed ? 1 : 0);
    return filtered
      .map((img, idx) => ({ img, idx }))
      .sort((a, b) => rank(b.img) - rank(a.img) || (b.img.date ?? '').localeCompare(a.img.date ?? '') || a.idx - b.idx)
      .slice(0, MOSAIC_LIMIT)
      .map(e => e.img);
  }, [mosaicOn, filtered]);
  const mosaicTiles = useMemo<MosaicTile[]>(() => mosaicImages.map((img, i) => ({
    id: img.path,
    title: img.objectName || img.objectId,
    subtitle: img.date || undefined,
    score: mosaicImages.length - i,
    href: img.downloadUrl,
    // The server's own tiers: thumbUrl is safe for any file type, previewUrl is the 2048 px one for a close look.
    imageUrl: (px: number) => (px > 500 ? img.previewUrl : img.thumbUrl),
  })), [mosaicImages]);
  const openMosaicTile = useCallback((path: string) => {
    const img = filtered.find(f => f.path === path);
    if (img) handleOpenImage(img);
  }, [filtered, handleOpenImage]);

  function applySort(key: SortKey) {
    setSortKey(key);
    setSortOpen(false);
    try { localStorage.setItem(SORT_STORAGE_KEY, key); } catch { /* ignore */ }
  }

  if (planetariumImages) {
    return (
      <PlanetariumMode
        initialImages={planetariumImages}
        favoritesOnly={false}
        processedOnly={settings?.planetariumProcessedOnlyDefault ?? false}
        showInfo={settings?.planetariumShowInfo ?? true}
        rotateCCW={settings?.slideshowRotateCCW ?? false}
        onExit={() => setPlanetariumImages(null)}
        onToggleFavorite={img =>
          favMutation.mutate({ imagePath: img.path, isFavorite: img.isFavorite })
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <TourAnchor id="gallery" className="block space-y-6">
      <ImageGalleryHero
        images={images ?? []}
        accent={accent}
        onLaunchPlanetarium={launchPlanetarium}
        canLaunchPlanetarium={!!images && images.length > 0}
      />
      <div className="flex flex-col sm:flex-row gap-3">
        <div className={`relative flex-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
          <Search className={`absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          <input
            type="text"
            placeholder={t('galleryPage.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full pl-10 pr-4 py-2.5 rounded-full text-sm ring-1 ring-inset transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50 ${
              isDark ? 'bg-slate-900/70 ring-slate-700/60 placeholder-slate-600'
                     : 'bg-white ring-slate-200 placeholder-slate-400'
            }`}
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
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
              {t('galleryPage.filters')}
              {activeFilterCount > 0 && (
                <span className={`min-w-[1.25rem] px-1 rounded-full text-xs text-center ${isDark ? 'bg-accent-500/25' : 'bg-white/25'}`}>
                  {activeFilterCount}
                </span>
              )}
            </button>
            {filtersOpen && (
              <div className={`${POPOVER} w-[22rem] max-w-[calc(100vw-2rem)] max-h-[75vh] overflow-y-auto p-4 space-y-4 ${popoverSurface(isDark)}`}>
                <PopoverResetButton isDark={isDark} label={t('galleryPage.reset')} disabled={activeFilterCount === 0 && effectiveFilterId !== FAVORITES_FILTER_ID && processedOnlyOverride === null} onReset={resetFilters} />
                <TypeFilterSection
                  isDark={isDark}
                  activeId={effectiveFilterId}
                  allId={ALL_FILTER_ID}
                  groups={chips}
                  types={typeFilters}
                  onSelect={setActiveFilterId}
                  labels={{
                    title: t('galleryPage.filterType'),
                    all: t('galleryPage.all'),
                    more: count => t('galleryPage.moreTypes', { count }),
                    fewer: t('galleryPage.fewerTypes'),
                  }}
                />
                {/* "Processed" is a different axis (kind of image) than object
                    type, so it stacks with the type choice and Favorites. */}
                <FilterSection title={t('galleryPage.filterShow')} isDark={isDark}>
                  <Pill active={processedOnly} isDark={isDark} onClick={() => setProcessedOnlyOverride(!processedOnly)}>
                    <Sparkles className="w-3.5 h-3.5" />
                    {t('galleryPage.processedOnly')}
                  </Pill>
                </FilterSection>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setActiveFilterId(effectiveFilterId === FAVORITES_FILTER_ID ? ALL_FILTER_ID : FAVORITES_FILTER_ID)}
            aria-pressed={effectiveFilterId === FAVORITES_FILTER_ID}
            aria-label={t('galleryPage.favorites')}
            title={t('galleryPage.favorites')}
            className={`flex items-center justify-center w-10 h-10 rounded-full ring-1 ring-inset transition-colors ${
              effectiveFilterId === FAVORITES_FILTER_ID
                ? isDark ? 'bg-amber-500/15 text-amber-400 ring-amber-500/30' : 'bg-amber-100 text-amber-700 ring-amber-300'
                : isDark ? 'bg-slate-900/70 text-slate-400 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-100'
            }`}
          >
            <Star className={`w-4 h-4 ${effectiveFilterId === FAVORITES_FILTER_ID ? 'fill-current' : ''}`} />
          </button>

          <div role="group" aria-label={t('mosaic.layout')} className={`flex items-center p-0.5 rounded-full ring-1 ring-inset shrink-0 ${
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

          <div ref={sortRef} className="relative shrink-0">
            <button
              onClick={() => setSortOpen(o => !o)}
              className={`flex items-center gap-1.5 px-4 py-2.5 rounded-full text-sm font-medium whitespace-nowrap ring-1 ring-inset transition-colors ${
                isDark
                  ? 'bg-slate-900/70 text-slate-300 ring-slate-700/60 hover:bg-slate-800'
                  : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              <ArrowUpDown className="w-4 h-4" />
              {(() => {
                const opt = SORT_OPTIONS.find(o => o.value === sortKey);
                return opt ? t(opt.labelKey) : null;
              })()}
            </button>
            {sortOpen && (
              <div className={`absolute right-0 top-full mt-1.5 z-20 w-44 rounded-2xl border shadow-lg overflow-hidden ${
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
                    {t(opt.labelKey)}
                    {sortKey === opt.value && <Check className="w-3.5 h-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ActiveFilterChips
        chips={activeChips}
        isDark={isDark}
        removeLabel={name => t('galleryPage.removeFilter', { name })}
        clearAllLabel={t('galleryPage.clearFilters')}
        onClearAll={clearAllActive}
      />

      {!isLoading && !error && images && (
        <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {t('galleryPage.count', { count: filtered.length })}
          {effectiveFilterId === FAVORITES_FILTER_ID
            ? t('galleryPage.favoritedSuffix')
            : effectiveFilterId !== ALL_FILTER_ID
              ? ` · ${filterLabel(effectiveFilterId, objectFilters, typeFilters)}`
              : t('galleryPage.inLibrarySuffix')}
          {processedOnly ? t('galleryPage.processedOnlySuffix') : ''}
        </p>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i} className={`rounded-xl overflow-hidden border aspect-square ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
              <div className="w-full h-full img-placeholder" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className={`text-center py-16 space-y-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <AlertCircle className="w-12 h-12 mx-auto text-accent-500/50" />
          <p className={`text-lg font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t('galleryPage.unableToLoad')}</p>
          <p className="mt-1 text-sm">{error instanceof Error ? error.message : t('galleryPage.loadErrorFallback')}</p>
        </div>
      ) : filtered.length > 0 && mosaicOn ? (
        <div className="space-y-2">
          <MosaicWall
            tiles={mosaicTiles}
            onOpen={openMosaicTile}
            labelsStorageKey={MOSAIC_LABELS_STORAGE_KEY}
            ariaLabel={t('mosaic.picturesLabel')}
            shareFileBase="nebulis-gallery"
          />
          <p className="text-xs text-slate-500">
            {mosaicImages.length < filtered.length
              ? t('mosaic.showing', { shown: mosaicImages.length, total: filtered.length })
              : t('mosaic.hint')}
          </p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {filtered.map((img) => (
            <ImageCard
              key={img.path} image={img} isDark={isDark}
              onOpen={handleOpenImage}
              onToggleFavorite={handleToggleFavorite}
            />
          ))}
        </div>
      ) : (
        <div className={`text-center py-20 space-y-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <div className={`inline-flex p-6 rounded-full ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
            {effectiveFilterId === FAVORITES_FILTER_ID ? <Star className="w-12 h-12 opacity-40" />
              : processedOnly ? <Sparkles className="w-12 h-12 opacity-40" />
              : <Images className="w-12 h-12 opacity-40" />}
          </div>
          <div className="space-y-2">
            <p className={`text-xl font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {effectiveFilterId === FAVORITES_FILTER_ID ? t('galleryPage.noFavoritedYet')
                : processedOnly ? t('galleryPage.noProcessedYet')
                : search || effectiveFilterId !== ALL_FILTER_ID ? t('galleryPage.noMatchFilters')
                : t('galleryPage.noImagesInLibrary')}
            </p>
            {(search || effectiveFilterId !== ALL_FILTER_ID || processedOnly) && (
              <button
                type="button"
                onClick={() => { setSearch(''); clearAllActive(); }}
                className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium ring-1 ring-inset transition-colors ${
                  isDark ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
                }`}
              >
                <X className="w-4 h-4" />
                {t('galleryPage.clearFilters')}
              </button>
            )}
            <p className="text-sm max-w-sm mx-auto">
              {effectiveFilterId === FAVORITES_FILTER_ID ? t('galleryPage.starToFavorite')
                : processedOnly ? t('galleryPage.uploadProcessedHint')
                : t('galleryPage.importFromTelescopeHint')}
            </p>
          </div>
        </div>
      )}
      </TourAnchor>

      {viewerIndex !== null && filtered.length > 0 && (
        <ImageViewer
          images={filtered} initialIndex={viewerIndex}
          isAdmin={isAdmin}
          onClose={() => setViewerIndex(null)}
          onToggleFavorite={handleToggleFavorite}
          onEditImage={img => {
            // A processed picture has no id here, so it is saved as a new version; a raw JPEG can be replaced in its night.
            const hasNight = img.date !== 'unknown';
            setEditRequest({
              url: img.downloadUrl,
              name: img.name,
              sourceKind: img.isProcessed ? 'processed' : 'telescope',
              overwriteTarget: !img.isProcessed && hasNight && /\.jpe?g$/i.test(img.name)
                ? { kind: 'telescope', path: img.path }
                : undefined,
              objectId: img.objectId,
              date: hasNight ? img.date : null,
            });
          }}
        />
      )}

      <ObjectImageEditor
        request={editRequest}
        onClose={() => setEditRequest(null)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['all-library-images'] });
          setViewerIndex(null);
        }}
      />
    </div>
  );
}
