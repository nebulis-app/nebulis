import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getForecastCacheEntry } from '../lib/forecastCache.js';
import { observerTimezoneForCoordinates } from '../lib/observerTimezone.js';
import { resolveSite } from '../lib/observingSites.js';
import {
  SKY_EVENT_KINDS,
  listSkyEvents,
  skyEventsRange,
  withForecastScores,
  type SkyEventKind,
} from '../lib/skyEvents.js';
import { addDaysToDateKey, localDateKey, zonedDateTimeToUtc } from '../lib/timezone.js';
import { DEFAULT_MIN_ALTITUDE, PassCalculator, type IssPass } from '../lib/iss/passes.js';
import { getIssTle } from '../lib/iss/tle.js';
import { TransitFinder, type IssTransit } from '../lib/iss/transits.js';

const router = Router();

const DEFAULT_SPAN_DAYS = 180;
const MAX_SPAN_DAYS = 1100;

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-10-08');

const QuerySchema = z.object({
  from: dateKey.optional(),
  to: dateKey.optional(),
  siteId: z.string().min(1).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  kinds: z.string().optional(),
});

function dayNumber(key: string): number {
  return Date.parse(`${key}T00:00:00Z`) / 86_400_000;
}

// GET /api/v1/sky-events?from=2026-10-08&to=2027-04-08&siteId=…&kinds=meteorShower,opposition
// Global events from the bundled table, each judged from the resolved observing site: whether it is up in the dark, how
// high, when to look, and how much the Moon interferes. Read-only; nothing here reaches an outside service.
router.get('/', async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(400, 'INVALID_QUERY', parsed.error.issues[0]?.message ?? 'Invalid query');
    return;
  }
  const q = parsed.data;
  if ((q.lat === undefined) !== (q.lon === undefined)) {
    res.apiError(400, 'INVALID_COORDS', 'Send both lat and lon, or neither');
    return;
  }

  let kinds: Set<SkyEventKind> | undefined;
  if (q.kinds) {
    const wanted = q.kinds.split(',').map((k) => k.trim()).filter(Boolean);
    const unknown = wanted.find((k) => !(SKY_EVENT_KINDS as readonly string[]).includes(k));
    if (unknown) {
      res.apiError(400, 'INVALID_KINDS', `Unknown event kind "${unknown}". Choose from ${SKY_EVENT_KINDS.join(', ')}`);
      return;
    }
    kinds = new Set(wanted as SkyEventKind[]);
  }

  const site = resolveSite({ siteId: q.siteId, lat: q.lat, lon: q.lon });
  if (site.latitude === null || site.longitude === null) {
    res.apiError(400, 'INVALID_COORDS', 'Set an observing site first');
    return;
  }
  const timezone = await observerTimezoneForCoordinates(site.latitude, site.longitude, site.timezone || null);

  const fromKey = q.from ?? localDateKey(new Date(), timezone);
  const toKey = q.to ?? addDaysToDateKey(fromKey, DEFAULT_SPAN_DAYS);
  if (dayNumber(toKey) < dayNumber(fromKey)) {
    res.apiError(400, 'INVALID_RANGE', '"to" must not be before "from"');
    return;
  }
  if (dayNumber(toKey) - dayNumber(fromKey) > MAX_SPAN_DAYS) {
    res.apiError(400, 'RANGE_TOO_LARGE', `Ask for ${MAX_SPAN_DAYS} days or fewer at a time`);
    return;
  }

  const from = zonedDateTimeToUtc(fromKey, { hour: 0 }, timezone);
  const to = new Date(zonedDateTimeToUtc(addDaysToDateKey(toKey, 1), { hour: 0 }, timezone).getTime() - 1);
  const skySite = { latitude: site.latitude, longitude: site.longitude, timezone };

  const events = withForecastScores(
    listSkyEvents({ from, to, kinds, site: skySite }),
    getForecastCacheEntry(site.latitude, site.longitude)?.data,
  );

  res.apiSuccess({
    ...skyEventsRange(),
    site: { id: site.id, name: site.name, latitude: site.latitude, longitude: site.longitude, timezone },
    from: fromKey,
    to: toKey,
    events,
  });
});

const IssQuerySchema = z.object({
  siteId: z.string().min(1).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  days: z.coerce.number().int().min(1).max(10).optional(),
  minAlt: z.coerce.number().min(0).max(80).optional(),
  /** `1` lists daylight and shadowed passes too, not only the visible ones. */
  all: z.enum(['0', '1']).optional(),
});

/** Passes computed per elements, site and window, for a few minutes: a page reload must not redo the search. */
const issCache = new Map<string, { at: number; passes: IssPass[] }>();
const ISS_CACHE_MS = 10 * 60_000;

