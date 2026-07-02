/**
 * Progress board for a named observing catalog (Messier, Caldwell, etc.).
 * Route: /catalogs/:catalog
 */
import { useState, useMemo, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Grid3X3, Sparkles } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { getCatalogProgress } from '../lib/api/catalogs';
import { getSettings } from '../lib/api/settings';
import { ProgressHeader } from '../components/catalogs/ProgressHeader';
import { CatalogTile } from '../components/catalogs/CatalogTile';
import { CatalogObjectModal } from '../components/catalogs/CatalogObjectModal';
import { CatalogPlanModal } from '../components/catalogs/CatalogPlanModal';

export function CatalogBoard() {
  const { catalog = 'messier' } = useParams<{ catalog: string }>();
  const { isDark, isNight, isSpace } = useTheme();

  const [filter, setFilter] = useState<'all' | 'imaged' | 'remaining'>('all');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
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

  const filteredObjects = useMemo(() => {
    if (!progress) return [];
    switch (filter) {
      case 'imaged':    return progress.objects.filter(o => o.isImaged);
      case 'remaining': return progress.objects.filter(o => !o.isImaged);
      default:          return progress.objects;
    }
  }, [progress, filter]);

  useEffect(() => { setSelectedIndex(null); }, [filter]);

  const selected = selectedIndex !== null ? (filteredObjects[selectedIndex] ?? null) : null;

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-amber-400';

  if (progressQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
      </div>
    );
  }

  if (progressQuery.isError || !progress) {
    return (
      <div className="p-8 text-center">
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Could not load catalog. Try refreshing.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 -mb-8">
      {/* Page title row */}
      <div className="flex items-center gap-3 pb-4">
        <Link
          to="/catalogs"
          className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
          aria-label="Back to catalogs"
        >
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <h1 className={`font-display text-3xl font-bold tracking-tight flex items-center gap-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
          <Grid3X3 className={`w-7 h-7 ${accentText}`} />
          {progress.label} Progress
        </h1>
        {observerLat != null && observerLon != null && progress.objects.some(o => !o.isImaged) && (
          <button
            onClick={() => setPlanOpen(true)}
            className={`ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition border ${
              isNight
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/30'
                : isSpace
                  ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border-violet-500/30'
                  : isDark
                    ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border-accent-500/30'
                    : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border-accent-400'
            }`}
            title={`Plan tonight from un-imaged ${progress.label} objects`}
          >
            <Sparkles className="w-4 h-4" />
            Plan Tonight
          </button>
        )}
      </div>

      {/* Sticky progress header + filters */}
      <div className="sticky top-16 z-20 -mx-6">
        <ProgressHeader
          label={progress.label}
          total={progress.total}
          imagedCount={progress.imagedCount}
          byType={progress.byType}
          filter={filter}
          onFilterChange={setFilter}
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
        />
      </div>

      {/* Grid */}
      <div className="pt-6 px-0">
        {filteredObjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Grid3X3 className={`w-12 h-12 ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
            <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {filter === 'imaged'
                ? "You haven't imaged any of these objects yet."
                : 'All objects in this catalog have been imaged.'}
            </p>
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
          >
            {filteredObjects.map((obj, idx) => (
              <CatalogTile
                key={obj.id}
                object={obj}
                isDark={isDark}
                isNight={isNight}
                isSpace={isSpace}
                onClick={() => setSelectedIndex(idx)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selected && selectedIndex !== null && (
        <CatalogObjectModal
          object={selected}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex < filteredObjects.length - 1}
          onPrev={() => setSelectedIndex(i => Math.max(0, (i ?? 0) - 1))}
          onNext={() => setSelectedIndex(i => Math.min(filteredObjects.length - 1, (i ?? 0) + 1))}
          observerLat={observerLat}
          observerLon={observerLon}
          minAlt={minAlt}
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          onClose={() => setSelectedIndex(null)}
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
