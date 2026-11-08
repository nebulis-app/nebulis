/**
 * Hub listing all available observing catalog progress boards.
 * Route: /catalogs
 */
import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../hooks/useTheme';
import { getCatalogProgress } from '../lib/api/catalogs';
import { CATALOG_LIST } from '../lib/catalogMeta';
import { CatalogPanel } from '../components/catalogs/CatalogPanel';
import { CatalogsHero } from '../components/catalogs/CatalogsHero';
import { TourAnchor } from '../components/tour/TourAnchor';

const HIDDEN_STORAGE_KEY = 'catalogs.hidden';

/** Catalogs the user has switched off in the hero filter. Kept in
 *  localStorage so the choice survives a reload. */
function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function CatalogsHub() {
  const { t } = useTranslation('catalogs');
  const { isNight, isSpace } = useTheme();
  // Panels sit on dark sky imagery in every theme, so they take the bright
  // accent value directly rather than the light-mode-darkened token.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  const [hidden, setHidden] = useState<Set<string>>(readHidden);
  useEffect(() => {
    try { localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
  }, [hidden]);
  const toggleCatalog = (id: string) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const showAll = () => setHidden(new Set());

  const results = useQueries({
    queries: CATALOG_LIST.map(c => ({
      queryKey: ['catalog-progress', c.id],
      queryFn: () => getCatalogProgress(c.id),
      staleTime: 60_000,
    })),
  });

  const visible = CATALOG_LIST
    .map((meta, i) => ({ meta, query: results[i] }))
    .filter(({ meta }) => !hidden.has(meta.id));

  // The programs are not disjoint: Caldwell and Herschel 400 share 45 objects,
  // and many Sharpless nebulae are also Messier/NGC targets, so summing their
  // totals would count those twice on both sides of the ratio. Dedupe on the
  // canonical NGC id the payload already carries (C2 and NGC40 are the same
  // object) and count each one once.
  const allLoaded = visible.length > 0 && visible.every(({ query }) => query.data);
  const uniqueObjects = new Map<string, boolean>();
  if (allLoaded) {
    for (const { query } of visible) {
      for (const o of query.data?.objects ?? []) {
        const key = o.ngcName ?? o.id;
        uniqueObjects.set(key, (uniqueObjects.get(key) ?? false) || o.isImaged);
      }
    }
  }
  const grandTotal = uniqueObjects.size;
  const grandImaged = [...uniqueObjects.values()].filter(Boolean).length;
  const grandPct = grandTotal > 0 ? Math.round((grandImaged / grandTotal) * 100) : 0;

  return (
    <TourAnchor id="catalogs" className="block space-y-6">
      <CatalogsHero
        imaged={grandImaged}
        total={grandTotal}
        pct={grandPct}
        loaded={allLoaded}
        accent={accent}
        catalogs={CATALOG_LIST}
        hidden={hidden}
        onToggle={toggleCatalog}
        onShowAll={showAll}
      />

      {visible.length === 0 ? (
        <div className="rounded-3xl bg-slate-950 p-8 text-center ring-1 ring-inset ring-white/10">
          <p className="text-sm text-white/65">{t('catalogsHero.filterEmpty')}</p>
          <button
            type="button"
            onClick={showAll}
            className="mt-4 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {t('catalogsHero.filterShowAll')}
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map(({ meta, query }) => (
            <CatalogPanel
              key={meta.id}
              meta={meta}
              progress={query.data}
              isLoading={query.isLoading}
              accent={accent}
            />
          ))}
        </div>
      )}
    </TourAnchor>
  );
}
