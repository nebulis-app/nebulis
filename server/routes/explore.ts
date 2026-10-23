/**
 * Explore: a discovery surface over the whole deep-sky catalog.
 *
 *   GET /api/v1/explore/search?q=              typeahead rows (+ a constellation hint)
 *   GET /api/v1/explore/categories             browse tiles with counts for this site
 *   GET /api/v1/explore/browse                 paged, ranked, filtered object rows
 *   GET /api/v1/explore/best-tonight           the "worth shooting tonight" rail
 *   GET /api/v1/explore/next-good-nights/:id   ranked upcoming nights for one object
 *
 * Read-only and open to every role; adding to the wishlist still goes through
 * POST /wishlist. Ranking is the static showpiece score (lib/explore/showpiece),
 * location comes from resolveSite, and every number the client shows (visibility,
 * months, tonight score) is computed here so iOS / Android / Mac get it for free.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { resolveSite } from '../lib/observingSites.js';
import { getAll as getWishlistAll } from '../lib/wishlist.js';
import { getLocalObjects } from '../lib/localLibrary.js';
import { getPlannerCatalog, getById, searchScored, designationsFor, type DsoEntry } from '../lib/dsoCatalog.js';
import { getNightWindow } from '../lib/astroCalc.js';
import { addDaysToDateKey, localDateKey, localParts } from '../lib/timezone.js';
import { observerTimezoneForCoordinates } from '../lib/observerTimezone.js';
import { OBSERVING_NIGHT_ROLLOVER_HOUR, isPlausibleCalendarDate } from '../lib/telescopeFiles.js';
import { defaultNightAnchor, parseLocalNoon, resolvePlannerDarkWindow } from './planner.js';
import { EXPLORE_CATEGORY_IDS, categoryOf, isExploreCategoryId, type ExploreCategoryId } from '../lib/explore/categories.js';
import { showpieceScore, isShowpiece } from '../lib/explore/showpiece.js';
import { classifyFit, type FitAssessment, type FovDeg } from '../lib/explore/fit.js';
import { bestTonightEntries, inCategory, selectAndSort } from '../lib/explore/browse.js';
import { rankNights } from '../lib/explore/nights.js';
import {
  everVisible, getTonightIndex, visibilityFor,
  type ExploreSiteContext, type TonightIndex, type Visibility,
} from '../lib/explore/visibility.js';

const router = Router();

// ── Context ──────────────────────────────────────────────────────────────

const SiteQuerySchema = z.object({
  siteId: z.string().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  /** The client's resolved telescope field of view, in degrees. Both or
   *  neither: it is what lets rows carry a fit verdict and "Fits my scope"
   *  filter the whole category. */
  fovW: z.coerce.number().positive().max(180).optional(),
  fovH: z.coerce.number().positive().max(180).optional(),
  /** The evening (YYYY-MM-DD) whose dark window "up tonight" means, matching the Planner's `date`. Omitted: tonight. */
  date: z.string().refine(isPlausibleCalendarDate, 'date must be a real calendar date (YYYY-MM-DD)').optional(),
});

// Every endpoint shares the site, field-of-view and night parameters, so a bad one is refused in one place
// rather than being quietly ignored by whichever handler reads it.
router.use((req: Request, res: Response, next) => {
  const parsed = SiteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  next();
});

interface ExploreContext {
  locationSet: boolean;
  siteId: string | null;
  siteName: string;
  timezone: string | null;
  /** Null until the site has coordinates. */
  site: ExploreSiteContext | null;
  tonight: TonightIndex | null;
  wishlist: Set<string>;
  library: Map<string, string>;
  /** Null when the client did not send a field of view. */
  fov: FovDeg | null;
}

async function buildContext(query: unknown): Promise<ExploreContext> {
  const parsed = SiteQuerySchema.safeParse(query);
  const q = parsed.success ? parsed.data : {};
  const resolved = resolveSite({ siteId: q.siteId, lat: q.lat, lon: q.lon });

  const wishlist = new Set(getWishlistAll().map(i => i.objectId));
  const library = new Map<string, string>();
  for (const o of getLocalObjects()) if (o.catalogId) library.set(o.catalogId, o.id);

  const fov = q.fovW != null && q.fovH != null ? { widthDeg: q.fovW, heightDeg: q.fovH } : null;
  const base = {
    siteId: resolved.isTransient ? null : resolved.id,
    siteName: resolved.name,
    wishlist,
    library,
    fov,
  };
  if (resolved.latitude === null || resolved.longitude === null) {
    return { ...base, locationSet: false, timezone: null, site: null, tonight: null };
  }

  const lat = resolved.latitude;
  const lon = resolved.longitude;
  const timezone = await observerTimezoneForCoordinates(lat, lon, resolved.timezone || null);
  const site: ExploreSiteContext = {
    siteKey: resolved.id,
    lat,
    lon,
    minAlt: resolved.minAlt,
    horizonProfile: resolved.horizonProfile.length === 36 ? resolved.horizonProfile : undefined,
  };
  const anchor = q.date ? parseLocalNoon(q.date, timezone) : defaultNightAnchor(new Date(), timezone);
  const night = getNightWindow(anchor, lat, lon);
  const dark = resolvePlannerDarkWindow(night);
  const tonight = dark ? getTonightIndex(site, dark.nightStart, dark.nightEnd) : null;
  return { ...base, locationSet: true, timezone, site, tonight };
}

