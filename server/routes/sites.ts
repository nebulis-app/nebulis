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
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';
import { randomUUID } from 'crypto';
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
import {
  SITE_PHOTO_LIMITS,
  SitePhotoError,
  addSitePhoto,
  deleteSitePhoto,
  getSitePhotoFile,
  getSitePhotoPreview,
  listSitePhotos,
  setSitePhotoCaption,
} from '../lib/sitePhotos.js';
import { contentDispositionHeader } from '../lib/queryHelpers.js';
import { log } from '../lib/logger.js';
import { isRecord } from '../lib/typeGuards.js';

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

// ─── Site pictures ──────────────────────────────────────────────────────────
// Declared before the /:id routes so "photos" is never read as a site id.

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, `nebulis_sitephoto_${randomUUID()}`),
  }),
  limits: { fileSize: SITE_PHOTO_LIMITS.bytes, files: 1 },
});

function photoFail(res: Response, err: unknown): void {
  if (err instanceof SitePhotoError) {
    res.apiError(err.code === 'NOT_FOUND' ? 404 : 422, err.code, err.message);
    return;
  }
  throw err;
}

// GET /api/v1/sites/photos/:photoId?w=480   The picture; `w` asks for a JPEG preview no wider than that.
router.get('/photos/:photoId', async (req: Request, res: Response) => {
  const id = String(req.params.photoId);
  const width = Number(req.query.w);
  if (Number.isFinite(width) && width > 0) {
    const preview = await getSitePhotoPreview(id, width);
    if (preview) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.sendFile(preview.filePath, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.apiError(404, 'NOT_FOUND', 'Picture not found');
      });
      return;
    }
  }
  const found = getSitePhotoFile(id);
  if (!found) {
    res.apiError(404, 'NOT_FOUND', 'Picture not found');
    return;
  }
  res.setHeader('Content-Type', found.photo.mimeType);
  res.setHeader('Content-Disposition', contentDispositionHeader(req.query.download === '1' ? 'attachment' : 'inline', found.photo.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // The data folder may sit under a dot-folder (a Docker volume, ~/.nebulis), which sendFile refuses by default.
  res.sendFile(found.filePath, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.apiError(404, 'NOT_FOUND', 'Picture not found');
  });
});

// PUT /api/v1/sites/photos/:photoId   { caption }
router.put('/photos/:photoId', requireAdmin, (req: Request, res: Response) => {
  const parsed = z.object({ caption: z.string().max(SITE_PHOTO_LIMITS.caption) }).safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  try { res.apiSuccess(setSitePhotoCaption(String(req.params.photoId), parsed.data.caption)); } catch (err) { photoFail(res, err); }
});

// DELETE /api/v1/sites/photos/:photoId
router.delete('/photos/:photoId', requireAdmin, (req: Request, res: Response) => {
  if (!deleteSitePhoto(String(req.params.photoId))) {
    res.apiError(404, 'NOT_FOUND', 'Picture not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

// GET /api/v1/sites/:id/photos
router.get('/:id/photos', (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!getSite(id)) {
    res.apiError(404, 'NOT_FOUND', 'Observing site not found');
    return;
  }
  res.apiSuccess(listSitePhotos(id));
});

// POST /api/v1/sites/:id/photos   multipart: one picture in "file", optional "caption"
router.post('/:id/photos', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  photoUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      res.apiError(tooBig ? 413 : 400, tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
        tooBig ? `Pictures can be up to ${SITE_PHOTO_LIMITS.bytes / 1024 / 1024} MB` : 'The upload could not be read');
      return;
    }
    next();
  });
}, (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.apiError(400, 'VALIDATION_ERROR', 'No picture was sent');
    return;
  }
  const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';
  try {
    res.apiSuccess(addSitePhoto(String(req.params.id), {
      tempPath: file.path, fileName: file.originalname, mimeType: file.mimetype, size: file.size, caption,
    }));
  } catch (err) { photoFail(res, err); }
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

// ── Bortle class lookup via DarkSkySites ────────────────────────────────────
//
// Proxies darkskysites.com's site-intelligence endpoint, which turns the monthly
// VIIRS satellite composite into a Bortle class and an SQM reading for any
// coordinate. No API key.
//
// Proxied rather than called from the browser for three reasons: it avoids
// CORS, one 24-hour cache absorbs repeat visits (the underlying data is a
// monthly composite, so it cannot change faster than that), and the upstream
// error handling stays in one place.
//
// This is the only outbound request Nebulis makes carrying the observer's
// coordinates. The client only fires it for admins, but the route enforces that
// too rather than trusting the caller, since what leaves the machine is the
// exact location of someone's telescope. It is disclosed on the Help page and
// in Settings -> Data Sources.

