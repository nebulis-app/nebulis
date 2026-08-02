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

export { router as sitesRouter };
