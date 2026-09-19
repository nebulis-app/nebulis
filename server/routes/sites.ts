/**
 * Observing sites — CRUD for the places (and skies) the user observes from,
 * plus which one is currently active.
 *
 * Backed by server/lib/observingSites.ts. See that module's doc comment for
 * the appSettings-mirror contract that keeps native clients working without
 * changes: the default site is always projected onto the legacy
 * latitude/longitude/locationName/timezone/minAlt/horizonProfile/visibleSkyMap
 * fields on GET /settings.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import {
  listSites,
  getSite,
  getActiveSite,
  setActiveSite,
  createSite,
  updateSite,
  deleteSite,
  setDefaultSite,
  type ObservingSite,
} from '../lib/observingSites.js';
import { SKY_MAP_CELLS } from '../lib/skyMapConfig.js';

const router = Router();

const SiteBodySchema = z.object({
  name: z.string().min(1).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  timezone: z.string().optional(),
  minAlt: z.number().min(0).max(90).optional(),
  horizonProfile: z.array(z.number()).length(36).optional(),
  visibleSkyMap: z.array(z.boolean()).length(SKY_MAP_CELLS).optional(),
  bortleClass: z.number().int().min(1).max(9).nullable().optional(),
  isDefault: z.boolean().optional(),
});

function present(site: ObservingSite) {
  return site;
}

// List every site, active-first ordering left to the client (sortOrder is the
// display order; activeSiteId is a separate concept surfaced via /sites/active).
router.get('/', (_req: Request, res: Response) => {
  res.apiSuccess(listSites().map(present));
});

router.get('/active', (_req: Request, res: Response) => {
  res.apiSuccess(present(getActiveSite()));
});

router.put('/active', requireAdmin, (req: Request, res: Response) => {
  const parsed = z.object({ siteId: z.string().nullable() }).safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  try {
    setActiveSite(parsed.data.siteId);
  } catch (err) {
    res.apiError(404, 'NOT_FOUND', err instanceof Error ? err.message : 'Unknown site');
    return;
  }
  res.apiSuccess(present(getActiveSite()));
});

router.get('/:id', (req: Request, res: Response) => {
  const site = getSite(String(req.params.id));
  if (!site) {
    res.apiError(404, 'NOT_FOUND', 'Observing site not found');
    return;
  }
  res.apiSuccess(present(site));
});

router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = SiteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const site = createSite(parsed.data);
  res.apiSuccess(present(site));
});

router.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = SiteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  // isDefault is not settable through the generic update — use PUT /:id/default,
  // whose clear-then-set has to be one transaction (see observingSites.ts).
  const { isDefault: _ignored, ...rest } = parsed.data;
  const updated = updateSite(id, rest);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Observing site not found');
    return;
  }
  res.apiSuccess(present(updated));
});

router.put('/:id/default', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!setDefaultSite(id)) {
    res.apiError(404, 'NOT_FOUND', 'Observing site not found');
    return;
  }
  const site = getSite(id);
  res.apiSuccess(site ? present(site) : null);
});

router.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const result = deleteSite(id);
  if (!result.deleted) {
    if (result.reason === 'last-site') {
      res.apiError(400, 'LAST_SITE', 'Cannot delete the last observing site. Add another first.');
    } else {
      res.apiError(404, 'NOT_FOUND', 'Observing site not found');
    }
    return;
  }
  res.apiSuccess({ deleted: true, id });
});

// ── Bortle class lookup via DarkSkySites.com ───────────────────────────────
//
// Proxies GET /api/site-intelligence?lat=&lng= from darkskysites.com, which
// returns monthly VIIRS satellite data converted to Bortle class + SQM for
// any lat/lng. No API key required.
//
// We proxy server-side to:
//   1. Avoid CORS restrictions in the browser.
//   2. Apply a 24-hour in-memory cache so repeated requests from the same
//      site don't re-hit the external API (the underlying data is a monthly
//      VIIRS composite — it never changes more frequently than that).
//   3. Surface a clean, consistent error to the frontend.
//
// POST (not GET) so the browser never caches this or fires it speculatively.
// requireAdmin: writing the result back to the site is admin-only anyway.

interface BortleCacheEntry { bortleClass: number; sqm: number; fetchedAt: number }
const bortleCache = new Map<string, BortleCacheEntry>();
const BORTLE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 h

router.post('/:id/bortle-lookup', requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const site = getSite(id) as ObservingSite | null;
  if (!site) {
    res.apiError(404, 'NOT_FOUND', 'Observing site not found');
    return;
  }
  if (site.latitude == null || site.longitude == null) {
    res.apiError(400, 'NO_COORDINATES', 'Site has no coordinates — set latitude and longitude first.');
    return;
  }

  const cacheKey = `${site.latitude.toFixed(4)},${site.longitude.toFixed(4)}`;
  const cached = bortleCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < BORTLE_CACHE_TTL_MS) {
    res.apiSuccess({ bortleClass: cached.bortleClass, sqm: cached.sqm, source: 'cache' });
    return;
  }

  try {
    const url = `https://darkskysites.com/api/site-intelligence?lat=${site.latitude.toFixed(6)}&lng=${site.longitude.toFixed(6)}`;
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Nebulis/1.0 (https://nebulis.app - astrophotography companion)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!upstream.ok) {
      res.apiError(502, 'UPSTREAM_ERROR', `DarkSkySites returned HTTP ${upstream.status}`);
      return;
    }

    const json = await upstream.json() as {
      payload?: { metrics?: { bortleClass?: number; sqm?: number } };
    };
    const metrics = json?.payload?.metrics;
    if (typeof metrics?.bortleClass !== 'number' || typeof metrics?.sqm !== 'number') {
      res.apiError(502, 'UPSTREAM_ERROR', 'Unexpected response shape from DarkSkySites');
      return;
    }

    const entry: BortleCacheEntry = {
      bortleClass: metrics.bortleClass,
      sqm: metrics.sqm,
      fetchedAt: Date.now(),
    };
    bortleCache.set(cacheKey, entry);

    res.apiSuccess({ bortleClass: entry.bortleClass, sqm: entry.sqm, source: 'live' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[bortle-lookup] fetch failed:', msg);
    res.apiError(502, 'UPSTREAM_ERROR', `Could not reach DarkSkySites: ${msg}`);
  }
});

export { router as sitesRouter };
