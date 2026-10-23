import { Router, Request, Response } from 'express';
import {
  buildForecast,
  getForecastCacheEntry,
  setForecastCacheEntry,
  snapshotNightConditions,
  markForecastRequested,
  isUsableForecast,
  CACHE_TTL_MS,
  REFRESH_MIN_AGE_MS,
  forecastSiteKey,
} from '../lib/forecastCache.js';
import { getNightConditions } from '../lib/nightConditions.js';
import { resolveSite } from '../lib/observingSites.js';
import { burstyRateLimiter } from '../middleware/rateLimit.js';

const router = Router();

// ─── Combined forecast endpoint ─────────────────────────────────

router.get('/', burstyRateLimiter, async (req: Request, res: Response) => {
  let resolvedLat: number | null = null;
  let resolvedLon: number | null = null;
  try {
    // siteId wins; otherwise explicit lat/lon (existing clients that read
    // settings.latitude/longitude directly); otherwise the active/default
    // site. See resolveSite in observingSites.ts for the full precedence.
    //
    // Range-checked here rather than left to resolveSite: its ad-hoc-override
    // branch trusts the caller's coordinates outright (by design, so a
    // same-process caller that already validated doesn't get clamped twice),
    // so an out-of-range lat/lon from an HTTP query string must be rejected
    // before it reaches that path.
    const siteId = typeof req.query.siteId === 'string' ? req.query.siteId : undefined;
    const rawLat = req.query.lat !== undefined ? parseFloat(String(req.query.lat)) : undefined;
    const rawLon = req.query.lon !== undefined ? parseFloat(String(req.query.lon)) : undefined;
    const hasRawCoords = req.query.lat !== undefined || req.query.lon !== undefined;
    const validLat = rawLat !== undefined && Number.isFinite(rawLat) && rawLat >= -90 && rawLat <= 90;
    const validLon = rawLon !== undefined && Number.isFinite(rawLon) && rawLon >= -180 && rawLon <= 180;
    if (hasRawCoords && !(validLat && validLon)) {
      res.apiError(400, 'INVALID_COORDS', 'Valid latitude (-90 to 90) and longitude (-180 to 180) required');
      return;
    }

    const site = resolveSite({
      siteId,
      lat: validLat ? rawLat : undefined,
      lon: validLon ? rawLon : undefined,
    });
    resolvedLat = site.latitude;
    resolvedLon = site.longitude;

    if (resolvedLat === null || resolvedLon === null) {
      res.apiError(400, 'INVALID_COORDS', 'Valid latitude (-90 to 90) and longitude (-180 to 180) required');
      return;
    }

    const cached = getForecastCacheEntry(resolvedLat, resolvedLon);
    const cacheAge = cached ? Date.now() - cached.fetchedAt : Infinity;
    const cachedUsable = cached ? isUsableForecast(cached.data) : false;
    // Honour ?refresh=1 only once the cached entry is past REFRESH_MIN_AGE_MS,
    // so a client looping refresh can't drive unbounded upstream fetches. The
    // exception: an entry with no usable hourly data (a transient Open-Meteo
    // outage that got cached) is refreshed immediately, so the user's Retry
    // actually recovers instead of re-serving the empty forecast.
    const forceRefresh =
      req.query.refresh === '1' && (cacheAge >= REFRESH_MIN_AGE_MS || !cachedUsable);

    markForecastRequested(resolvedLat, resolvedLon);

    // Serve from cache only when the entry is fresh AND actually has data. A
    // cached empty forecast is never served: re-fetch instead so a bad entry
    // recovers on the next request rather than sticking for the full TTL.
    if (!forceRefresh && cached && cacheAge < CACHE_TTL_MS && cachedUsable) {
      res.apiSuccess(cached.data);
      return;
    }

    const data = await buildForecast(resolvedLat, resolvedLon);
    const now = Date.now();
    if (isUsableForecast(data)) {
      setForecastCacheEntry({ data, fetchedAt: now, lat: resolvedLat, lon: resolvedLon, lastRequestedAt: now });
      snapshotNightConditions(data, resolvedLat, resolvedLon);
      res.apiSuccess(data);
      return;
    }

    // buildForecast came back with no hourly data (Open-Meteo unreachable).
    // Don't cache it. Serve the last good entry if we still have one, even
    // stale; otherwise hand the empty payload back for the client to show its
    // own retryable "forecast unavailable" state.
    if (cached && cachedUsable) {
      res.apiSuccess(cached.data);
      return;
    }
    res.apiSuccess(data);
  } catch (err: unknown) {
    // On error, serve a stale entry for this site if we have one.
    const stale = resolvedLat !== null && resolvedLon !== null
      ? getForecastCacheEntry(resolvedLat, resolvedLon)
      : null;
    if (stale) {
      res.apiSuccess(stale.data);
      return;
    }
    const message = err instanceof Error ? err.message : 'Forecast fetch failed';
    res.apiError(500, 'FORECAST_FAILED', message);
  }
});

// ─── A past night's weather, as it was recorded ─────────────────
// GET /api/v1/forecast/recorded?night=2026-10-06&lat=&lon=
// The hourly conditions kept for that night at that forecast grid cell (see lib/nightConditions.ts): the forecast snapshot,
// which alone has seeing, else an archive row. `conditions` is null when nothing was kept; clients then fall back to their
// own archive lookup.
router.get('/recorded', (req: Request, res: Response) => {
  const night = String(req.query.night ?? '');
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) {
    res.apiError(400, 'VALIDATION_ERROR', 'Nights look like 2026-10-08');
    return;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.apiError(400, 'INVALID_COORDS', 'Valid latitude (-90 to 90) and longitude (-180 to 180) required');
    return;
  }
  const key = forecastSiteKey(lat, lon);
  res.apiSuccess({ conditions: getNightConditions(key, night, 'forecast') ?? getNightConditions(key, night, 'archive') });
});

export { router as forecastRouter };
