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

export { router as skyEventsRouter };
