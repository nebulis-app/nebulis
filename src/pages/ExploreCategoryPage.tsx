/**
 * One slice of the sky, ranked: "Top galaxies", "Emission nebulae", the search
 * results for a query, or the best objects in a constellation. Route:
 * /explore/:category, where category is a tile id or `all` (with `q` and/or
 * `constellation`, plus the filters, in the query string so a link, a refresh
 * and the back button all land in the same place).
 *
 * It renders inside ExploreShell, under the Discover tab, with the search and
 * tabs still on screen: a breadcrumb back to Discover and a row of category
 * chips replace the full-size banner and "Back to Explore" link it used to
 * have, so moving from Showpieces to Galaxies is one click, not two.
 */
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useExploreSite } from '../hooks/useExploreSite';
import { useResolvedFov } from '../hooks/useResolvedFov';
import { useExploreActions } from '../components/explore/useExploreActions';
import {
  exploreBrowse, getExploreCategories,
  type ExploreCategoryId, type ExploreRow, type ExploreSort, type ExploreVisibilityFilter,
} from '../lib/api/explore';
import { ExploreShell, type ExploreTab } from '../components/explore/ExploreShell';
import { ExploreCard } from '../components/explore/ExploreCard';
import { useExploreNight, withNight } from '../components/explore/useExploreNight';
import { ExploreObjectSheet } from '../components/explore/ExploreObjectSheet';
import { EXPLORE_CATEGORIES, categoryMeta } from '../components/explore/categoryMeta';
import { EXPLORE_ART } from '../lib/exploreArt';
import { formatNumber } from '../lib/formatLocale';

const PAGE_SIZE = 30;
const SORTS: ExploreSort[] = ['best', 'tonight', 'bright', 'large', 'name'];
const VISIBILITIES: ExploreVisibilityFilter[] = ['tonight', 'here', 'all'];

function isSort(v: string | null): v is ExploreSort { return v !== null && (SORTS as string[]).includes(v); }
function isVisibility(v: string | null): v is ExploreVisibilityFilter { return v !== null && (VISIBILITIES as string[]).includes(v); }

