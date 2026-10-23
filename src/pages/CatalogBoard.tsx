/**
 * Progress board for a named observing catalog (Messier, Caldwell, Herschel 400).
 * Route: /catalogs/:catalog
 *
 * The hub presents each program as a tall poster; a board opens with the same
 * imagery turned into a banner, then hands the page over to the grid. Progress
 * and the type breakdown live in the banner, so the only thing that stays
 * pinned while scrolling is a slim bar of controls.
 */
import { useCallback, useState, useMemo, useDeferredValue } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SearchX, Telescope } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../hooks/useTheme';
import { getCatalogProgress, type CatalogProgressObject, type ObjectClass } from '../lib/api/catalogs';
import { getSettings } from '../lib/api/settings';
import { getCatalogMeta } from '../lib/catalogMeta';
import { useResolvedFov } from '../hooks/useResolvedFov';
import { useWishlist } from '../hooks/useWishlist';
import { classifyFit, objectExtentArcmin, type FitAssessment } from '../lib/telescopeFov';
import { compareBy } from '../lib/catalogSort';
import { CatalogHero } from '../components/catalogs/CatalogHero';
import { CatalogToolbar, type SortKey, type StatusFilter } from '../components/catalogs/CatalogToolbar';
import { CatalogTile } from '../components/catalogs/CatalogTile';
import { CatalogObjectModal } from '../components/catalogs/CatalogObjectModal';
import { CatalogPlanModal } from '../components/catalogs/CatalogPlanModal';

function matchesSearch(obj: CatalogProgressObject, needle: string): boolean {
  return (
    obj.id.toLowerCase().includes(needle) ||
    obj.name.toLowerCase().includes(needle) ||
    obj.type.toLowerCase().includes(needle) ||
    (obj.ngcName?.toLowerCase().includes(needle) ?? false) ||
    (obj.constellation?.toLowerCase().includes(needle) ?? false)
  );
}

