import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import {
  getObjectMedia,
  type MediaGroupBy, type MediaItem, type MediaSort, type MediaTabId, type ObjectMedia,
} from '../../lib/api/library';
import { everyMember } from '../unionList';

const PAGE_SIZE = 120;

/** The lib/api media unions have no runtime arrays, so the lists live here —
 *  compile-checked to name every member, and shared with MediaToolbar so the
 *  URL parser and the pickers can't drift apart. Order is display order. */
/** The media tabs, plus Nights: not a kind of file but the same pictures listed night by night. There is no Telescope
 *  tab: Images already holds the telescope's pictures, and an old `?tab=telescope` link opens it. */
export type ViewTabId = Exclude<MediaTabId, 'telescope'> | 'nights';
export type MediaCounts = Record<ViewTabId, number>;
export const MEDIA_TABS = everyMember<ViewTabId>()(['all', 'processed', 'sub', 'nights', 'project', 'video']);
export const MEDIA_GROUPS = everyMember<MediaGroupBy>()(['night', 'telescope', 'filter', 'type', 'none']);
export const MEDIA_SORTS = everyMember<MediaSort>()(['newest', 'oldest', 'time']);

export interface MediaViewState {
  tab: ViewTabId;
  group: MediaGroupBy;
  sort: MediaSort;
  telescope: string;
  filter: string;
  night: string;
  format: string;
  favorites: boolean;
}

/** URL param names, so a view survives refresh / back / a shared link. The
 *  defaults are left out of the URL to keep it short. */
const PARAM = {
  tab: 'tab', group: 'group', sort: 'sort', telescope: 'scope',
  filter: 'filter', night: 'night', format: 'format', favorites: 'fav',
} as const satisfies Record<keyof MediaViewState, string>;

/** PARAM has exactly MediaViewState's keys (enforced above), so membership in
 *  PARAM proves a string is a view-state key. */
function isViewKey(key: string): key is keyof MediaViewState {
  return Object.hasOwn(PARAM, key);
}

const DEFAULTS: MediaViewState = {
  tab: 'all', group: 'none', sort: 'newest', telescope: '', filter: '', night: '', format: '', favorites: false,
};

/** Sub-frames are browsed night by night; everything else is one flat grid until the user groups it. */
export function defaultGroupFor(tab: ViewTabId): MediaGroupBy {
  return tab === 'sub' || tab === 'nights' ? 'night' : 'none';
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find(a => a === value) ?? fallback;
}

export function useObjectMedia(objectId: string) {
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo<MediaViewState>(() => ({
    tab: oneOf(searchParams.get(PARAM.tab), MEDIA_TABS, DEFAULTS.tab),
    group: oneOf(searchParams.get(PARAM.group), MEDIA_GROUPS, defaultGroupFor(oneOf(searchParams.get(PARAM.tab), MEDIA_TABS, DEFAULTS.tab))),
    sort: oneOf(searchParams.get(PARAM.sort), MEDIA_SORTS, DEFAULTS.sort),
    telescope: searchParams.get(PARAM.telescope) ?? '',
    filter: searchParams.get(PARAM.filter) ?? '',
    night: searchParams.get(PARAM.night) ?? '',
    format: searchParams.get(PARAM.format) ?? '',
    favorites: searchParams.get(PARAM.favorites) === '1',
  }), [searchParams]);

  const update = useCallback((patch: Partial<MediaViewState>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      const tab = patch.tab ?? oneOf(prev.get(PARAM.tab), MEDIA_TABS, DEFAULTS.tab);
      for (const key of Object.keys(patch)) {
        if (!isViewKey(key)) continue;
        const value = patch[key];
        const name = PARAM[key];
        const fallback = key === 'group' ? defaultGroupFor(tab) : DEFAULTS[key];
        if (value === fallback || value === '' || value === false) next.delete(name);
        else next.set(name, value === true ? '1' : String(value));
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const clearFilters = useCallback(
    () => update({ telescope: '', filter: '', night: '', format: '', favorites: false }),
    [update],
  );

  const activeFilterCount =
    (state.telescope ? 1 : 0) + (state.filter ? 1 : 0) + (state.night ? 1 : 0)
    + (state.format ? 1 : 0) + (state.favorites ? 1 : 0);

  const query = useInfiniteQuery({
    queryKey: ['object-media', objectId, state],
    enabled: !!objectId,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getObjectMedia(objectId, {
      kind: state.tab === 'nights' ? 'all' : state.tab,
      group: state.tab === 'nights' ? 'night' : state.group,
      sort: state.sort,
      telescope: state.telescope,
      filter: state.filter,
      night: state.night,
      format: state.format,
      favorites: state.favorites,
      offset: pageParam,
      limit: PAGE_SIZE,
    }),
    getNextPageParam: last => last.nextOffset ?? undefined,
    // Keep the grid on screen while a filter change loads, so it does not
    // flash empty between every click.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });

  const pages = query.data?.pages;
  const first: ObjectMedia | undefined = pages?.[0];
  const items = useMemo<MediaItem[]>(() => pages?.flatMap(p => p.items) ?? [], [pages]);
  const counts = useMemo<MediaCounts | undefined>(
    () => (first ? { ...first.counts, nights: first.facets.nights.length } : undefined),
    [first],
  );

  return {
    state, update, clearFilters, activeFilterCount,
    counts, facets: first?.facets, groups: first?.groups ?? [],
    items, total: first?.total ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    isPlaceholder: query.isPlaceholderData,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
  };
}
