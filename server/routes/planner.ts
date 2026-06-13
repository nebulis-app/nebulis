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
import SunCalc from 'suncalc';

const router = Router();

const PlannerTonightQuerySchema = z.object({
  type: z.string().optional(),
  minAlt: z.coerce.number().optional(),
  /** Local calendar date YYYY-MM-DD whose night we are planning. Defaults to
   *  tonight. The night window is the dusk-to-dawn span beginning that
   *  evening. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  lat: number, lon: number, dateParam: string | undefined,
  minAlt: number, typeFilter: string | undefined, horizonProfile: number[] | undefined,
): string {
  const hp = horizonProfile ? horizonProfile.join(',') : '';
  return `${lat}:${lon}:${dateParam ?? 'today'}:${minAlt}:${typeFilter ?? ''}:${hp}`;
}

// GET /api/v1/planner/tonight
router.get('/tonight', async (req: Request, res: Response) => {
  const queryParsed = PlannerTonightQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', queryParsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }

  const settings = loadSettings();
  const lat = typeof settings.latitude === 'number' ? settings.latitude : null;
  const lon = typeof settings.longitude === 'number' ? settings.longitude : null;

  if (lat === null || lon === null) {
    res.apiSuccess({
      locationSet: false,
      targets: [],
      nightStart: null,
      nightEnd: null,
      moonIllumination: 0,
      moonPhase: 'Unknown',
    });
    return;
  }

  const now = new Date();
  // Anchor the night-window calculation at noon of the requested date (or
  // the default "tonight" anchor, if no date supplied). getNightWindow
  // searches forward from the anchor for the next dusk-to-dawn pair, which
  // matches "the night that begins on this calendar date."
  const dateParam = queryParsed.data.date;
  const anchor = dateParam ? parseLocalNoon(dateParam) : defaultNightAnchor(now);
  const night = getNightWindow(anchor, lat, lon);

  // Fallback windows: if astronomical twilight doesn't resolve (polar summer),
  // use anchor+2h to anchor+10h so the API never returns null bounds.
  const nightStart = night.nightStart ?? new Date(anchor.getTime() + 2 * 3600000);
  const nightEnd = night.nightEnd ?? new Date(nightStart.getTime() + 8 * 3600000);

  // Sample moon at the chosen night's midpoint, not "now," so future/past
  // dates get the right illumination + phase.
  const moonSampleAt = new Date((nightStart.getTime() + nightEnd.getTime()) / 2);
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
  const cacheKey = plannerCacheKey(lat, lon, dateParam, minAlt, typeFilter, horizonProfile);
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

    const window = visibilityWindow(entry.ra, entry.dec, lat, lon, nightStart, nightEnd, minAlt, horizonProfile);
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
    nightStart: nightStart.toISOString(),
    nightEnd: nightEnd.toISOString(),
    moonIllumination,
    moonPhase,
    observerLat: lat,
    observerLon: lon,
  };

  // Cache: 2 min for "tonight" (altNow drifts), 10 min for specific dates.
  const ttl = dateParam ? 10 * 60 * 1000 : 2 * 60 * 1000;
  plannerCache.set(cacheKey, { payload, expiresAt: Date.now() + ttl });

  res.apiSuccess(payload);
});

// GET /api/v1/planner/curve/:objectId
router.get('/curve/:objectId', (req: Request, res: Response) => {
  const settings = loadSettings();
  const lat = typeof settings.latitude === 'number' ? settings.latitude : null;
  const lon = typeof settings.longitude === 'number' ? settings.longitude : null;

  if (lat === null || lon === null) {
    res.apiError(400, 'NO_LOCATION', 'Observer location not set in settings');
    return;
  }

  const entry = getById(String(req.params.objectId));
  if (!entry) {
    res.apiError(404, 'NOT_FOUND', 'Object not found in DSO catalog');
    return;
  }

  const now = new Date();
  const night = getNightWindow(now, lat, lon);
  const nightStart = night.nightStart ?? new Date(now.getTime() + 2 * 3600000);
  const nightEnd = night.nightEnd ?? new Date(nightStart.getTime() + 8 * 3600000);

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
function parseLocalNoon(yyyymmdd: string): Date {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
}

/**
 * Anchor for "tonight" when no date param is given. Until 07:00 local,
 * tonight is still the night that began yesterday evening (a 02:00 caller is
 * mid-session, and anchoring at `now` would skip ahead to the NEXT evening's
 * window). From 07:00, anchor at `now` so the upcoming evening is tonight.
 * Keep the 07:00 rollover in sync with plannerToday() in src/lib/nightWindow.ts
 * and NightDate.swift in the iOS client.
 */
function defaultNightAnchor(now: Date): Date {
  if (now.getHours() >= 7) return now;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  return yesterday;
}

export { router as plannerRouter };
