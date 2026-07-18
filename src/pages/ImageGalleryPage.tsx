import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import {
  Star, Images, AlertCircle, Search, Clapperboard, Filter, ArrowUpDown, Check,
} from 'lucide-react';
import { getAllLibraryImages, toggleImageFavorite, getLibraryObjectFilters, type LibraryImage } from '../lib/api/library';
import { getSettings } from '../lib/api/settings';
import { normalizeSearch } from '../lib/dsoSearch';
import { useTheme } from '../hooks/useTheme';
import { PlanetariumMode } from '../components/gallery/PlanetariumMode';
import { ImageViewer } from '../components/gallery/ImageViewer';
import { ImageCard } from '../components/gallery/ImageCard';
import { useClickOutside } from '../hooks/useClickOutside';
import { useFilterChipPrefs } from '../hooks/useFilterChipPrefs';
import { FilterCustomizeMenu } from '../components/filters/FilterCustomizeMenu';
import { buildTypeFilters, matchesFilter, defaultEnabledIds, filterLabel, ALL_FILTER_ID, FAVORITES_FILTER_ID } from '../lib/objectTypeFilters';

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
    if (v && SORT_OPTIONS.some(o => o.value === v)) return v as SortKey;
  } catch { /* ignore */ }
  return 'name-asc';
}

export function ImageGalleryPage() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
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

  const filtered = useMemo(() => {
    if (!images) return [];
    const q = normalizeSearch(search);
    const list = images.filter(img => {
      if (!matchesFilter(effectiveFilterId, { objectType: img.objectType, isFavorite: img.isFavorite }, objectFilters)) {
        return false;
      }
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
          return a.objectName.localeCompare(b.objectName) || a.name.localeCompare(b.name);
        case 'name-desc':
          return b.objectName.localeCompare(a.objectName) || b.name.localeCompare(a.name);
        case 'date-desc':
          return (b.date ?? '').localeCompare(a.date ?? '');
        case 'date-asc':
          return (a.date ?? '').localeCompare(b.date ?? '');
        default:
          return 0;
      }
    });
  }, [images, effectiveFilterId, objectFilters, search, sortKey]);

  function handleToggleFavorite(img: LibraryImage) {
    favMutation.mutate({ imagePath: img.path, isFavorite: !img.isFavorite });
  }

  // Capture a stable snapshot at launch time so Planetarium never re-pools
  // from parent re-renders caused by optimistic updates.
  function launchPlanetarium() {
    if (!images || images.length === 0) return;
    setPlanetariumImages([...images]);
  }

  useEffect(() => {
    if (!sortOpen) return;
    function handleClick(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
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
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className={`font-display text-3xl font-bold tracking-tight flex items-center gap-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
            <Images className={`w-7 h-7 ${accentText}`} />
            Image Gallery
          </h1>
          <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            All telescope images from your library
          </p>
        </div>

        {images && images.length > 0 && (
          <button
            onClick={() => launchPlanetarium()}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all border ${
              isDark ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border-accent-500/30'
                     : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border-accent-400'
            }`}
          >
            <Clapperboard className="w-4 h-4" />
            Planetarium
          </button>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className={`relative flex-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
          <Search className={`absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          <input
            type="text"
            placeholder="Search by object name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full pl-10 pr-4 py-2.5 rounded-xl border text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
              isDark ? 'bg-slate-900 border-slate-800 placeholder-slate-600 focus:border-accent-500/50'
                     : 'bg-white border-slate-200 placeholder-slate-400 focus:border-accent-400'
            }`}
          />
        </div>

        <div ref={sortRef} className="relative shrink-0">
          <button
            onClick={() => setSortOpen(o => !o)}
            className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all border ${
              isDark
                ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border-slate-700'
                : 'bg-white text-slate-600 hover:bg-slate-50 border-slate-200 shadow-sm'
            }`}
          >
            <ArrowUpDown className="w-4 h-4" />
            {SORT_OPTIONS.find(o => o.value === sortKey)?.label}
          </button>
          {sortOpen && (
            <div className={`absolute right-0 top-full mt-1.5 z-20 w-44 rounded-xl border shadow-lg overflow-hidden ${
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
            className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all border ${
              filterMenuOpen
                ? isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-slate-100 border-slate-300 text-slate-700'
                : isDark ? 'border-transparent hover:bg-slate-800' : 'border-transparent hover:bg-slate-100'
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
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
            effectiveFilterId === FAVORITES_FILTER_ID
              ? isDark
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'bg-amber-100 text-amber-700 border border-amber-300'
              : isDark
                ? 'hover:bg-slate-800 border border-transparent'
                : 'hover:bg-slate-100 border border-transparent'
          }`}
        >
          <Star className={`w-3.5 h-3.5 ${effectiveFilterId === FAVORITES_FILTER_ID ? 'fill-current' : ''}`} />
          Favorites
        </button>
        <button
          onClick={() => setActiveFilterId(ALL_FILTER_ID)}
          className={`px-3.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
            effectiveFilterId === ALL_FILTER_ID
              ? isDark ? 'bg-accent-500/15 text-accent-400 border border-accent-500/30'
                       : 'bg-accent-300 text-accent-700 border border-accent-400'
              : isDark ? 'hover:bg-slate-800 border border-transparent'
                       : 'hover:bg-slate-100 border border-transparent'
          }`}
        >
          All
        </button>
        {chips.map(chip => (
          <button
            key={chip.id}
            onClick={() => setActiveFilterId(chip.id)}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              effectiveFilterId === chip.id
                ? isDark ? 'bg-accent-500/15 text-accent-400 border border-accent-500/30'
                         : 'bg-accent-300 text-accent-700 border border-accent-400'
                : isDark ? 'hover:bg-slate-800 border border-transparent'
                         : 'hover:bg-slate-100 border border-transparent'
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
        </p>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i} className={`rounded-xl overflow-hidden border aspect-square ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
              <div className={`w-full h-full img-placeholder ${isDark ? '' : 'bg-gradient-to-br from-slate-100 to-slate-200'}`} />
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
          {filtered.map((img, idx) => (
            <ImageCard
              key={img.path} image={img} isDark={isDark}
              onOpen={() => setViewerIndex(idx)}
              onToggleFavorite={handleToggleFavorite}
            />
          ))}
        </div>
      ) : (
        <div className={`text-center py-20 space-y-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <div className={`inline-flex p-6 rounded-full ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
            {effectiveFilterId === FAVORITES_FILTER_ID ? <Star className="w-12 h-12 opacity-40" /> : <Images className="w-12 h-12 opacity-40" />}
          </div>
          <div className="space-y-2">
            <p className={`text-xl font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {effectiveFilterId === FAVORITES_FILTER_ID ? 'No favorited images yet'
                : search || effectiveFilterId !== ALL_FILTER_ID ? 'No images match your filters'
                : 'No images in library'}
            </p>
            <p className="text-sm max-w-sm mx-auto">
              {effectiveFilterId === FAVORITES_FILTER_ID ? 'Star an image to add it to your favorites.'
                : 'Import images from your SeeStar telescope to see them here.'}
            </p>
          </div>
        </div>
      )}

      {viewerIndex !== null && filtered.length > 0 && (
        <ImageViewer
          images={filtered} initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onToggleFavorite={handleToggleFavorite}
          isDark={isDark}
        />
      )}
    </div>
  );
}
