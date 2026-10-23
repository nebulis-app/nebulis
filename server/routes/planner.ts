/**
 * Tonight's Target Planner API
 *
 * GET /api/v1/planner/tonight
 *   Returns DSO targets visible tonight from the observer's location,
 *   with altitude, visibility windows, and cross-references to the
 *   user's library and wishlist.
 *
 * GET /api/v1/planner/curve/:objectId
 *   Returns altitude curve data for a specific object tonight.
 *
 * POST /api/v1/planner/plan
 *   Runs the "Plan My Night" auto-scheduler server-side and returns a
 *   sequence of scheduled blocks. This is the single canonical
 *   implementation shared by every client (web, iOS, and eventually
 *   Android) so a plan can never disagree across platforms.
 *
 * POST /api/v1/planner/verdict
 *   Batch moon-proximity + sky-visibility verdicts for already-placed or
 *   candidate blocks, used for live feedback while a user drags/resizes a
 *   block on a schedule timeline.
 *
 * GET /api/v1/dso
 *   Browse / search the full DSO catalog.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { resolveSite, getActiveSite } from '../lib/observingSites.js';
import { getAll as getWishlistAll } from '../lib/wishlist.js';
import { getLocalObjects } from '../lib/localLibrary.js';
import { getPlannerCatalog, searchFiltered as searchDso, filterCatalog, getById, plannerSearchFields, type DsoSort } from '../lib/dsoCatalog.js';
import { altAz, getNightWindow, visibilityWindow, altitudeCurve, moonPhaseName } from '../lib/astroCalc.js';
import { addDaysToDateKey, localDateKey, localParts, zonedDateTimeToUtc } from '../lib/timezone.js';
import { observerTimezoneForCoordinates } from '../lib/observerTimezone.js';
import { OBSERVING_NIGHT_ROLLOVER_HOUR, isPlausibleCalendarDate } from '../lib/telescopeFiles.js';
import { generateNightPlanDetailed, AUTO_PLAN_FOCUSES } from '../lib/autoPlan.js';
import { indexForecastHours, slotSkyQuality, DEFAULT_MAX_CLOUD_COVER } from '../lib/skyQuality.js';
import {
  buildForecast,
  getForecastCacheEntry,
  isUsableForecast,
  setForecastCacheEntry,
  CACHE_TTL_MS,
  type ForecastHour,
} from '../lib/forecastCache.js';
import { log } from '../lib/logger.js';
import { hasNarrowbandCapableFilter } from '../lib/gear.js';
import { checkMoonProximity, moonThresholdForIllumination, moonVerdictFor } from '../lib/moonProximity.js';
import { checkBlockVisibility, type VisibleSkyMap } from '../lib/visibilityCheck.js';
import { computeBestTonightScore } from '../lib/bestTonightScore.js';
import { showpieceScore } from '../lib/explore/showpiece.js';
import { tonightRank } from '../lib/explore/rank.js';
import SunCalc from 'suncalc';

const router = Router();

const PlannerTonightQuerySchema = z.object({
  type: z.string().optional(),
  minAlt: z.coerce.number().optional(),
  /** Local calendar date YYYY-MM-DD whose night we are planning. Defaults to
   *  tonight. The night window is the dusk-to-dawn span beginning that
   *  evening. */
  date: z.string().refine(isPlausibleCalendarDate, 'date must be a real calendar date (YYYY-MM-DD)').optional(),
  /** Explicit observing site to plan from. Wins over lat/lon and over the
   *  server's active/default site — see resolveSite in observingSites.ts. */
  siteId: z.string().optional(),
  /** Observer coordinates supplied by the client (e.g. phone GPS when
   *  traveling with the scope). When present, these override the resolved
   *  site's coordinates for this request only — nothing is persisted. Older
   *  clients that omit these params continue to use the saved site. */
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

