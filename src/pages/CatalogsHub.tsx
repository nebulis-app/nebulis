/**
 * Hub listing all available observing catalog progress boards.
 * Route: /catalogs
 */
import { useQueries } from '@tanstack/react-query';
import { useTheme } from '../hooks/useTheme';
import { getCatalogProgress } from '../lib/api/catalogs';
import { CATALOG_LIST } from '../lib/catalogMeta';
import { CatalogPanel } from '../components/catalogs/CatalogPanel';
import { CatalogsHero } from '../components/catalogs/CatalogsHero';
import { TourAnchor } from '../components/tour/TourAnchor';

export function CatalogsHub() {
  const { isNight, isSpace } = useTheme();
  // Panels sit on dark sky imagery in every theme, so they take the bright
  // accent value directly rather than the light-mode-darkened token.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  const results = useQueries({
    queries: CATALOG_LIST.map(c => ({
      queryKey: ['catalog-progress', c.id],
      queryFn: () => getCatalogProgress(c.id),
      staleTime: 60_000,
    })),
  });

  // The programs are not disjoint: Caldwell and Herschel 400 share 45 objects,
  // and many Sharpless nebulae are also Messier/NGC targets, so summing their
  // totals would count those twice on both sides of the ratio. Dedupe on the
  // canonical NGC id the payload already carries (C2 and NGC40 are the same
  // object) and count each one once.
  const allLoaded = results.every(r => r.data);
  const uniqueObjects = new Map<string, boolean>();
  if (allLoaded) {
    for (const r of results) {
      for (const o of r.data!.objects) {
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
      />

      {/* At two columns an odd count leaves a hole, so the last panel widens
          to fill the row. At three columns it goes back to a single track. */}
      <div
        className={`grid gap-5 md:grid-cols-2 lg:grid-cols-3 ${
          CATALOG_LIST.length % 2 === 1
            ? 'md:[&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1'
            : ''
        }`}
      >
        {CATALOG_LIST.map((c, i) => (
          <CatalogPanel
            key={c.id}
            meta={c}
            progress={results[i].data}
            isLoading={results[i].isLoading}
            accent={accent}
          />
        ))}
      </div>
    </TourAnchor>
  );
}