// ── Rows ─────────────────────────────────────────────────────────────────

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
  /** Relative URL of the cached master; the server picks the field of view. */
  thumbUrl: string;
  showpiece: number;
  isShowpiece: boolean;
  /** Null when no location is set. */
  visibility: Visibility | null;
  /** The planner's 0-1 score for tonight, null when it is not up. */
  tonightScore: number | null;
  /** How the object sits in the client's field of view; null without a field
   *  of view or without a known size. */
  fit: FitAssessment | null;
  isInWishlist: boolean;
  isImaged: boolean;
  libraryObjectId: string | null;
}

function toRow(entry: DsoEntry, ctx: ExploreContext): ExploreRow {
  const aliases = designationsFor(entry);
  return {
    id: entry.id,
    name: entry.name,
    designation: entry.id,
    aliases: aliases.slice(0, 4),
    type: entry.type,
    typeCode: entry.typeCode,
    category: categoryOf(entry),
    constellation: entry.constellation,
    magnitude: entry.magnitude,
    majorAxisArcmin: entry.majorAxisArcmin,
    ra: entry.ra,
    dec: entry.dec,
    thumbUrl: `/api/catalog/${encodeURIComponent(entry.id)}/image?w=384&h=384`,
    showpiece: showpieceScore(entry),
    isShowpiece: isShowpiece(entry),
    visibility: ctx.site ? visibilityFor(entry, ctx.site, ctx.tonight) : null,
    tonightScore: ctx.tonight?.byId.get(entry.id)?.score ?? null,
    fit: ctx.fov ? classifyFit(ctx.fov, entry.majorAxisArcmin) : null,
    isInWishlist: ctx.wishlist.has(entry.id),
    isImaged: ctx.library.has(entry.id),
    libraryObjectId: ctx.library.get(entry.id) ?? null,
  };
}

// ── Search ───────────────────────────────────────────────────────────────