export function CatalogBoard() {
  const { t } = useTranslation('catalogs');
  const { catalog = 'messier' } = useParams<{ catalog: string }>();
  const { isDark, isNight, isSpace } = useTheme();

  const [filter, setFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<ObjectClass | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('catalog');
  // Tracked by catalog id rather than grid index: an index would go stale
  // the moment a filter/sort/search change reshuffles the array underneath
  // an open modal, either pointing at the wrong object or needing an effect
  // to reset it. Looking the id up in the current array handles both the
  // "still visible" and "filtered away" cases with no extra state.
  // `?object=` deep-links straight to an object's modal (the My Catalog wall's "Plan it").
  const [searchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('object'));
  const [planOpen, setPlanOpen] = useState(false);

  const progressQuery = useQuery({
    queryKey: ['catalog-progress', catalog],
    queryFn: () => getCatalogProgress(catalog),
    staleTime: 60_000,
  });

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: 5 * 60_000,
  });

  const progress = progressQuery.data;
  const settings = settingsQuery.data;
  const observerLat = settings?.latitude ?? null;
  const observerLon = settings?.longitude ?? null;
  const minAlt = settings?.minAlt ?? 20;
  const meta = getCatalogMeta(catalog);

  // The banner sits on dark sky imagery in every theme, and only a fixed set
  // of accent-* utilities is re-mapped for night and space, so both it and the
  // tiles take the bright accent value directly.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  // The FOV currently in effect (Settings → Telescopes, or the Framing
  // modal's saved pick) — used to badge every tile with "does this fit my
  // frame" and to drive the "Best frame fit" sort.
  const fov = useResolvedFov();
  const fitById = useMemo(() => {
    const map = new Map<string, FitAssessment | null>();
    for (const o of progress?.objects ?? []) {
      map.set(o.id, classifyFit(fov, objectExtentArcmin(null, o.majorAxisArcmin)));
    }
    return map;
  }, [progress, fov]);

  const wishlist = useWishlist();
  const objectsById = useMemo(() => {
    const map = new Map<string, CatalogProgressObject>();
    for (const o of progress?.objects ?? []) map.set(o.id, o);
    return map;
  }, [progress]);
  const handleToggleWishlist = useCallback((id: string) => {
    const obj = objectsById.get(id);
    if (!obj) return;
    wishlist.toggle({
      objectId: obj.id,
      name: obj.name,
      type: obj.type,
      constellation: obj.constellation,
      magnitude: obj.magnitude,
      majorAxisArcmin: obj.majorAxisArcmin,
    });
  }, [objectsById, wishlist]);

  // Deferred so a keystroke doesn't block on re-filtering a full catalog
  // (Herschel 400, Sharpless 313, etc).
  const deferredSearch = useDeferredValue(search);
  const filteredObjects = useMemo(() => {
    if (!progress) return [];
    const needle = deferredSearch.trim().toLowerCase();
    const result = progress.objects.filter((o) => {
      if (filter === 'imaged' && !o.isImaged) return false;
      if (filter === 'remaining' && o.isImaged) return false;
      if (typeFilter && o.typeClass !== typeFilter) return false;
      if (needle && !matchesSearch(o, needle)) return false;
      return true;
    });
    // 'catalog' keeps the server's ordering, which is already catalog order.
    return sort === 'catalog' ? result : [...result].sort(compareBy(sort, fitById));
  }, [progress, filter, typeFilter, deferredSearch, sort, fitById]);

  const statusCounts = useMemo(() => {
    // Counts on the status pills reflect the type and search filters, so the
    // numbers always add up to what switching to that pill would show.
    const objects = progress?.objects ?? [];
    const needle = deferredSearch.trim().toLowerCase();
    const scoped = objects.filter(o =>
      (!typeFilter || o.typeClass === typeFilter) && (!needle || matchesSearch(o, needle))
    );
    const imaged = scoped.filter(o => o.isImaged).length;
    return { all: scoped.length, imaged, remaining: scoped.length - imaged };
  }, [progress, typeFilter, deferredSearch]);

  const selectedIndex = selectedId ? filteredObjects.findIndex(o => o.id === selectedId) : -1;
  // A filter/sort/search change that scrolls the selected object out of the
  // visible set closes the modal, since -1 is not a valid position to show
  // prev/next controls for.
  const selected = selectedIndex >= 0 ? filteredObjects[selectedIndex] : null;

  if (progressQuery.isLoading) {
    return <BoardSkeleton isDark={isDark} />;
  }

  if (progressQuery.isError || !progress) {
    return (
      <div className="p-8 text-center">
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {t('catalogBoard.loadFailed')}
        </p>
      </div>
    );
  }

  const canPlan =
    observerLat != null && observerLon != null && progress.objects.some(o => !o.isImaged);

  return (
    <div className="flex flex-col min-h-0 -mb-8">
      <CatalogHero
        meta={meta}
        label={progress.label}
        total={progress.total}
        imagedCount={progress.imagedCount}
        imagedInFrameCount={progress.imagedInFrameCount}
        byType={progress.byType}
        accent={accent}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        onPlan={canPlan ? () => setPlanOpen(true) : null}
        catalogId={catalog}
      />

      <div className="mt-6">
        <CatalogToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={statusCounts}
          search={search}
          onSearchChange={setSearch}
          sort={sort}
          onSortChange={setSort}
          shownCount={filteredObjects.length}
          isDark={isDark}
        />
      </div>

      <div className="pt-6 pb-8">
        {filteredObjects.length === 0 ? (
          <EmptyState
            isDark={isDark}
            searching={search.trim().length > 0}
            filter={filter}
            onReset={() => { setSearch(''); setFilter('all'); setTypeFilter(null); }}
          />
        ) : (
          <div
            className="grid gap-3 sm:gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
          >
            {filteredObjects.map((obj) => (
              <CatalogTile
                key={obj.id}
                object={obj}
                isDark={isDark}
                accent={accent}
                fit={fitById.get(obj.id) ?? null}
                inWishlist={wishlist.idSet.has(obj.id)}
                onSelect={setSelectedId}
                onToggleWishlist={handleToggleWishlist}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selected && (
        <CatalogObjectModal
          object={selected}
          fit={fitById.get(selected.id) ?? null}
          inWishlist={wishlist.idSet.has(selected.id)}
          onToggleWishlist={() => handleToggleWishlist(selected.id)}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex < filteredObjects.length - 1}
          onPrev={() => setSelectedId(filteredObjects[Math.max(0, selectedIndex - 1)].id)}
          onNext={() => setSelectedId(filteredObjects[Math.min(filteredObjects.length - 1, selectedIndex + 1)].id)}
          observerLat={observerLat}
          observerLon={observerLon}
          minAlt={minAlt}
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          onClose={() => setSelectedId(null)}
        />
      )}

      {planOpen && observerLat != null && observerLon != null && (
        <CatalogPlanModal
          catalogLabel={progress.label}
          objects={progress.objects}
          observerLat={observerLat}
          observerLon={observerLon}
          minAlt={minAlt}
          observerTimezone={settings?.timezone || undefined}
          isDark={isDark}
          onClose={() => setPlanOpen(false)}
        />
      )}
    </div>
  );
}

function EmptyState({
  isDark, searching, filter, onReset,
}: {
  isDark: boolean;
  searching: boolean;
  filter: StatusFilter;
  onReset: () => void;
}) {
  const { t } = useTranslation('catalogs');
  const Icon = searching ? SearchX : Telescope;
  const message = searching
    ? t('catalogBoard.noSearchMatch')
    : filter === 'imaged'
      ? t('catalogBoard.noneImaged')
      : filter === 'remaining'
        ? t('catalogBoard.allImaged')
        : t('catalogBoard.nothingToShow');

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <Icon className={`w-10 h-10 ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
      <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{message}</p>
      <button
        onClick={onReset}
        className={`rounded-full px-4 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors ${
          isDark
            ? 'text-slate-300 ring-slate-700 hover:bg-slate-800'
            : 'text-slate-600 ring-slate-300 hover:bg-slate-100'
        }`}
      >
        {t('catalogBoard.clearFilters')}
      </button>
    </div>
  );
}

/** Matches the loaded layout so the page doesn't jump when data lands. */
function BoardSkeleton({ isDark }: { isDark: boolean }) {
  const block = isDark ? 'bg-slate-900' : 'bg-slate-200';
  return (
    <div className="flex flex-col animate-pulse" aria-hidden="true">
      <div className={`h-64 rounded-3xl ${block}`} />
      <div className={`mt-6 h-11 rounded-full ${block}`} />
      <div
        className="mt-6 grid gap-3 sm:gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
      >
        {Array.from({ length: 24 }).map((_, i) => (
          <div key={i} className={`aspect-square rounded-2xl ${block}`} />
        ))}
      </div>
    </div>
  );
}
