import { Router, Request, Response } from 'express';
import { buildForecast, getForecastCache, setForecastCache, CACHE_TTL_MS } from '../lib/forecastCache.js';

const router = Router();

// ─── Combined forecast endpoint ─────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(String(req.query.lat || ''));
    const lon = parseFloat(String(req.query.lon || ''));
    const forceRefresh = req.query.refresh === '1';

    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
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