export function ExploreCategoryPage() {
  const { t } = useTranslation('catalogs');
  const { isDark } = useTheme();
  const params = useParams<{ category: string }>();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const night = useExploreNight();
  const explore = useExploreSite();
  const { site, siteId, ready } = explore;
  const actions = useExploreActions(siteId);
  const fov = useResolvedFov();
  const searchRef = useRef<HTMLInputElement>(null);
  // The sheet steps through whatever list it was opened from: this grid, or
  // the single object picked from the search dropdown.
  const [sheet, setSheet] = useState<{ rows: ExploreRow[]; id: string } | null>(null);

  const categoryParam = params.category ?? 'all';
  const meta = categoryMeta(categoryParam);
  const category: ExploreCategoryId | 'all' = meta ? meta.id : 'all';
  const q = search.get('q') ?? '';
  const constellation = search.get('constellation') ?? '';
  const sort: ExploreSort = isSort(search.get('sort')) ? (search.get('sort') as ExploreSort) : 'best';
  const visibility: ExploreVisibilityFilter = isVisibility(search.get('visibility')) ? (search.get('visibility') as ExploreVisibilityFilter) : 'here';
  const notImaged = search.get('notImaged') === '1';
  const fitsScope = search.get('fitsScope') === '1';

  /** Another category, keeping the filters and night but not a search query. */
  function categoryHref(id: ExploreCategoryId): string {
    const next = new URLSearchParams(search);
    next.delete('q');
    next.delete('constellation');
    const qs = next.toString();
    return `/explore/${id}${qs ? `?${qs}` : ''}`;
  }

  function selectTab(tab: ExploreTab) {
    navigate(tab === 'wishlist' ? '/explore?tab=wishlist' : withNight('/explore', night.night));
  }

  function setParam(key: string, value: string | null) {
    setSearch(prev => {
      const next = new URLSearchParams(prev);
      if (value === null || value === '') next.delete(key); else next.set(key, value);
      return next;
    }, { replace: true });
  }

  const stats = useQuery({
    queryKey: ['explore-categories', siteId, night.night],
    queryFn: () => getExploreCategories(siteId, night.night),
    enabled: ready,
    staleTime: 60_000,
  });
  const locationSet = stats.data?.locationSet ?? Boolean(site?.latitude != null);

  const browse = useInfiniteQuery({
    queryKey: ['explore-browse', category, q, constellation, sort, visibility, notImaged, fitsScope, fov.widthDeg, fov.heightDeg, siteId, night.night],
    queryFn: ({ pageParam }) => exploreBrowse({
      category, q: q || undefined, constellation: constellation || undefined, sort,
      visibility: locationSet ? visibility : 'all', notImaged, fitsScope, fov, night: night.night, limit: PAGE_SIZE, offset: pageParam, siteId,
    }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.results.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled: ready,
    staleTime: 60_000,
  });
  const rows = useMemo(() => browse.data?.pages.flatMap(p => p.results) ?? [], [browse.data]);
  const total = browse.data?.pages[0]?.total ?? 0;

  const title = meta
    ? t(`explore.categories.${meta.id}.label`)
    : q ? t('explore.results.forQuery', { query: q })
    : constellation ? t('explore.results.inConstellation', { name: constellation })
    : visibility === 'tonight' ? (night.dateLabel ? t('explore.results.bestOn', { date: night.dateLabel }) : t('explore.results.bestTonight'))
    : t('explore.results.all');

  const chip = (active: boolean) => `rounded-full px-3 py-1 text-xs font-medium transition ${
    active ? 'bg-accent-500 text-white' : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
  }`;
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';

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
        activeTab="discover"
        onSelectTab={selectTab}
        searchRef={searchRef}
        initialQuery={q || undefined}
      >
        <div className="space-y-5">
          <div>
            <nav aria-label={t('explore.results.breadcrumb')} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link to={withNight('/explore', night.night)} className={`text-sm font-medium transition hover:text-accent-500 ${muted}`}>
                {t('explore.tabs.discover')}
              </Link>
              <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${muted}`} aria-hidden />
              <h2 className={heading} aria-current="page">{title}</h2>
              <span className={`text-sm ${muted}`} aria-live="polite">
                {browse.isLoading ? '' : t('explore.results.count', { formatted: formatNumber(total) })}
              </span>
            </nav>
            {/* One line, never wrapped: a second row pushed the chips and the grid down. The full text is the tooltip. */}
          {meta && <p className={`mt-1 truncate text-sm ${muted}`} title={t(`explore.categories.${meta.id}.intro`)}>{t(`explore.categories.${meta.id}.intro`)}</p>}
            {night.dateLabel && (
              <p className={`mt-1 text-xs ${muted}`}>
                {t('explore.night.showing', { date: night.dateLabel })}{' '}
                <button type="button" onClick={night.clear} className="font-medium text-accent-500 hover:underline">{t('explore.night.backToTonight')}</button>
              </p>
            )}
          </div>

          <div role="group" aria-label={t('explore.results.categories')} className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {EXPLORE_CATEGORIES.map(c => {
              const isActive = c.id === meta?.id;
              return (
                <Link
                  key={c.id}
                  to={categoryHref(c.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs font-medium transition ${
                    isActive
                      ? 'border-accent-500 bg-accent-500/15 text-accent-500'
                      : isDark ? 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100' : 'border-slate-200 text-slate-700 hover:border-slate-400 hover:text-slate-900'
                  }`}
                >
                  <img src={EXPLORE_ART[c.id].src} alt="" className="h-6 w-6 rounded-full object-cover" style={{ backgroundColor: c.tint }} />
                  {t(`explore.categories.${c.id}.label`)}
                </Link>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('explore.filters.visibility')}>
              {VISIBILITIES.map(v => (
                <button
                  key={v}
                  type="button"
                  disabled={!locationSet && v !== 'all'}
                  aria-pressed={visibility === v}
                  onClick={() => setParam('visibility', v === 'here' ? null : v)}
                  className={`${chip(locationSet ? visibility === v : v === 'all')} disabled:opacity-40`}
                >
                  {v === 'tonight' && night.dateLabel ? t('explore.filters.upOn', { date: night.dateLabel }) : t(`explore.filters.${v}`)}
                </button>
              ))}
              <label className={`ml-2 flex items-center gap-1.5 text-xs ${muted}`}>
                <input type="checkbox" className="rounded" checked={notImaged} onChange={e => setParam('notImaged', e.target.checked ? '1' : null)} />
                {t('explore.filters.notImaged')}
              </label>
              <label className={`flex items-center gap-1.5 text-xs ${muted}`} title={t('explore.filters.fitsScopeHint', { scope: fov.label })}>
                <input type="checkbox" className="rounded" checked={fitsScope} onChange={e => setParam('fitsScope', e.target.checked ? '1' : null)} />
                {t('explore.filters.fitsScope')}
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('explore.filters.sort')}>
              <span className={`mr-1 text-xs ${muted}`}>{t('explore.filters.sort')}</span>
              {SORTS.filter(s => s !== 'tonight' || locationSet).map(s => (
                <button key={s} type="button" aria-pressed={sort === s} onClick={() => setParam('sort', s === 'best' ? null : s)} className={chip(sort === s)}>
                  {t(`explore.sort.${s}`)}
                </button>
              ))}
            </div>
          </div>

          {browse.isLoading ? (
            <p className={`py-16 text-center text-sm ${muted}`}>{t('explore.results.loading')}</p>
          ) : rows.length === 0 ? (
            <div className={`py-16 text-center text-sm ${muted}`}>
              <p>{t('explore.results.empty')}</p>
              {visibility !== 'all' && (
                <button type="button" onClick={() => setParam('visibility', 'all')} className="mt-3 font-medium text-accent-500 hover:underline">
                  {t('explore.results.showEverything')}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {rows.map(row => (
                  <ExploreCard
                    key={row.id}
                    row={row}
                    isDark={isDark}
                    inWishlist={actions.wishlist.idSet.has(row.id)}
                    onOpen={() => setSheet({ rows, id: row.id })}
                    onAdd={() => actions.addRow(row)}
                    onPlanTonight={() => void actions.planTonight(row)}
                    onOpenPlanner={() => navigate('/planner', { state: { searchQuery: row.id, ...(night.night ? { focusDate: night.night } : {}) } })}
                    upLabel={night.upLabel}
                    planning={actions.planning === row.id}
                    planNote={actions.notes[row.id]}
                  />
                ))}
              </div>
              {browse.hasNextPage && (
                <div className="flex justify-center pb-2">
                  <button
                    type="button"
                    onClick={() => void browse.fetchNextPage()}
                    disabled={browse.isFetchingNextPage}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-medium transition disabled:opacity-60 ${
                      isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {browse.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t('explore.results.loadMore')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
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
