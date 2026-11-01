import { useEffect, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import type { useExploreSite } from '../../hooks/useExploreSite';
import { formatNumber } from '../../lib/formatLocale';
import type { ExploreRow, FovParam } from '../../lib/api/explore';
import { TourAnchor } from '../tour/TourAnchor';
import { ExploreHero } from './ExploreHero';
import { ExploreSearch } from './ExploreSearch';

export type ExploreTab = 'discover' | 'wishlist';

interface Props {
  /** The page's own `useExploreSite()`: the pick is local hook state, so the
   *  banner's site picker has to drive the same instance the page queries with. */
  explore: ReturnType<typeof useExploreSite>;
  locationSet: boolean;
  fov: FovParam;
  night: string | null;
  upLabel?: string;
  wishlistIds: Set<string>;
  wishlistCount: number;
  onAddRow: (row: ExploreRow) => void;
  /** A row picked from the search dropdown: the page opens its object sheet. */
  onOpenRow: (row: ExploreRow) => void;
  activeTab: ExploreTab;
  onSelectTab: (tab: ExploreTab) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Pre-fills the search box, e.g. with the query a results list is showing. */
  initialQuery?: string;
  children: ReactNode;
}

/**
 * What every Explore view sits inside: the banner with the site picker and the
 * catalog search, then the Discover / Wishlist tabs. The landing page and the
 * category lists (/explore/:category) both render through it, so drilling
 * into Galaxies keeps the search and the tabs on screen and reads as a view of
 * Explore rather than a separate page.
 */
export function ExploreShell({
  explore, locationSet, fov, night, upLabel, wishlistIds, wishlistCount, onAddRow, onOpenRow,
  activeTab, onSelectTab, searchRef, initialQuery, children,
}: Props) {
  const { t } = useTranslation('catalogs');
  const { isDark, isNight, isSpace } = useTheme();
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

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
  }, [searchRef]);

  return (
    <div className="space-y-8">
      <TourAnchor id="explore" className="block">
        <ExploreHero accent={accent} sites={explore.sites} site={explore.site} locationSet={locationSet} onSite={explore.setSiteId}>
          <ExploreSearch
            // Keyed on the query so moving between result lists re-seeds the box.
            key={initialQuery ?? ''}
            initialText={initialQuery}
            siteId={explore.siteId}
            night={night}
            upLabel={upLabel}
            fov={fov}
            ready={explore.ready}
            isDark={isDark}
            wishlistIds={wishlistIds}
            onAdd={onAddRow}
            onOpen={onOpenRow}
            inputRef={searchRef}
          />
        </ExploreHero>
      </TourAnchor>

      <div className="-mt-3 space-y-5">
        <div role="tablist" aria-label={t('explore.tabs.label')} className={`flex items-center gap-1 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {(['discover', 'wishlist'] as const).map(id => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`explore-tab-${id}`}
                aria-selected={isActive}
                aria-controls={`explore-panel-${id}`}
                onClick={() => onSelectTab(id)}
                className={`font-display -mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'border-accent-500 text-accent-500'
                    : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`
                }`}
              >
                {t(`explore.tabs.${id}`)}
                {id === 'wishlist' && wishlistCount > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[0.6875rem] font-semibold tabular-nums ${isActive ? 'bg-accent-500/15' : isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
                    {formatNumber(wishlistCount)}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div role="tabpanel" id={`explore-panel-${activeTab}`} aria-labelledby={`explore-tab-${activeTab}`}>
          {children}
        </div>
      </div>
    </div>
  );
}
