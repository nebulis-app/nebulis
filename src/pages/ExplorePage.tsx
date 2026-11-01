/**
 * Explore: the place to find something to photograph, and to keep the list of
 * what you found. A global search over the whole catalog (any name or
 * designation) sits in the banner above two tabs: Discover (tonight's best
 * targets from your site, and large tiles to browse by kind) and Wishlist
 * (what you have saved, see ExploreWishlist). Route: /explore, with
 * `?tab=wishlist` for the second tab (the old /wishlist redirects there) and
 * the drill-in lists at /explore/:category.
 *
 * Everything here is location-aware through the server (visibility, "up
 * tonight", best months), and every card can go straight onto the wishlist or
 * tonight's plan without leaving the page.
 */
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, MoonStar, X } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useExploreSite } from '../hooks/useExploreSite';
import { useResolvedFov } from '../hooks/useResolvedFov';
import { useExploreActions } from '../components/explore/useExploreActions';
import { useExploreNight, withNight } from '../components/explore/useExploreNight';
import { getBestTonight, getExploreCategories, type ExploreRow } from '../lib/api/explore';
import { ExploreShell, type ExploreTab } from '../components/explore/ExploreShell';
import { ExploreCard } from '../components/explore/ExploreCard';
import { CategoryTile } from '../components/explore/CategoryTile';
import { ExploreObjectSheet } from '../components/explore/ExploreObjectSheet';
import { ExploreWishlist } from '../components/explore/ExploreWishlist';
import { EXPLORE_CATEGORIES } from '../components/explore/categoryMeta';

export function ExplorePage() {
  const { t } = useTranslation('catalogs');
  const { isDark } = useTheme();
  const explore = useExploreSite();
  const { site, siteId, ready } = explore;
  const actions = useExploreActions(siteId);
  const fov = useResolvedFov();
  const navigate = useNavigate();
  const night = useExploreNight();
  const searchRef = useRef<HTMLInputElement>(null);
  // Discover is always the default; the Planner's "Open full Wishlist" and the
  // old /wishlist route land on the second tab through the query string.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: ExploreTab = searchParams.get('tab') === 'wishlist' ? 'wishlist' : 'discover';
  function selectTab(next: ExploreTab) {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      if (next === 'wishlist') params.set('tab', 'wishlist');
      else params.delete('tab');
      return params;
    }, { replace: true });
  }

  const categories = useQuery({
    queryKey: ['explore-categories', siteId, night.night],
    queryFn: () => getExploreCategories(siteId, night.night),
    enabled: ready,
    staleTime: 60_000,
  });
  const best = useQuery({
    queryKey: ['explore-best-tonight', siteId, fov.widthDeg, fov.heightDeg, night.night],
    queryFn: () => getBestTonight({ siteId, limit: 12, fov, night: night.night }),
    enabled: ready,
    staleTime: 60_000,
  });

  const locationSet = categories.data?.locationSet ?? Boolean(site?.latitude != null);
  const bestRows = useMemo(() => best.data?.results ?? [], [best.data]);
  const statsById = useMemo(() => new Map((categories.data?.categories ?? []).map(c => [c.id, c])), [categories.data]);

  // The sheet steps through whatever list it was opened from: the rail, or the
  // single object picked from the search dropdown.
  const [sheet, setSheet] = useState<{ rows: ExploreRow[]; id: string } | null>(null);

  const heading = `font-display text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`;

  return (
    <>
      <ExploreShell
        explore={explore}
        locationSet={locationSet}
        fov={fov}
        night={night.night}
        upLabel={night.upLabel}
        wishlistIds={actions.wishlist.idSet}
        wishlistCount={actions.wishlist.items.length}
        onAddRow={actions.addRow}
        onOpenRow={row => setSheet({ rows: [row], id: row.id })}
        activeTab={tab}
        onSelectTab={selectTab}
        searchRef={searchRef}
      >
        {tab === 'wishlist' ? (
          <ExploreWishlist />
        ) : (
          <div className="space-y-8">
            {night.dateLabel && (
              <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-2.5 text-sm ${isDark ? 'border-slate-700 bg-slate-900/60 text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`} role="status">
                <span className="inline-flex items-center gap-2"><MoonStar className="h-4 w-4 text-accent-500" />{t('explore.night.showing', { date: night.dateLabel })}</span>
                <button type="button" onClick={night.clear} className="inline-flex items-center gap-1 font-medium text-accent-500 hover:underline">
                  <X className="h-3.5 w-3.5" />{t('explore.night.backToTonight')}
                </button>
              </div>
            )}

            {bestRows.length > 0 && (
              <section aria-labelledby="explore-best">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 id="explore-best" className={heading}>{night.dateLabel ? t('explore.best.titleOn', { date: night.dateLabel }) : t('explore.best.title')}</h2>
                  <Link to={withNight('/explore/all?visibility=tonight&sort=tonight', night.night)} className="inline-flex items-center gap-1 text-sm font-medium text-accent-500 hover:underline">
                    {t('explore.best.seeAll')}<ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
                <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
                  {bestRows.map(row => (
                    <ExploreCard
                      key={row.id}
                      compact
                      row={row}
                      isDark={isDark}
                      inWishlist={actions.wishlist.idSet.has(row.id)}
                      onOpen={() => setSheet({ rows: bestRows, id: row.id })}
                      onAdd={() => actions.addRow(row)}
                      onPlanTonight={() => void actions.planTonight(row)}
                      onOpenPlanner={() => navigate('/planner', { state: { searchQuery: row.id, ...(night.night ? { focusDate: night.night } : {}) } })}
                      upLabel={night.upLabel}
                      planning={actions.planning === row.id}
                      planNote={actions.notes[row.id]}
                    />
                  ))}
                </div>
              </section>
            )}

            <section aria-labelledby="explore-browse">
              <div className="mb-3">
                <h2 id="explore-browse" className={heading}>{t('explore.browse.title')}</h2>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {EXPLORE_CATEGORIES.map(meta => (
                  <CategoryTile key={meta.id} meta={meta} stats={statsById.get(meta.id)} locationSet={locationSet} night={night.night} />
                ))}
              </div>
            </section>
          </div>
        )}
      </ExploreShell>

      {sheet && (
        <ExploreObjectSheet
          rows={sheet.rows}
          openId={sheet.id}
          onOpenId={id => setSheet(id ? { rows: sheet.rows, id } : null)}
          siteId={siteId}
          minAlt={site?.minAlt ?? 20}
          wishlistItems={actions.wishlist.items}
          onAdd={actions.wishlist.add}
          onSetPriority={actions.wishlist.setPriority}
          onSetNotes={actions.wishlist.setNotes}
          onRemove={actions.wishlist.remove}
          planOnNight={actions.planOnNight}
        />
      )}
    </>
  );
}
