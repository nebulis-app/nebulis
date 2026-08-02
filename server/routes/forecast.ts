import { Router, Request, Response } from 'express';
import { buildForecast, getForecastCache, setForecastCache, CACHE_TTL_MS } from '../lib/forecastCache.js';
import { resolveSite } from '../lib/observingSites.js';

const router = Router();

// ─── Combined forecast endpoint ─────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === '1';

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
    const lat = site.latitude;
    const lon = site.longitude;

    if (lat === null || lon === null) {
      res.apiError(400, 'INVALID_COORDS', 'Valid latitude (-90 to 90) and longitude (-180 to 180) required');
      return;
    }

    // Serve from cache if fresh and coordinates match
    const cached = getForecastCache();
    if (
      !forceRefresh &&
      cached &&
      cached.lat === lat &&
      cached.lon === lon &&
      Date.now() - cached.fetchedAt < CACHE_TTL_MS
    ) {
      res.apiSuccess(cached.data);
      return;
    }

    // Cache miss or stale — fetch fresh
    const data = await buildForecast(lat, lon);
    setForecastCache({ data, fetchedAt: Date.now(), lat, lon });
    res.apiSuccess(data);
  } catch (err: unknown) {
    // On error, serve stale cache if available
    const cached = getForecastCache();
    if (cached) {
      res.apiSuccess(cached.data);
      return;
    }
    const message = err instanceof Error ? err.message : 'Forecast fetch failed';
    res.apiError(500, 'FORECAST_FAILED', message);
  }
});

export { router as forecastRouter };
