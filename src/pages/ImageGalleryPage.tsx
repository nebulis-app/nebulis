import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import {
  Star, Images, AlertCircle, Search, Filter, ArrowUpDown, Check, Sparkles,
} from 'lucide-react';
import { getAllLibraryImages, toggleImageFavorite, getLibraryObjectFilters, type LibraryImage } from '../lib/api/library';
import { getSettings } from '../lib/api/settings';
import { normalizeSearch } from '../lib/dsoSearch';
import { useTheme } from '../hooks/useTheme';
import { PlanetariumMode } from '../components/gallery/PlanetariumMode';
import { ImageGalleryHero } from '../components/gallery/ImageGalleryHero';
import { ImageViewer } from '../components/gallery/ImageViewer';
import { ImageCard } from '../components/gallery/ImageCard';
import { useClickOutside } from '../hooks/useClickOutside';
import { useFilterChipPrefs } from '../hooks/useFilterChipPrefs';
import { FilterCustomizeMenu } from '../components/filters/FilterCustomizeMenu';
import { TourAnchor } from '../components/tour/TourAnchor';
import { buildTypeFilters, matchesFilter, defaultEnabledIds, filterLabel, ALL_FILTER_ID, FAVORITES_FILTER_ID } from '../lib/objectTypeFilters';
import { isOptionValue } from '../lib/typeGuards';

type SortKey = 'name-asc' | 'name-desc' | 'date-desc' | 'date-asc';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name-asc',  label: 'Name (A–Z)' },
  { value: 'name-desc', label: 'Name (Z–A)' },
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc',  label: 'Oldest first' },
];

const SORT_STORAGE_KEY = 'nebulis-gallery-sort';

function readStoredSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v !== null && isOptionValue(SORT_OPTIONS, v)) return v;
  } catch { /* ignore */ }
  return 'name-asc';
}

export function ImageGalleryPage() {
  const { isDark, isNight, isSpace } = useTheme();
  // The hero is night-side in every theme (a picture of the sky), so it takes
  // the bright accent hex directly rather than the light-mode-darkened token,
  // matching the Observations, Planner and Catalog banners.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const queryClient = useQueryClient();

  const [activeFilterId, setActiveFilterId] = useState<string>(ALL_FILTER_ID);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>(readStoredSort);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
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
  const defaultIds = useMemo(() => defaultEnabledIds(objectFilters), [objectFilters]);
  const { enabledIds, toggle: toggleChip, clearAll: clearAllChips } = useFilterChipPrefs(defaultIds);

  // Clearing unpins every chip AND resets the active selection (Favorites
  // isn't gated by enabledIds, so it needs an explicit reset too).
  function handleClearAllFilters() {
    clearAllChips();
    setActiveFilterId(ALL_FILTER_ID);
  }

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
  const pendingFavorites = useMutationState<{ imagePath: string; isFavorite: boolean }>({
    filters: { mutationKey: ['toggle-image-favorite'], status: 'pending' },
    select: m => m.state.variables as { imagePath: string; isFavorite: boolean },
  });
  const images = useMemo(() => {
    if (!serverImages) return serverImages;
    if (pendingFavorites.length === 0) return serverImages;
    const overlay = new Map(pendingFavorites.map(p => [p.imagePath, p.isFavorite]));
    return serverImages.map(img =>
      overlay.has(img.path) ? { ...img, isFavorite: overlay.get(img.path)! } : img
    );
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
            placeholder="Search by object name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full pl-10 pr-4 py-2.5 rounded-full text-sm ring-1 ring-inset transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50 ${
              isDark ? 'bg-slate-900/70 ring-slate-700/60 placeholder-slate-600'
                     : 'bg-white ring-slate-200 placeholder-slate-400'
            }`}
          />
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
            {SORT_OPTIONS.find(o => o.value === sortKey)?.label}
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
                  {opt.label}
                  {sortKey === opt.value && <Check className="w-3.5 h-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={`flex items-center gap-2 flex-wrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
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
        {/* Independent of the type/Favorites radio group above: a checkbox, not
            a chip in that set, since "processed" is a different axis (kind of
            image) than object type. */}
        <button
          onClick={() => setProcessedOnlyOverride(!processedOnly)}
          aria-pressed={processedOnly}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
            processedOnly
              ? isDark
                ? 'bg-accent-500/15 text-accent-400 ring-1 ring-inset ring-accent-500/30'
                : 'bg-accent-500 text-white'
              : isDark
                ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Processed only
        </button>
        <button
          onClick={() => setActiveFilterId(ALL_FILTER_ID)}
          className={`px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
            effectiveFilterId === ALL_FILTER_ID
              ? isDark ? 'bg-accent-500/15 text-accent-400 ring-1 ring-inset ring-accent-500/30'
                       : 'bg-accent-500 text-white'
              : isDark ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
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
                ? isDark ? 'bg-accent-500/15 text-accent-400 ring-1 ring-inset ring-accent-500/30'
                         : 'bg-accent-500 text-white'
                : isDark ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                         : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {!isLoading && !error && images && (
        <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {filtered.length} image{filtered.length !== 1 ? 's' : ''}
          {effectiveFilterId === FAVORITES_FILTER_ID
            ? ' favorited'
            : effectiveFilterId !== ALL_FILTER_ID
              ? ` · ${filterLabel(effectiveFilterId, objectFilters, typeFilters)}`
              : ' in library'}
          {processedOnly ? ' · Processed only' : ''}
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
          <p className={`text-lg font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Unable to load images</p>
          <p className="mt-1 text-sm">{error instanceof Error ? error.message : "We couldn't load your images right now. Refresh to retry, or check that the Nebulis server is running."}</p>
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
              {effectiveFilterId === FAVORITES_FILTER_ID ? 'No favorited images yet'
                : processedOnly ? 'No processed images yet'
                : search || effectiveFilterId !== ALL_FILTER_ID ? 'No images match your filters'
                : 'No images in library'}
            </p>
            <p className="text-sm max-w-sm mx-auto">
              {effectiveFilterId === FAVORITES_FILTER_ID ? 'Star an image to add it to your favorites.'
                : processedOnly ? 'Upload a processed image from an observation page to see it here.'
                : 'Import images from your SeeStar telescope to see them here.'}
            </p>
          </div>
        </div>
      )}
      </TourAnchor>

      {viewerIndex !== null && filtered.length > 0 && (
        <ImageViewer
          images={filtered} initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onToggleFavorite={handleToggleFavorite}
        />
      )}
    </div>
  );
}
