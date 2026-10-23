/**
 * Explore: client for /api/v1/explore. Every row already carries the
 * observer-specific visibility, so the UI does no astronomy of its own.
 */
import { fetchJSON } from './client';
import type { FitTag } from '../telescopeFov';

/** The client's resolved telescope field of view, sent so the server can say
 *  how each object fits and filter on "Fits my scope". */
export interface FovParam { widthDeg: number; heightDeg: number }

function fovParams(fov: FovParam | null | undefined): Record<string, number | undefined> {
  // Rounded so the same setup always produces the same query key and URL.
  return fov ? { fovW: Math.round(fov.widthDeg * 1000) / 1000, fovH: Math.round(fov.heightDeg * 1000) / 1000 } : {};
}

export type ExploreCategoryId =
  | 'showpieces'
  | 'galaxies'
  | 'galaxy-groups'
  | 'emission-nebulae'
  | 'planetary-nebulae'
  | 'supernova-remnants'
  | 'dark-reflection'
  | 'clusters';

export type ExploreVisibilityKind = 'tonight' | 'season' | 'low' | 'never';

export interface ExploreVisibility {
  kind: ExploreVisibilityKind;
  maxAlt: number;
  /** Month abbreviations ("Oct") bracketing the longest run above the site minimum. */
  bestFrom: string | null;
  bestTo: string | null;
  tonightMaxAlt: number | null;
}

export interface ExploreRow {
  id: string;
  name: string;
  designation: string;
  aliases: string[];
  type: string;
  typeCode: string;
  category: Exclude<ExploreCategoryId, 'showpieces'> | null;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  ra: number;
  dec: number;
  thumbUrl: string;
  showpiece: number;
  isShowpiece: boolean;
  /** Null when the server has no observing location. */
  visibility: ExploreVisibility | null;
  tonightScore: number | null;
  /** How the object sits in the field of view the request carried; null when
   *  none was sent or the object's size is unknown. */
  fit: { tag: FitTag; fillRatio: number; mosaicCols?: number; mosaicRows?: number } | null;
  isInWishlist: boolean;
  isImaged: boolean;
  libraryObjectId: string | null;
}

export interface ExploreCategory {
  id: ExploreCategoryId;
  total: number;
  visibleHere: number;
  goodTonight: number;
}

export type ExploreSort = 'best' | 'tonight' | 'bright' | 'large' | 'name';
export type ExploreVisibilityFilter = 'all' | 'here' | 'tonight';

export interface ExploreSearchResult {
  results: ExploreRow[];
  total: number;
  constellation: { name: string; count: number } | null;
  locationSet: boolean;
}

export interface ExploreBrowseResult {
  results: ExploreRow[];
  total: number;
  locationSet: boolean;
}

export interface GoodNight {
  /** Local calendar date (YYYY-MM-DD) of the evening the night begins. */
  date: string;
  score: number;
  maxAlt: number;
  visibleHours: number;
  moonIllumination: number;
  moonVerdict: 'ok' | 'caution' | 'warning';
  minMoonSeparation: number | null;
  nightStart: string;
  nightEnd: string;
  isBest: boolean;
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const exploreSearch = (q: string, opts: { siteId?: string | null; limit?: number; fov?: FovParam | null; night?: string | null } = {}) =>
  fetchJSON<ExploreSearchResult>(`/explore/search${qs({ q, limit: opts.limit, siteId: opts.siteId, date: opts.night, ...fovParams(opts.fov) })}`);

export const getExploreCategories = (siteId?: string | null, night?: string | null) =>
  fetchJSON<{ locationSet: boolean; siteId: string | null; siteName: string; categories: ExploreCategory[] }>(
    `/explore/categories${qs({ siteId, date: night })}`,
  );

export const exploreBrowse = (opts: {
  category?: ExploreCategoryId | 'all';
  q?: string;
  constellation?: string;
  sort?: ExploreSort;
  visibility?: ExploreVisibilityFilter;
  notImaged?: boolean;
  /** Keep only objects that fit one frame of `fov`. Needs `fov`. */
  fitsScope?: boolean;
  fov?: FovParam | null;
  /** The evening (YYYY-MM-DD) "up tonight" means; omitted is tonight. */
  night?: string | null;
  limit?: number;
  offset?: number;
  siteId?: string | null;
}) => {
  const { fov, notImaged, fitsScope, night, ...rest } = opts;
  return fetchJSON<ExploreBrowseResult>(`/explore/browse${qs({
    ...rest,
    notImaged: notImaged ? '1' : undefined,
    date: night,
    fitsScope: fitsScope && fov ? '1' : undefined,
    ...fovParams(fov),
  })}`);
};

export const getBestTonight = (opts: { siteId?: string | null; limit?: number; fov?: FovParam | null; night?: string | null } = {}) =>
  fetchJSON<{ results: ExploreRow[]; locationSet: boolean }>(`/explore/best-tonight${qs({ siteId: opts.siteId, limit: opts.limit, date: opts.night, ...fovParams(opts.fov) })}`);

export const getNextGoodNights = (objectId: string, opts: { siteId?: string | null; days?: number } = {}) =>
  fetchJSON<{ locationSet: boolean; nights: GoodNight[]; timezone?: string }>(
    `/explore/next-good-nights/${encodeURIComponent(objectId)}${qs(opts)}`,
  );
