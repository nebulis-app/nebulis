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
 * GET /api/v1/dso
 *   Browse / search the full DSO catalog.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSettingsData } from '../lib/telescopes.js';
import { getAll as getWishlistAll } from '../lib/wishlist.js';
import { getLocalObjects } from '../lib/localLibrary.js';
import { getCatalog, search as searchDso, filterCatalog, getById } from '../lib/dsoCatalog.js';
import { altAz, getNightWindow, visibilityWindow, altitudeCurve, moonPhaseName } from '../lib/astroCalc.js';
import { addDaysToDateKey, localDateKey, localParts, zonedDateTimeToUtc } from '../lib/timezone.js';
import { observerTimezoneForCoordinates } from '../lib/observerTimezone.js';
import SunCalc from 'suncalc';

const router = Router();

const PlannerTonightQuerySchema = z.object({
  type: z.string().optional(),
  minAlt: z.coerce.number().optional(),
  /** Local calendar date YYYY-MM-DD whose night we are planning. Defaults to
   *  tonight. The night window is the dusk-to-dawn span beginning that
   *  evening. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Observer coordinates supplied by the client (e.g. phone GPS when
   *  traveling with the scope). When present, these override the server's
   *  saved location for this request only — nothing is persisted. Older
   *  clients that omit these params continue to use the server settings. */
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

const PlannerCurveQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

const DsoBrowseQuerySchema = z.object({
  q: z.string().optional(),
  type: z.string().optional(),
  constellation: z.string().optional(),
  maxMag: z.coerce.number().optional(),
  minSize: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function loadSettings() {
  return getSettingsData();
}

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

  const settings = loadSettings();
  // Client-provided coordinates override saved settings for this request only
  // (e.g. phone GPS when traveling with the scope). Older clients that omit
  // lat/lon continue to use the server's saved location unchanged. Both must be
  // present to override: a half-supplied pair would otherwise mix client
  // latitude with the saved-settings longitude (or vice versa) and place the
  // observer somewhere that is neither location.
  const clientCoords = queryParsed.data.lat != null && queryParsed.data.lon != null
    ? { lat: queryParsed.data.lat, lon: queryParsed.data.lon }
    : null;
  const lat = clientCoords?.lat ?? (typeof settings.latitude === 'number' ? settings.latitude : null);
  const lon = clientCoords?.lon ?? (typeof settings.longitude === 'number' ? settings.longitude : null);

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
    });
    return;
  }

  const now = new Date();
  // When the client supplies coordinates, derive timezone from those coords so
  // displayed times match the scope's actual location. Fall back to the saved
  // settings timezone if the lookup fails or no client coords were provided.
  const observerTimezone = await observerTimezoneForCoordinates(
    lat,
    lon,
    typeof settings.timezone === 'string' ? settings.timezone : null,
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

  // Parse filters from query (query params override settings)
  const typeFilter = queryParsed.data.type;
  const minAlt = queryParsed.data.minAlt ?? (typeof settings.minAlt === 'number' ? settings.minAlt : 20);
  const horizonProfile: number[] | undefined =
    Array.isArray(settings.horizonProfile) && settings.horizonProfile.length === 36
      ? settings.horizonProfile
      : undefined;
  // No artificial limit — return all visible objects so the frontend never
  // misclassifies cut-off targets as "below threshold".

  // Return cached result if still fresh. "today" queries include altNow/azNow
  // which drift over time, so they use a shorter TTL than date-specific ones.
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
  const catalog = getCatalog();
  const targets = [];

  for (let i = 0; i < catalog.length; i++) {
    if (i > 0 && i % 50 === 0) await new Promise<void>(r => setImmediate(r));

    const entry = catalog[i]!;
    if (typeFilter && !entry.type.toLowerCase().includes(typeFilter.toLowerCase()) && entry.typeCode !== typeFilter) {
      continue;
    }

    const window = visibilityWindow(entry.ra, entry.dec, lat, lon, planningStart, planningEnd, minAlt, horizonProfile);
    // Skip if never geometrically above minAlt, or never above the horizon profile
    if (window.maxAlt < minAlt || !window.rises) continue;

    const nowAltAz = altAz(entry.ra, entry.dec, lat, lon, refTime);

    targets.push({
      id: entry.id,
      ngcName: entry.ngcName,
      name: entry.name,
      type: entry.type,
      typeCode: entry.typeCode,
      constellation: entry.constellation,
      magnitude: entry.magnitude,
      majorAxisArcmin: entry.majorAxisArcmin,
      ra: entry.ra,
      dec: entry.dec,
      commonNames: entry.commonNames,
      altNow: Math.round(nowAltAz.alt * 10) / 10,
      azNow: Math.round(nowAltAz.az * 10) / 10,
      maxAlt: Math.round(window.maxAlt * 10) / 10,
      maxAltTime: window.maxAltTime?.toISOString() ?? null,
      risesAt: window.rises?.toISOString() ?? null,
      setsAt: window.sets?.toISOString() ?? null,
      isInWishlist: wishlistIds.has(entry.id),
      isAlreadyImaged: libraryMap.has(entry.id),
      libraryObjectId: libraryMap.get(entry.id) ?? null,
    });
  }

  // Sort by max altitude descending (best targets first)
  targets.sort((a, b) => b.maxAlt - a.maxAlt);

  const payload = {
    locationSet: true,
    targets,
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
  const settings = loadSettings();
  // Both client coords must be present to override saved settings (see /tonight).
  const clientCoords = queryParsed.data.lat != null && queryParsed.data.lon != null
    ? { lat: queryParsed.data.lat, lon: queryParsed.data.lon }
    : null;
  const lat = clientCoords?.lat ?? (typeof settings.latitude === 'number' ? settings.latitude : null);
  const lon = clientCoords?.lon ?? (typeof settings.longitude === 'number' ? settings.longitude : null);

  if (lat === null || lon === null) {
    res.apiError(400, 'NO_LOCATION', 'Observer location not set in settings');
    return;
  }
  const observerTimezone = await observerTimezoneForCoordinates(
    lat,
    lon,
    typeof settings.timezone === 'string' ? settings.timezone : null,
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

// GET /api/v1/dso — browse / search the full DSO catalog
router.get('/', (req: Request, res: Response) => {
  const queryParsed = DsoBrowseQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', queryParsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const { q, type, constellation, maxMag, minSize, limit, offset } = queryParsed.data;

  if (q) {
    const effectiveLimit = Math.min(limit ?? 30, 100);
    const results = searchDso(q, effectiveLimit);
    res.apiSuccess({ results, total: results.length });
    return;
  }

  const { entries, total } = filterCatalog({
    type,
    constellation,
    maxMag,
    minSize,
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
  const settings = loadSettings();
  const lat = typeof settings.latitude === 'number' ? settings.latitude : null;
  const lon = typeof settings.longitude === 'number' ? settings.longitude : null;
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
  const nightDate = parts.hour >= 7 ? today : addDaysToDateKey(today, -1);
  return parseLocalNoon(nightDate, timeZone);
}

export { router as plannerRouter };
export { defaultNightAnchor, parseLocalNoon, resolvePlannerDarkWindow, resolvePlannerTimelineWindow };