const SearchQuerySchema = SiteQuerySchema.extend({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

let constellationCounts: Map<string, { name: string; count: number }> | null = null;
function constellationIndex() {
  if (!constellationCounts) {
    constellationCounts = new Map();
    for (const e of getPlannerCatalog()) {
      if (!e.constellation) continue;
      const key = e.constellation.toLowerCase();
      const hit = constellationCounts.get(key);
      if (hit) hit.count++;
      else constellationCounts.set(key, { name: e.constellation, count: 1 });
    }
  }
  return constellationCounts;
}

router.get('/search', async (req: Request, res: Response) => {
  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const { q, limit } = parsed.data;
  const ctx = await buildContext(req.query);

  const matches = searchScored(q).sort((a, b) => b.score - a.score || showpieceScore(b.entry) - showpieceScore(a.entry));
  const rows = matches.slice(0, limit).map(m => toRow(m.entry, ctx));
  const constellation = constellationIndex().get(q.trim().toLowerCase()) ?? null;

  res.apiSuccess({ results: rows, total: matches.length, constellation, locationSet: ctx.locationSet });
});

// ── Categories ───────────────────────────────────────────────────────────

router.get('/categories', async (req: Request, res: Response) => {
  const ctx = await buildContext(req.query);
  const stats = new Map<ExploreCategoryId, { total: number; visibleHere: number; goodTonight: number }>(
    EXPLORE_CATEGORY_IDS.map(id => [id, { total: 0, visibleHere: 0, goodTonight: 0 }]),
  );

  for (const entry of getPlannerCatalog()) {
    const visible = ctx.site ? everVisible(entry, ctx.site) : true;
    const tonight = ctx.tonight?.byId.has(entry.id) ?? false;
    for (const id of EXPLORE_CATEGORY_IDS) {
      if (!inCategory(entry, id)) continue;
      const s = stats.get(id);
      if (!s) continue;
      s.total++;
      if (visible) s.visibleHere++;
      if (tonight) s.goodTonight++;
    }
  }

  res.apiSuccess({
    locationSet: ctx.locationSet,
    siteId: ctx.siteId,
    siteName: ctx.siteName,
    categories: EXPLORE_CATEGORY_IDS.map(id => ({ id, ...stats.get(id) })),
  });
});

// ── Browse ───────────────────────────────────────────────────────────────

const flag = z.union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')]).optional().transform(v => v === '1' || v === 'true');

const BrowseQuerySchema = SiteQuerySchema.extend({
  category: z.string().default('all'),
  q: z.string().max(100).optional(),
  constellation: z.string().max(60).optional(),
  sort: z.enum(['best', 'tonight', 'bright', 'large', 'name']).default('best'),
  visibility: z.enum(['all', 'here', 'tonight']).default('here'),
  notImaged: flag,
  /** Keep only objects that fit one frame of the client's field of view. */
  fitsScope: flag,
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/browse', async (req: Request, res: Response) => {
  const parsed = BrowseQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const { category, q, constellation, sort, visibility, notImaged, fitsScope: onlyFits, limit, offset } = parsed.data;
  if (category !== 'all' && !isExploreCategoryId(category)) {
    res.apiError(422, 'VALIDATION_ERROR', `Unknown category "${category}"`);
    return;
  }
  const ctx = await buildContext(req.query);
  const query = q?.trim() ?? '';

  // Search keeps its relevance order unless the caller picked another sort, and
  // uses the showpiece score only to break ties between equally good matches.
  const scored = query
    ? searchScored(query).sort((a, b) => b.score - a.score || showpieceScore(b.entry) - showpieceScore(a.entry))
    : getPlannerCatalog().map(entry => ({ entry, score: 0 }));

  const list = selectAndSort(scored.map(s => s.entry), {
    category: category as ExploreCategoryId | 'all', constellation, notImaged, visibility, fitsOnly: onlyFits, sort, hasQuery: query.length > 0,
  }, { site: ctx.site, tonight: ctx.tonight, fov: ctx.fov, isImaged: id => ctx.library.has(id) });

  const page = list.slice(offset, offset + limit).map(e => toRow(e, ctx));
  res.apiSuccess({ results: page, total: list.length, locationSet: ctx.locationSet });
});

// ── Best tonight ─────────────────────────────────────────────────────────

const BestTonightQuerySchema = SiteQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(30).default(10),
});

router.get('/best-tonight', async (req: Request, res: Response) => {
  const parsed = BestTonightQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const ctx = await buildContext(req.query);
  if (!ctx.tonight) {
    res.apiSuccess({ results: [], locationSet: ctx.locationSet });
    return;
  }
  const tonight = ctx.tonight;
  const ranked = bestTonightEntries(getPlannerCatalog(), tonight, parsed.data.limit);

  res.apiSuccess({ results: ranked.map(e => toRow(e, ctx)), locationSet: true });
});

// ── Next good nights ─────────────────────────────────────────────────────

const NextNightsQuerySchema = SiteQuerySchema.extend({
  days: z.coerce.number().int().min(1).max(60).default(30),
});

router.get('/next-good-nights/:objectId', async (req: Request, res: Response) => {
  const parsed = NextNightsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const entry = getById(String(req.params.objectId));
  if (!entry) {
    res.apiError(404, 'NOT_FOUND', 'Object not found in DSO catalog');
    return;
  }
  const ctx = await buildContext(req.query);
  if (!ctx.site || !ctx.timezone) {
    res.apiSuccess({ locationSet: false, nights: [] });
    return;
  }
  const { lat, lon, minAlt, horizonProfile } = ctx.site;
  const tz = ctx.timezone;

  const now = new Date();
  const today = localDateKey(now, tz);
  const firstNight = localParts(now, tz).hour >= OBSERVING_NIGHT_ROLLOVER_HOUR ? today : addDaysToDateKey(today, -1);

  const dates: string[] = [];
  for (let i = 0; i < parsed.data.days; i++) {
    const date = addDaysToDateKey(firstNight, i);
    if (isPlausibleCalendarDate(date)) dates.push(date);
  }
  const nights = rankNights(
    entry,
    { lat, lon, minAlt, horizonProfile, timezone: tz },
    dates,
    date => {
      const dark = resolvePlannerDarkWindow(getNightWindow(parseLocalNoon(date, tz), lat, lon));
      return dark ? { start: dark.nightStart, end: dark.nightEnd } : null;
    },
  );

  res.apiSuccess({ locationSet: true, objectId: entry.id, timezone: tz, nights });
});

export { router as exploreRouter };