// GET /api/v1/sky-events/iss-passes?siteId=…&days=7
// ISS passes over the resolved site for the next days: rise, peak and set above the floor, the visible stretch (dark sky,
// station sunlit), its estimated magnitude, and whether it ends in Earth's shadow. Unlike GET /, this may ask CelesTrak
// for the station's elements (at most every few hours); a TLE older than three days is flagged `stale`.
router.get('/iss-passes', async (req: Request, res: Response) => {
  const parsed = IssQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(400, 'INVALID_QUERY', parsed.error.issues[0]?.message ?? 'Invalid query');
    return;
  }
  const q = parsed.data;
  if ((q.lat === undefined) !== (q.lon === undefined)) {
    res.apiError(400, 'INVALID_COORDS', 'Send both lat and lon, or neither');
    return;
  }
  const site = resolveSite({ siteId: q.siteId, lat: q.lat, lon: q.lon });
  if (site.latitude === null || site.longitude === null) {
    res.apiError(400, 'INVALID_COORDS', 'Set an observing site first');
    return;
  }
  const timezone = await observerTimezoneForCoordinates(site.latitude, site.longitude, site.timezone || null);
  const days = q.days ?? 7;
  const minAlt = q.minAlt ?? DEFAULT_MIN_ALTITUDE;
  const tle = await getIssTle({ allowFetch: true });
  const siteOut = { id: site.id, name: site.name, latitude: site.latitude, longitude: site.longitude, timezone };
  if (!tle) {
    res.apiSuccess({ site: siteOut, tle: null, minAltitude: minAlt, passes: [] });
    return;
  }
  const from = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const to = new Date(from.getTime() + days * 86_400_000);
  const key = `${tle.epoch}|${site.latitude.toFixed(3)}|${site.longitude.toFixed(3)}|${days}|${minAlt}|${Math.floor(from.getTime() / ISS_CACHE_MS)}`;
  let passes = issCache.get(key)?.passes;
  if (!passes) {
    passes = new PassCalculator(tle.record.line1, tle.record.line2, { latitude: site.latitude, longitude: site.longitude })
      .passes(from, to, minAlt);
    issCache.set(key, { at: Date.now(), passes });
    for (const [k, v] of issCache) if (Date.now() - v.at > ISS_CACHE_MS) issCache.delete(k);
  }
  res.apiSuccess({
    site: siteOut,
    tle: { epoch: tle.epoch, ageHours: tle.ageHours, stale: tle.stale, source: tle.source },
    minAltitude: minAlt,
    passes: q.all === '1' ? passes : passes.filter(p => p.visible !== null),
  });
});

const TransitQuerySchema = z.object({
  siteId: z.string().min(1).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  days: z.coerce.number().int().min(1).max(10).optional(),
  radiusKm: z.coerce.number().min(5).max(300).optional(),
});

const transitCache = new Map<string, { at: number; transits: IssTransit[] }>();

// GET /api/v1/sky-events/iss-transits?siteId=…&radiusKm=50&days=7
// ISS transits of the Moon and the Sun whose centre line passes within radiusKm of the site: when (to 0.1 s), how long,
// where the centre line passes and how far and which way to drive, how wide the band is, and the centre line around the
// site for a map. Uses the station's elements like /iss-passes; their epoch and age come with the answer, since a
// transit band moves by kilometres with a day-old TLE.
router.get('/iss-transits', async (req: Request, res: Response) => {
  const parsed = TransitQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(400, 'INVALID_QUERY', parsed.error.issues[0]?.message ?? 'Invalid query');
    return;
  }
  const q = parsed.data;
  if ((q.lat === undefined) !== (q.lon === undefined)) {
    res.apiError(400, 'INVALID_COORDS', 'Send both lat and lon, or neither');
    return;
  }
  const site = resolveSite({ siteId: q.siteId, lat: q.lat, lon: q.lon });
  if (site.latitude === null || site.longitude === null) {
    res.apiError(400, 'INVALID_COORDS', 'Set an observing site first');
    return;
  }
  const timezone = await observerTimezoneForCoordinates(site.latitude, site.longitude, site.timezone || null);
  const days = q.days ?? 7;
  const radiusKm = q.radiusKm ?? 50;
  const tle = await getIssTle({ allowFetch: true });
  const siteOut = { id: site.id, name: site.name, latitude: site.latitude, longitude: site.longitude, timezone };
  if (!tle) {
    res.apiSuccess({ site: siteOut, tle: null, radiusKm, transits: [] });
    return;
  }
  const from = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const to = new Date(from.getTime() + days * 86_400_000);
  const key = `${tle.epoch}|${site.latitude.toFixed(3)}|${site.longitude.toFixed(3)}|${days}|${radiusKm}|${Math.floor(from.getTime() / ISS_CACHE_MS)}`;
  let transits = transitCache.get(key)?.transits;
  if (!transits) {
    const finder = new TransitFinder(tle.record.line1, tle.record.line2, { lat: site.latitude, lon: site.longitude });
    transits = [...finder.find('moon', from, to, radiusKm), ...finder.find('sun', from, to, radiusKm)]
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    transitCache.set(key, { at: Date.now(), transits });
    for (const [k, v] of transitCache) if (Date.now() - v.at > ISS_CACHE_MS) transitCache.delete(k);
  }
  res.apiSuccess({
    site: siteOut,
    tle: { epoch: tle.epoch, ageHours: tle.ageHours, stale: tle.stale, source: tle.source },
    radiusKm,
    transits,
  });
});

export { router as skyEventsRouter };