/** Coordinates are rounded to four decimals before they key the cache: about
 *  11 m at the equator, far finer than a VIIRS cell, so two sites in the same
 *  neighbourhood share one lookup instead of each paying for its own. */
const BORTLE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
/** Bound on distinct coordinates held at once. An install that moves between
 *  many sites over months would otherwise grow this without limit. */
const BORTLE_CACHE_LIMIT = 500;

interface BortleCacheEntry { bortleClass: number; sqm: number; fetchedAt: number }
const bortleCache = new Map<string, BortleCacheEntry>();

function readBortleCache(key: string): BortleCacheEntry | null {
  const hit = bortleCache.get(key);
  if (!hit) return null;
  // Drop the entry on read rather than letting expired rows accumulate.
  if (Date.now() - hit.fetchedAt >= BORTLE_CACHE_TTL_MS) {
    bortleCache.delete(key);
    return null;
  }
  return hit;
}

function writeBortleCache(key: string, entry: BortleCacheEntry): void {
  if (!bortleCache.has(key) && bortleCache.size >= BORTLE_CACHE_LIMIT) {
    // Map iterates in insertion order, so this is the oldest.
    const oldest = bortleCache.keys().next().value;
    if (oldest !== undefined) bortleCache.delete(oldest);
  }
  bortleCache.set(key, entry);
}

router.post('/:id/bortle-lookup', requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const site = getSite(id);
  if (!site) {
    res.apiError(404, 'NOT_FOUND', 'Observing site not found');
    return;
  }
  if (site.latitude == null || site.longitude == null) {
    res.apiError(400, 'NO_COORDINATES', 'This site has no coordinates yet. Set a latitude and longitude first.');
    return;
  }

  const cacheKey = `${site.latitude.toFixed(4)},${site.longitude.toFixed(4)}`;
  const cached = readBortleCache(cacheKey);
  if (cached) {
    res.apiSuccess({ bortleClass: cached.bortleClass, sqm: cached.sqm, source: 'cache' });
    return;
  }

  // Both values are numbers by this point, so nothing user-supplied reaches the
  // query string unescaped.
  const url = `https://darkskysites.com/api/site-intelligence`
    + `?lat=${site.latitude.toFixed(6)}&lng=${site.longitude.toFixed(6)}`;

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Nebulis (https://nebulis.app)', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!upstream.ok) {
      log.warn({ siteId: id, status: upstream.status }, '[bortle] upstream returned a non-OK status');
      res.apiError(502, 'UPSTREAM_ERROR', 'The light pollution service did not answer. Try again later.');
      return;
    }

    const body: unknown = await upstream.json();
    const payload = isRecord(body) ? body.payload : undefined;
    const metrics = isRecord(payload) && isRecord(payload.metrics) ? payload.metrics : undefined;
    const rawClass = metrics?.bortleClass;
    const sqm = metrics?.sqm;
    const bortleClass = typeof rawClass === 'number' ? Math.round(rawClass) : NaN;

    // The site schema accepts 1-9 only, and the client writes this result back
    // through PUT /sites/:id. Rejecting an out-of-range value here keeps a
    // surprising upstream answer from turning into a 422 on the write-back.
    if (!Number.isFinite(bortleClass) || bortleClass < 1 || bortleClass > 9 || typeof sqm !== 'number' || !Number.isFinite(sqm)) {
      log.warn({ siteId: id, bortleClass: rawClass, sqm }, '[bortle] upstream returned an unexpected shape');
      res.apiError(502, 'UPSTREAM_ERROR', 'The light pollution service returned something unexpected.');
      return;
    }

    const entry: BortleCacheEntry = { bortleClass, sqm, fetchedAt: Date.now() };
    writeBortleCache(cacheKey, entry);
    res.apiSuccess({ bortleClass, sqm, source: 'live' });
  } catch (err) {
    // Logged, never returned: a fetch failure can name an internal host or
    // path, and the client can do nothing useful with it.
    log.warn({ siteId: id, err }, '[bortle] lookup failed');
    res.apiError(502, 'UPSTREAM_ERROR', 'Could not reach the light pollution service. Check that this machine can reach the internet.');
  }
});

export { router as sitesRouter };
