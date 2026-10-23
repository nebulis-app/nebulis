/**
 * Explore: the place to find something to photograph. A global search over
 * the whole catalog (any name or designation), tonight's best targets from
 * your site, and large tiles to browse by kind. Route: /explore, with the
 * drill-in lists at /explore/:category.
 *
 * Everything here is location-aware through the server (visibility, "up
 * tonight", best months), and every card can go straight onto the wishlist or
 * tonight's plan without leaving the page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, MoonStar, Star, X } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useExploreSite } from '../hooks/useExploreSite';
import { useResolvedFov } from '../hooks/useResolvedFov';
import { useExploreActions } from '../components/explore/useExploreActions';
import { useExploreNight, withNight } from '../components/explore/useExploreNight';
import { getBestTonight, getExploreCategories, type ExploreRow } from '../lib/api/explore';
import { ExploreHero } from '../components/explore/ExploreHero';
import { TourAnchor } from '../components/tour/TourAnchor';
import { ExploreSearch } from '../components/explore/ExploreSearch';
import { ExploreCard } from '../components/explore/ExploreCard';
import { CategoryTile } from '../components/explore/CategoryTile';
import { ExploreObjectSheet } from '../components/explore/ExploreObjectSheet';
import { EXPLORE_CATEGORIES } from '../components/explore/categoryMeta';

export function ExplorePage() {
  const { t } = useTranslation('catalogs');
  const { isDark, isNight, isSpace } = useTheme();
  const { sites, site, siteId, ready, setSiteId } = useExploreSite();
  const actions = useExploreActions(siteId);
  const fov = useResolvedFov();
  const navigate = useNavigate();
  const night = useExploreNight();
  const searchRef = useRef<HTMLInputElement>(null);
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

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

  // "/" jumps to the search box, the way it does on most sites, unless the
  // user is already typing somewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const heading = `font-display text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`;

  return (
    <div className="space-y-8">
      <TourAnchor id="explore" className="block">
      <ExploreHero accent={accent} sites={sites} site={site} locationSet={locationSet} onSite={setSiteId}>
        <ExploreSearch
          siteId={siteId}
          night={night.night}
          upLabel={night.upLabel}
          fov={fov}
          ready={ready}
          isDark={isDark}
          wishlistIds={actions.wishlist.idSet}
          onAdd={actions.addRow}
          onOpen={row => setSheet({ rows: [row], id: row.id })}
          inputRef={searchRef}
        />
      </ExploreHero>
      </TourAnchor>

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
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="explore-browse" className={heading}>{t('explore.browse.title')}</h2>
          <Link to="/wishlist" className="inline-flex items-center gap-1 text-sm font-medium text-accent-500 hover:underline">
            <Star className="h-3.5 w-3.5" />{t('explore.browse.myWishlist', { count: actions.wishlist.items.length })}
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {EXPLORE_CATEGORIES.map(meta => (
            <CategoryTile key={meta.id} meta={meta} stats={statsById.get(meta.id)} locationSet={locationSet} night={night.night} />
          ))}
        </div>
      </section>

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
    </div>
  );
}