const PlannerCurveQuerySchema = z.object({
  siteId: z.string().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

const DsoBrowseQuerySchema = z.object({
  q: z.string().optional(),
  type: z.string().optional(),
  constellation: z.string().optional(),
  maxMag: z.coerce.number().optional(),
  minSize: z.coerce.number().optional(),
  /** Explicit override for both browse and search mode. Omitted: browse mode
   *  keeps catalog order, search mode keeps relevance order. */
  sort: z.enum(['name', 'magnitude']).optional(),
  /** Paired: observer latitude + a minimum-altitude threshold, to drop
   *  objects that can never clear that altitude from this location (e.g.
   *  deep-southern-declination targets for a northern site). `lat` alone
   *  with no `minAlt` defaults the threshold to 0° (ever rises at all). */
  lat: z.coerce.number().min(-90).max(90).optional(),
  minAlt: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function loadWishlist(): string[] {
  return getWishlistAll().map(i => i.objectId);
}

function loadLibraryMap(): Map<string, string> {
  // catalogId → objectId (folder-based primary key)
  const map = new Map<string, string>();
  for (const o of getLocalObjects()) {
    if (o.catalogId) map.set(o.catalogId, o.id);
  }
  return map;
}

interface PlannerCache {
  payload: object;
  expiresAt: number;
}

// Cached for up to 2 minutes per unique (lat, lon, date, minAlt, typeFilter,
// horizonProfile) combination. The night window barely changes within a
// session, so recomputing 50 k+ trig calls on every navigation is wasteful.
const plannerCache = new Map<string, PlannerCache>();

function plannerCacheKey(
  lat: number, lon: number, observerTimezone: string, dateParam: string | undefined,
  minAlt: number, typeFilter: string | undefined, horizonProfile: number[] | undefined,
): string {
  const hp = horizonProfile ? horizonProfile.join(',') : '';
  return `${lat}:${lon}:${observerTimezone}:${dateParam ?? 'today'}:${minAlt}:${typeFilter ?? ''}:${hp}`;
}

function resolvePlannerDarkWindow(night: ReturnType<typeof getNightWindow>): { nightStart: Date; nightEnd: Date } | null {
  const start = night.nightStart ?? night.nauticalDusk;
  const end = night.nightEnd ?? night.nauticalDawn;
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { nightStart: start, nightEnd: end };
}

function resolvePlannerTimelineWindow(night: ReturnType<typeof getNightWindow>): { start: Date; end: Date } | null {
  // Always use sunset→sunrise for the droppable timeline so users can schedule
  // twilight sessions. The dark window is shown as markers inside this wider
  // range but does not constrain where blocks can be placed.
  const start = night.sunset ?? night.dusk ?? resolvePlannerDarkWindow(night)?.nightStart;
  const end = night.sunrise ?? night.dawn ?? resolvePlannerDarkWindow(night)?.nightEnd;
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { start, end };
}

// GET /api/v1/planner/tonight
router.get('/tonight', async (req: Request, res: Response) => {
  const queryParsed = PlannerTonightQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', queryParsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }

  // Resolution order (see resolveSite): explicit siteId > client lat/lon
  // override (e.g. phone GPS while travelling with the scope) > the server's
  // active site > the default site. Both lat and lon must be present to
  // override: a half-supplied pair would otherwise mix a client latitude with
  // a stored longitude and place the observer somewhere that is neither
  // location. Older clients that send neither siteId nor coordinates continue
  // to plan from the active/default site unchanged.
  const site = resolveSite({
    siteId: queryParsed.data.siteId,
    lat: queryParsed.data.lat,
    lon: queryParsed.data.lon,
  });
  const lat = site.latitude;
  const lon = site.longitude;

  if (lat === null || lon === null) {
    res.apiSuccess({
      locationSet: false,
      targets: [],
      nightStart: null,
      nightEnd: null,
      sunset: null,
      sunrise: null,
      timelineStart: null,
      timelineEnd: null,
      moonIllumination: 0,
      moonPhase: 'Unknown',
      observerTimezone: null,
      siteId: site.isTransient ? null : site.id,
      siteName: site.name,
    });
    return;
  }

  const now = new Date();
  // When the resolved site carries no timezone (a transient client-coordinate
  // override), derive one from the coordinates so displayed times match the
  // scope's actual location.
  const observerTimezone = await observerTimezoneForCoordinates(
    lat,
    lon,
    site.timezone || null,
  );
  // Anchor the night-window calculation at noon of the requested date (or
  // the default "tonight" anchor, if no date supplied). getNightWindow
  // searches forward from the anchor for the next dusk-to-dawn pair, which
  // matches "the night that begins on this calendar date."
  const dateParam = queryParsed.data.date;
  const anchor = dateParam
    ? parseLocalNoon(dateParam, observerTimezone)
    : defaultNightAnchor(now, observerTimezone);
  const night = getNightWindow(anchor, lat, lon);

  const darkWindow = resolvePlannerDarkWindow(night);
  const timelineWindow = resolvePlannerTimelineWindow(night);
  if (!timelineWindow) {
    const moonData = SunCalc.getMoonIllumination(now);
    const payload = {
      locationSet: true,
      targets: [],
      totalVisible: 0,
      nightStart: null,
      nightEnd: null,
      sunset: night.sunset?.toISOString() ?? null,
      sunrise: night.sunrise?.toISOString() ?? null,
      timelineStart: null,
      timelineEnd: null,
      moonIllumination: Math.round(moonData.fraction * 100),
      moonPhase: moonPhaseName(moonData.phase),
      observerLat: lat,
      observerLon: lon,
      observerTimezone,
      siteId: site.isTransient ? null : site.id,
      siteName: site.name,
    };
    res.apiSuccess(payload);
    return;
  }
  const nightStart = darkWindow?.nightStart ?? null;
  const nightEnd = darkWindow?.nightEnd ?? null;
  const planningStart = darkWindow?.nightStart ?? timelineWindow.start;
  const planningEnd = darkWindow?.nightEnd ?? timelineWindow.end;

  // Sample moon at the chosen night's midpoint, not "now," so future/past
  // dates get the right illumination + phase.
  const moonSampleAt = new Date((planningStart.getTime() + planningEnd.getTime()) / 2);
  const moonData = SunCalc.getMoonIllumination(moonSampleAt);
  const moonIllumination = Math.round(moonData.fraction * 100);
  const moonPhase = moonPhaseName(moonData.phase);

  // altNow/azNow only mean "now" when the user is actually viewing tonight.
  // For any other date, anchor to the night midpoint so the "Up now" filter
  // still makes sense ("at the middle of this night").
  const refTime = dateParam ? moonSampleAt : now;

  // Parse filters from query (query params override the resolved site)
  const typeFilter = queryParsed.data.type;
  const minAlt = queryParsed.data.minAlt ?? site.minAlt;
  const horizonProfile: number[] | undefined =
    site.horizonProfile.length === 36 ? site.horizonProfile : undefined;
  // No artificial limit — return all visible objects so the frontend never
  // misclassifies cut-off targets as "below threshold".

  // Return cached result if still fresh. "today" queries include altNow/azNow
  // which drift over time, so they use a shorter TTL than date-specific ones.
  // Keyed on the resolved (lat, lon, horizonProfile) tuple, which already
  // fully captures which site was used — a distinct site sharing coordinates
  // with another still differs on horizonProfile/minAlt and so gets its own key.
  const cacheKey = plannerCacheKey(lat, lon, observerTimezone, dateParam, minAlt, typeFilter, horizonProfile);
  const cached = plannerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.apiSuccess(cached.payload);
    return;
  }

  const wishlistIds = new Set(loadWishlist());
  const libraryMap = loadLibraryMap();

  // Evaluate all catalog objects, yielding the event loop every 50 entries so
  // concurrent requests (e.g. POST /planned-sessions) are not queued behind
  // this CPU-bound loop.
  const catalog = getPlannerCatalog();
  const targets = [];

  for (let i = 0; i < catalog.length; i++) {
    if (i > 0 && i % 50 === 0) await new Promise<void>(r => setImmediate(r));

    const entry = catalog[i];
    if (typeFilter && !entry.type.toLowerCase().includes(typeFilter.toLowerCase()) && entry.typeCode !== typeFilter) {
      continue;
    }

    const window = visibilityWindow(entry.ra, entry.dec, lat, lon, planningStart, planningEnd, minAlt, horizonProfile);
    // Skip if never geometrically above minAlt, or never above the horizon profile
    if (window.maxAlt < minAlt || !window.rises) continue;

    const nowAltAz = altAz(entry.ra, entry.dec, lat, lon, refTime);

    targets.push({
      // id, ngcName, name, constellation, commonNames and aliases: see plannerSearchFields.
      ...plannerSearchFields(entry),
      type: entry.type,
      typeCode: entry.typeCode,
      magnitude: entry.magnitude,
      majorAxisArcmin: entry.majorAxisArcmin,
      ra: entry.ra,
      dec: entry.dec,
      altNow: Math.round(nowAltAz.alt * 10) / 10,
      azNow: Math.round(nowAltAz.az * 10) / 10,
      maxAlt: Math.round(window.maxAlt * 10) / 10,
      maxAltTime: window.maxAltTime?.toISOString() ?? null,
      risesAt: window.rises?.toISOString() ?? null,
      setsAt: window.sets?.toISOString() ?? null,
      // How rewarding the object is to shoot at all (see lib/explore/showpiece), so every client can order
      // "Best tonight" by the same blend Explore uses without carrying its own copy of the catalog scores.
      showpiece: showpieceScore(entry),
      isInWishlist: wishlistIds.has(entry.id),
      isAlreadyImaged: libraryMap.has(entry.id),
      libraryObjectId: libraryMap.get(entry.id) ?? null,
    });
  }

  // Sort by max altitude descending (best targets first)
  targets.sort((a, b) => b.maxAlt - a.maxAlt);

  // Composite "Best Tonight" ranking (altitude/duration/magnitude/transit/size),
  // additive to every target so clients can offer a "Best Tonight" sort
  // without a second round trip. nightStart/nightEnd fall back to the wider
  // sunset-sunrise timeline on nights with no true dark window.
  const scoreWindowStart = darkWindow?.nightStart ?? timelineWindow.start;
  const scoreWindowEnd = darkWindow?.nightEnd ?? timelineWindow.end;
  const targetsWithScore = targets.map(t => ({
    ...t,
    bestTonightScore: computeBestTonightScore(t, scoreWindowStart, scoreWindowEnd).total,
  })).map(t => ({
    ...t,
    // The shared "Best tonight" order (lib/explore/rank.ts). `bestTonightScore` stays the pure conditions score
    // ("Best conditions").
    tonightRank: tonightRank(t.bestTonightScore, t.showpiece),
  }));

  const payload = {
    locationSet: true,
    targets: targetsWithScore,
    totalVisible: targets.length,
    nightStart: nightStart?.toISOString() ?? null,
    nightEnd: nightEnd?.toISOString() ?? null,
    sunset: night.sunset?.toISOString() ?? null,
    sunrise: night.sunrise?.toISOString() ?? null,
    timelineStart: timelineWindow.start.toISOString(),
    timelineEnd: timelineWindow.end.toISOString(),
    moonIllumination,
    moonPhase,
    observerLat: lat,
    observerLon: lon,
    observerTimezone,
    siteId: site.isTransient ? null : site.id,
    siteName: site.name,
  };

  // Cache: 2 min for "tonight" (altNow drifts), 10 min for specific dates.
  const ttl = dateParam ? 10 * 60 * 1000 : 2 * 60 * 1000;
  // Sweep expired entries before inserting to prevent unbounded growth.
  if (plannerCache.size > 50) {
    const now = Date.now();
    for (const [k, v] of plannerCache) {
      if (v.expiresAt < now) plannerCache.delete(k);
    }
  }
  plannerCache.set(cacheKey, { payload, expiresAt: Date.now() + ttl });

  res.apiSuccess(payload);
});

// GET /api/v1/planner/curve/:objectId
router.get('/curve/:objectId', async (req: Request, res: Response) => {
  const queryParsed = PlannerCurveQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', queryParsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  // Same resolution order as /tonight: siteId > client lat/lon > active/default site.
  const site = resolveSite({
    siteId: queryParsed.data.siteId,
    lat: queryParsed.data.lat,
    lon: queryParsed.data.lon,
  });
  const lat = site.latitude;
  const lon = site.longitude;

  if (lat === null || lon === null) {
    res.apiError(400, 'NO_LOCATION', 'Observer location not set');
    return;
  }
  const observerTimezone = await observerTimezoneForCoordinates(
    lat,
    lon,
    site.timezone || null,
  );

  const entry = getById(String(req.params.objectId));
  if (!entry) {
    res.apiError(404, 'NOT_FOUND', 'Object not found in DSO catalog');
    return;
  }

  const anchor = defaultNightAnchor(new Date(), observerTimezone);
  const night = getNightWindow(anchor, lat, lon);
  const timelineWindow = resolvePlannerTimelineWindow(night);
  if (!timelineWindow) {
    res.apiError(422, 'NO_PLANNING_WINDOW', 'No sunset-to-sunrise planning window occurs for this location tonight');
    return;
  }
  const nightStart = timelineWindow.start;
  const nightEnd = timelineWindow.end;

  const curve = altitudeCurve(entry.ra, entry.dec, lat, lon, nightStart, nightEnd, 15);

  res.apiSuccess({ entry, curve, nightStart: nightStart.toISOString(), nightEnd: nightEnd.toISOString() });
});

const PlanCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  ra: z.number(),
  dec: z.number(),
  // .nullable().optional() rather than just .nullable(): Swift's JSONEncoder
  // omits nil optional properties entirely instead of sending an explicit
  // null, so an iOS request with e.g. no magnitude has the key missing, not
  // set to null. Web always sends the key with an explicit null. Both must
  // validate.
  magnitude: z.number().nullable().optional().transform(v => v ?? null),
  majorAxisArcmin: z.number().nullable().optional().transform(v => v ?? null),
  constellation: z.string().nullable().optional().transform(v => v ?? null),
  commonNames: z.array(z.string()),
  isAlreadyImaged: z.boolean(),
  /** Per-filter integration goals, read only with `favorGoals`. */
  goals: z.array(z.object({
    filter: z.string().max(100).nullable(),
    goalSec: z.number().min(0),
    remainingSec: z.number().min(0),
  })).max(50).optional(),
});

const AutoPlanBodySchema = z.object({
  targets: z.array(PlanCandidateSchema).min(1),
  observerLat: z.number().min(-90).max(90),
  observerLon: z.number().min(-180).max(180),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  slotMinutes: z.number().positive(),
  maxObjects: z.number().int().positive(),
  minAlt: z.number(),
  moonIllumination: z.number().min(0).max(100),
  // Not `.length(SKY_MAP_CELLS)`: a site with no mask configured yet sends an
  // empty array (iOS's `skyMap` computed property returns [] rather than nil
  // in that case), and visibilityCheck.ts's isEmptyMap() already treats any
  // array whose length isn't SKY_MAP_CELLS as "no restriction" downstream —
  // rejecting it here would just be a stricter, redundant gate that fights
  // the client conventions instead of matching what the code actually does.
  visibleSkyMap: z.array(z.boolean()).max(1000).nullable().optional(),
  focus: z.enum(AUTO_PLAN_FOCUSES).optional(),
  unimagedOnly: z.boolean().optional(),
  jitter: z.number().optional(),
  /** Use the hourly forecast for the observer's location: skip cloudy slots,
   *  steer small targets to steady seeing. Off when omitted, so existing
   *  clients get exactly the plan they always did. */
  useForecast: z.boolean().optional(),
  /** Cloud cover (%) above which a slot is skipped. */
  maxCloudCover: z.number().min(0).max(100).optional(),
  /** Favour objects with integration time left (candidates' `goals`), drop
   *  those whose goals are reached, and pick each block's filter. Off when
   *  omitted. */
  favorGoals: z.boolean().optional(),
  /** Overrides the gear lookup: can this user shoot narrowband? Absent = ask the Gear inventory. */
  narrowbandCapable: z.boolean().optional(),
});

/**
 * Hourly forecast for a location: the cached one when fresh (the Planner and
 * Sky Forecast pages keep it warm for the active site), otherwise a fetch,
 * cached the same way the forecast route does. Null when no forecast can be
 * had, in which case the plan is built without weather.
 */
const FORECAST_WAIT_MS = 8_000;

async function forecastHoursFor(lat: number, lon: number): Promise<{ hours: ForecastHour[]; fetchedAt: number } | null> {
  const cached = getForecastCacheEntry(lat, lon);
  const pick = (data: unknown) => (data as { hourly: ForecastHour[] }).hourly;
  if (cached && isUsableForecast(cached.data) && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { hours: pick(cached.data), fetchedAt: cached.fetchedAt };
  }
  try {
    // Bounded: a slow weather provider must not hold Plan My Night; it falls through to planning without weather.
    const data = await Promise.race([
      buildForecast(lat, lon),
      new Promise<null>(resolve => setTimeout(() => resolve(null), FORECAST_WAIT_MS).unref?.()),
    ]);
    if (data && isUsableForecast(data)) {
      const now = Date.now();
      setForecastCacheEntry({ data, fetchedAt: now, lat, lon });
      return { hours: pick(data), fetchedAt: now };
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[planner] forecast unavailable, planning without weather');
  }
  // A stale but usable entry still beats planning blind.
  if (cached && isUsableForecast(cached.data)) return { hours: pick(cached.data), fetchedAt: cached.fetchedAt };
  return null;
}

// POST /api/v1/planner/plan — run the canonical auto-scheduler server-side.
// Body mirrors AutoPlanParams; both existing callers (the planner page's
// "Plan My Night" and a single catalog's "Plan Tonight") already hold the
// full candidate list client-side, so this endpoint just executes the
// algorithm rather than re-deriving the pool from the DSO catalog itself.
router.post('/plan', async (req: Request, res: Response) => {
  const parsed = AutoPlanBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const body = parsed.data;
  const windowStart = new Date(body.windowStart);
  const windowEnd = new Date(body.windowEnd);
  if (windowEnd.getTime() <= windowStart.getTime()) {
    res.apiError(422, 'VALIDATION_ERROR', 'windowEnd must be after windowStart');
    return;
  }

  const narrowbandCapable = body.narrowbandCapable ?? hasNarrowbandCapableFilter();
  const forecast = body.useForecast ? await forecastHoursFor(body.observerLat, body.observerLon) : null;
  const indexedHours = forecast ? indexForecastHours(forecast.hours) : null;
  const maxCloudCover = body.maxCloudCover ?? DEFAULT_MAX_CLOUD_COVER;

  const { blocks, skippedSlots, goalsComplete } = generateNightPlanDetailed({
    skyQuality: indexedHours
      ? (start, end) => slotSkyQuality(indexedHours, start, end, maxCloudCover)
      : undefined,
    targets: body.targets,
    observerLat: body.observerLat,
    observerLon: body.observerLon,
    windowStart,
    windowEnd,
    slotMinutes: body.slotMinutes,
    maxObjects: body.maxObjects,
    minAlt: body.minAlt,
    moonIllumination: body.moonIllumination,
    visibleSkyMap: body.visibleSkyMap ?? null,
    focus: body.focus,
    unimagedOnly: body.unimagedOnly,
    jitter: body.jitter,
    favorGoals: body.favorGoals,
    narrowbandCapable,
  });

  res.apiSuccess(
    blocks.map(b => ({
      target: b.target,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      meanAlt: Math.round(b.meanAlt * 10) / 10,
      moonSeparation: Number.isFinite(b.moonSeparation) ? Math.round(b.moonSeparation * 10) / 10 : null,
      moonVerdict: b.moonVerdict,
      // Additive, like `sky`: the filter type the Moon check assumed.
      filterBand: b.filterBand,
      // Additive, with favorGoals only: the goal filter picked for the block.
      ...(b.filter !== undefined ? { filter: b.filter, filterRemainingSec: b.filterRemainingSec } : {}),
      // Additive: clients that don't know `sky` ignore it.
      sky: b.sky,
    })),
    {
      weather: {
        requested: body.useForecast === true,
        used: forecast !== null,
        forecastFetchedAt: forecast ? new Date(forecast.fetchedAt).toISOString() : null,
        maxCloudCover,
        skippedSlots: skippedSlots.map(s => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          cloudCover: s.cloudCover,
        })),
      },
      narrowbandCapable,
      goals: {
        requested: body.favorGoals === true,
        complete: goalsComplete.map(t => ({ id: t.id, name: t.name })),
      },
    },
  );
});

const VerdictItemSchema = z.object({
  id: z.string(),
  ra: z.number(),
  dec: z.number(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  /** The block's filter type; absent or null = broadband, as before. */
  band: z.enum(['broadband', 'narrowband']).nullable().optional(),
});

const VerdictBodySchema = z.object({
  items: z.array(VerdictItemSchema).min(1).max(200),
  observerLat: z.number().min(-90).max(90),
  observerLon: z.number().min(-180).max(180),
  moonIllumination: z.number().min(0).max(100),
  // Not `.length(SKY_MAP_CELLS)`: a site with no mask configured yet sends an
  // empty array (iOS's `skyMap` computed property returns [] rather than nil
  // in that case), and visibilityCheck.ts's isEmptyMap() already treats any
  // array whose length isn't SKY_MAP_CELLS as "no restriction" downstream —
  // rejecting it here would just be a stricter, redundant gate that fights
  // the client conventions instead of matching what the code actually does.
  visibleSkyMap: z.array(z.boolean()).max(1000).nullable().optional(),
  /** Observer's IANA timezone, for the reason string's time-of-day. */
  timeZone: z.string().optional(),
});

// POST /api/v1/planner/verdict — batch moon-proximity + sky-visibility check
// for placed blocks. Used for live feedback while a user drags/resizes a
// block on a schedule timeline, so the timeline never disagrees with what
// the auto-scheduler itself would say about the same block.
router.post('/verdict', (req: Request, res: Response) => {
  const parsed = VerdictBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const body = parsed.data;
  const skyMap: VisibleSkyMap | null = body.visibleSkyMap ?? null;

  // Response shapes mirror the client's existing BlockVisibilityResult /
  // MoonProximityResult interfaces field-for-field (dates as ISO strings) so
  // callers can drop these straight into the same UI that used to compute
  // them locally, with no shape changes downstream.
  const results = body.items.map(item => {
    const start = new Date(item.start);
    const end = new Date(item.end);
    const band = item.band ?? 'broadband';
    const moon = checkMoonProximity(item.ra, item.dec, body.observerLat, body.observerLon, start, end, body.moonIllumination, 5, body.timeZone, band);
    // Same closest approach against the narrowband tolerance: lets the client
    // say "narrowband would be fine" on a broadband or unset block.
    const narrowbandVerdict = moonVerdictFor(moon.minSeparation, moonThresholdForIllumination(body.moonIllumination, 'narrowband'));
    const visibility = checkBlockVisibility(item.ra, item.dec, body.observerLat, body.observerLon, start, end, skyMap, 5, body.timeZone);
    return {
      id: item.id,
      moon: {
        verdict: moon.verdict,
        minSeparation: moon.minSeparation,
        threshold: Math.round(moon.threshold * 10) / 10,
        worstAt: moon.worstAt?.toISOString() ?? null,
        moonAltAtWorst: Math.round(moon.moonAltAtWorst * 10) / 10,
        reason: moon.reason,
        band,
        narrowbandVerdict,
      },
      visibility: {
        verdict: visibility.verdict,
        fractionVisible: Math.round(visibility.fractionVisible * 100) / 100,
        firstBlockedAt: visibility.firstBlockedAt?.toISOString() ?? null,
        reason: visibility.reason,
        minAlt: Math.round(visibility.minAlt * 10) / 10,
        maxAlt: Math.round(visibility.maxAlt * 10) / 10,
      },
    };
  });

  res.apiSuccess(results);
});

// GET /api/v1/dso — browse / search the full DSO catalog
router.get('/', (req: Request, res: Response) => {
  const queryParsed = DsoBrowseQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', queryParsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const { q, type, constellation, maxMag, minSize, sort, lat, minAlt, limit, offset } = queryParsed.data;
  const sortOpt: DsoSort | undefined = sort;

  if (q) {
    const { entries, total } = searchDso(q, {
      type,
      lat,
      minAlt,
      sort: sortOpt,
      limit: Math.min(limit ?? 30, 500),
      offset: offset ?? 0,
    });
    res.apiSuccess({ results: entries, total });
    return;
  }

  const { entries, total } = filterCatalog({
    type,
    constellation,
    maxMag,
    minSize,
    lat,
    minAlt,
    sort: sortOpt,
    limit: Math.min(limit ?? 100, 500),
    offset: offset ?? 0,
  });

  res.apiSuccess({ results: entries, total });
});

// GET /api/v1/dso/:id — single object detail
router.get('/:id', (req: Request, res: Response) => {
  const entry = getById(String(req.params.id));
  if (!entry) {
    res.apiError(404, 'NOT_FOUND', 'Object not found in DSO catalog');
    return;
  }

  // Add current alt/az if location is set
  const site = getActiveSite();
  const lat = site.latitude;
  const lon = site.longitude;
  const position = lat !== null && lon !== null
    ? altAz(entry.ra, entry.dec, lat, lon, new Date())
    : null;

  res.apiSuccess({ ...entry, altNow: position?.alt ?? null, azNow: position?.az ?? null });
});

/**
 * Parse a YYYY-MM-DD date string into a Date set to local noon. Local noon
 * keeps the day-boundary unambiguous and gives getNightWindow a clean anchor:
 * the night that starts that evening, not the previous night.
 */
function parseLocalNoon(yyyymmdd: string, timeZone?: string): Date {
  return zonedDateTimeToUtc(yyyymmdd, { hour: 12 }, timeZone);
}

/**
 * Anchor for "tonight" when no date param is given. Until 07:00 local,
 * tonight is still the night that began yesterday evening (a 02:00 caller is
 * mid-session, and anchoring at `now` would skip ahead to the NEXT evening's
 * window). From 07:00, anchor at `now` so the upcoming evening is tonight.
 * Keep the 07:00 rollover in sync with plannerToday() in src/lib/nightWindow.ts,
 * NightDate.swift in the iOS client, and PlannerTime.kt in the Android client.
 */
function defaultNightAnchor(now: Date, timeZone?: string): Date {
  const parts = localParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  const nightDate = parts.hour >= OBSERVING_NIGHT_ROLLOVER_HOUR ? today : addDaysToDateKey(today, -1);
  return parseLocalNoon(nightDate, timeZone);
}

export { router as plannerRouter };
export { defaultNightAnchor, parseLocalNoon, resolvePlannerDarkWindow, resolvePlannerTimelineWindow };
