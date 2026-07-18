import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { trailDetector } from '../lib/trailDetector.js';
import { satelliteCatalog } from '../lib/satelliteCatalog.js';
import { satelliteTracker, type ObservationParams } from '../lib/satelliteTracker.js';
import { parseFitsHeader } from '../lib/fitsParser.js';
import { DATA_DIR } from '../lib/paths.js';
import { getLibraryDir } from '../lib/libraryPath.js';
import { requireAdmin } from '../middleware/auth.js';
import { getSessionTelescopeId } from '../lib/localLibrary.js';
import { getProfileById, getSettingsData, type TelescopeKind } from '../lib/telescopes.js';
import { parseFilename, normalizeObjectId, sessionNightFor } from '../lib/telescopeFiles.js';

/**
 * Per-telescope-kind defaults for FITS keywords that may be missing.
 * Used as a fallback when FOCALLEN / XPIXSZ aren't written by the firmware.
 * The previous code hardcoded 250mm (SeeStar S50 only) for every frame,
 * so an S30 import without the keyword silently got an FOV computed at
 * 1.67× the wrong scale, narrowing the candidate filter and rejecting
 * legitimate satellites.
 */
const FITS_DEFAULTS_BY_KIND: Record<TelescopeKind, { focalLenMm: number; pixelSizeUm: number }> = {
  'seestar-s50': { focalLenMm: 250, pixelSizeUm: 2.9 },
  'seestar-s30': { focalLenMm: 150, pixelSizeUm: 2.9 },
  'dwarf-3':     { focalLenMm: 35,  pixelSizeUm: 1.45 },
  'dwarf-2':     { focalLenMm: 100, pixelSizeUm: 1.45 },
  'dwarf-mini':  { focalLenMm: 135, pixelSizeUm: 2.9 },
  'other':       { focalLenMm: 250, pixelSizeUm: 2.9 },
};

/**
 * Resolve telescope-kind defaults for a given file path. Walks the path back
 * to (objectId, sessionDate) → librarySessions.telescopeId → profile.kind.
 * Falls back to seestar-s50 defaults if any step fails — same as before for
 * fresh installs and for paths we can't attribute.
 */
function defaultsForFilePath(filePath: string): { focalLenMm: number; pixelSizeUm: number; kind: TelescopeKind } {
  const fallback = { ...FITS_DEFAULTS_BY_KIND['seestar-s50'], kind: 'seestar-s50' as TelescopeKind };
  try {
    // First path segment is the object folder; the leaf is the FITS filename
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) return fallback;
    const objectId = normalizeObjectId(parts[0]);
    const sessionDate = sessionNightFor(parseFilename(parts[parts.length - 1]));
    if (!sessionDate) return fallback;
    const telescopeId = getSessionTelescopeId(objectId, sessionDate);
    if (!telescopeId) return fallback;
    const profile = getProfileById(telescopeId);
    if (!profile) return fallback;
    const defs = FITS_DEFAULTS_BY_KIND[profile.kind] ?? FITS_DEFAULTS_BY_KIND.other;
    return { ...defs, kind: profile.kind };
  } catch {
    return fallback;
  }
}

/**
 * Convert a trail angle in image-pixel coordinates (the perpendicular axis
 * angle returned by trailDetector.findTrailAngle) into a sky position angle
 * in degrees east of north. Requires a full WCS CD matrix from the FITS
 * header. Returns null when any element is missing — caller should skip
 * the satelliteTracker motion-direction filter in that case rather than
 * compare frames that don't share an axis.
 *
 * The previous code passed the image-pixel angle directly to satelliteTracker,
 * which compares against a sky-PA computed from RA/DEC propagation. Without
 * the WCS rotation, those two angles aren't in the same frame and the
 * 45° tolerance silently rejected genuine candidates whose true sky-PA
 * differed from their image-PA by image flips/rotations alone.
 */
function imageAngleToSkyPA(imageAngleDeg: number, v: Record<string, unknown>): number | null {
  const cd11 = typeof v['CD1_1'] === 'number' ? v['CD1_1'] : null;
  const cd12 = typeof v['CD1_2'] === 'number' ? v['CD1_2'] : null;
  const cd21 = typeof v['CD2_1'] === 'number' ? v['CD2_1'] : null;
  const cd22 = typeof v['CD2_2'] === 'number' ? v['CD2_2'] : null;
  if (cd11 === null || cd12 === null || cd21 === null || cd22 === null) return null;

  const theta = imageAngleDeg * Math.PI / 180;
  // findTrailAngle's `angleDeg` defines the perpendicular axis;
  // the trail itself runs along (-sin θ, cos θ) in pixel space.
  const lineX = -Math.sin(theta);
  const lineY = Math.cos(theta);
  // Apply CD matrix (degrees-per-pixel): pixel deltas → sky deltas.
  // Row 1 is east (RA·cos δ), row 2 is north (DEC).
  const dEast = cd11 * lineX + cd12 * lineY;
  const dNorth = cd21 * lineX + cd22 * lineY;
  const skyPA = Math.atan2(dEast, dNorth) * 180 / Math.PI;
  return ((skyPA % 360) + 360) % 360;
}

const router = Router();

// ─── Detection result cache ─────────────────────────────────────────
// Concurrent scans used to read the full cache, mutate one key, and rewrite the
// whole file — two simultaneous writers raced and clobbered each other's
// detections. We now serialize cache mutation through a single in-process
// queue that re-reads from disk inside the critical section, merges the
// caller's delta, and writes atomically.
const CACHE_FILE = path.join(DATA_DIR, 'satellite-detections.json');

type CachedResult = Record<string, unknown>;

function loadCache(): Record<string, CachedResult> {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

let cacheWriteChain: Promise<void> = Promise.resolve();

function writeCacheAtomic(cache: Record<string, CachedResult>): void {
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

/** Merge `updates` into the on-disk cache. Serialized so concurrent scans
 *  don't lose results to interleaved read-modify-write cycles. Pass `null` as
 *  a value to clear that key; pass an empty object to wipe the cache. */
function updateCache(updates: Record<string, CachedResult | null> | 'clear'): void {
  cacheWriteChain = cacheWriteChain.then(() => {
    try {
      if (updates === 'clear') {
        writeCacheAtomic({});
        return;
      }
      const current = loadCache();
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) delete current[k];
        else current[k] = v;
      }
      writeCacheAtomic(current);
    } catch { /* best-effort */ }
  });
}

// ─── Detect satellite trail in a FITS file ──────────────────────────
router.post('/detect', requireAdmin, async (req: Request, res: Response) => {
  try {
    const LIBRARY_DIR = getLibraryDir();
    const { filePath, skipCache, identifyOnly, overrideLat, overrideLon } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      res.apiError(400, 'MISSING_PATH', 'filePath is required');
      return;
    }

    // Check cache first (only for full detection, not identify-only)
    if (!skipCache && !identifyOnly) {
      const cache = loadCache();
      const cached = cache[filePath];
      if (cached) {
        res.apiSuccess({ ...cached, cached: true });
        return;
      }
    }

    // Read the FITS file — relative paths (ObjectName/file.fits) come from the
    // local library. Absolute paths used to be passed to smbGetFile directly,
    // which allowed an admin client to coax the server into reading from
    // arbitrary SMB shares (\\evil-server\share\...) and other absolute paths.
    // Restrict to relative library paths only.
    let fileBuffer: Buffer;
    if (path.isAbsolute(filePath) || filePath.includes('..')) {
      res.apiError(400, 'INVALID_PATH', 'filePath must be a relative library path');
      return;
    }
    const localPath = path.resolve(LIBRARY_DIR, filePath);
    if (!localPath.startsWith(LIBRARY_DIR + path.sep) && localPath !== LIBRARY_DIR) {
      res.apiError(403, 'FORBIDDEN', 'Invalid file path');
      return;
    }
    fileBuffer = await fs.promises.readFile(localPath);

    // Step 1: Detect trail (skip when user only wants identification)
    // trailResult is hoisted so it is in scope for the response object below
    let trailResult: ReturnType<typeof trailDetector.detect> | undefined;
    if (!identifyOnly) {
      trailResult = trailDetector.detect(fileBuffer);
      if (!trailResult.trailDetected) {
        const noTrail = { trailDetected: false as const };
        updateCache({ [filePath]: noTrail });
        res.apiSuccess(noTrail);
        return;
      }
    }

    // Step 2: Extract observation metadata from FITS header
    // SeeStar uses various key names, so check many variants
    const header = parseFitsHeader(fileBuffer);
    const v = header.values;

    const rawDateObs = v['DATE-OBS'] ?? v['DATE_OBS'] ?? v['DATE'];
    const dateObs = typeof rawDateObs === 'string' ? rawDateObs : undefined;
    const rawExpTime = v['EXPTIME'] ?? v['EXPOSURE'] ?? v['EXP'];
    const expTime = typeof rawExpTime === 'number' ? rawExpTime : undefined;
    const ra = v['RA'] ?? v['OBJCTRA'] ?? v['CRVAL1'] ?? v['RA_OBJ'];
    const dec = v['DEC'] ?? v['OBJCTDEC'] ?? v['CRVAL2'] ?? v['DEC_OBJ'];

    // Resolution order for observer coordinates:
    //   1. FITS headers (SeeStar writes SITELAT/SITELONG; others use variants)
    //   2. App settings (user-configured location for planning/forecasting)
    //   3. Client-supplied override (from browser geolocation popup)
    let obsLat: unknown = v['OBS-LAT'] ?? v['SITELAT'] ?? v['LAT-OBS'] ?? v['OBSLAT'] ?? v['LATITUDE'];
    let obsLon: unknown = v['OBS-LONG'] ?? v['SITELONG'] ?? v['LONG-OBS'] ?? v['OBSLONG'] ?? v['LONGITUD'];
    if (obsLat == null || obsLon == null) {
      const settings = getSettingsData();
      if (typeof settings.latitude === 'number') obsLat = settings.latitude;
      if (typeof settings.longitude === 'number') obsLon = settings.longitude;
    }
    if ((obsLat == null || obsLon == null) && typeof overrideLat === 'number' && typeof overrideLon === 'number') {
      obsLat = overrideLat;
      obsLon = overrideLon;
    }

    // Compute FOV from FITS headers (NAXIS1/2 in pixels, FOCALLEN in mm,
    // XPIXSZ/YPIXSZ in μm). Defaults fall back to per-kind values resolved
    // from the originating telescope, not a hardcoded SeeStar S50 250mm —
    // that matters for any frame the SeeStar firmware doesn't fully tag,
    // since an S30 (150mm) silently came out 1.67× off otherwise.
    const fitsDefaults = defaultsForFilePath(filePath);
    const naxis1 = typeof v['NAXIS1'] === 'number' ? v['NAXIS1'] : 1080;
    const naxis2 = typeof v['NAXIS2'] === 'number' ? v['NAXIS2'] : 1920;
    const focalLenMm = typeof v['FOCALLEN'] === 'number' ? v['FOCALLEN'] : fitsDefaults.focalLenMm;
    const pixelSizeXUm = typeof v['XPIXSZ'] === 'number' ? v['XPIXSZ'] : fitsDefaults.pixelSizeUm;
    const pixelSizeYUm = typeof v['YPIXSZ'] === 'number' ? v['YPIXSZ'] : pixelSizeXUm;
    const arcsecPerPixelX = (pixelSizeXUm / 1000 / focalLenMm) * (180 / Math.PI) * 3600;
    const arcsecPerPixelY = (pixelSizeYUm / 1000 / focalLenMm) * (180 / Math.PI) * 3600;
    const fovWidthDeg = (naxis1 * arcsecPerPixelX) / 3600;
    const fovHeightDeg = (naxis2 * arcsecPerPixelY) / 3600;

    // Try to identify satellites if we have enough metadata
    let candidates: unknown[] = [];
    let nearMissFallback = false;
    const locationRequired = obsLat == null || obsLon == null;
    const missingFields: string[] = [];
    if (!dateObs) missingFields.push('DATE-OBS');
    if (expTime === undefined) missingFields.push('EXPTIME');
    if (ra === undefined) missingFields.push('RA');
    if (dec === undefined) missingFields.push('DEC');
    // OBS-LAT / OBS-LONG are reported via locationRequired, not missingFields,
    // so the client can show the geolocation prompt instead of a generic error.

    let tleArchiveUnavailable = false;

    if (missingFields.length === 0 && !locationRequired && dateObs !== undefined && expTime !== undefined) {
      const raNum = typeof ra === 'string' ? parseRaToDegs(ra) : typeof ra === 'number' ? ra : 0;
      const decNum = typeof dec === 'string' ? parseDecToDegs(dec) : typeof dec === 'number' ? dec : 0;
      const latNum = typeof obsLat === 'string' ? parseFloat(obsLat) : typeof obsLat === 'number' ? obsLat : 0;
      const lonNum = typeof obsLon === 'string' ? parseFloat(obsLon) : typeof obsLon === 'number' ? obsLon : 0;

      // Load the TLE catalog closest to the observation date for accurate identification
      const obsDate = new Date(dateObs.endsWith('Z') ? dateObs : dateObs + 'Z');
      let tleRecords = await satelliteCatalog.loadCatalogForDate(obsDate);
      if (!tleRecords) {
        // No archive within range — fall back to current catalog but flag it
        const ageDays = Math.abs(Date.now() - obsDate.getTime()) / 86400000;
        if (ageDays > 7) {
          tleArchiveUnavailable = true;
        }
        tleRecords = await satelliteCatalog.loadCatalog();
      }

      // Pass detectedTrailAngle only when the FITS header has a full WCS CD
      // matrix that lets us convert image-pixel angle to sky position angle.
      // satelliteTracker compares the trail angle against motionAngle, which
      // is computed in sky-PA from RA/DEC propagation; without the rotation,
      // these aren't in the same frame and the 45° tolerance silently
      // rejected legitimate candidates. Skipping the filter when WCS is
      // unavailable preserves correctness — the closest-approach scoring
      // still ranks the right satellite first.
      const trailSkyPA = trailResult?.angleDegrees != null
        ? imageAngleToSkyPA(trailResult.angleDegrees, v)
        : null;

      const identParams: ObservationParams = {
        timestamp: dateObs,
        exposureSeconds: expTime,
        observerLat: latNum,
        observerLon: lonNum,
        imageCenterRA: raNum,
        imageCenterDEC: decNum,
        fovWidthDeg,
        fovHeightDeg,
        detectedTrailAngle: trailSkyPA ?? undefined,
      };
      try {
        const result = await satelliteTracker.identifySatelliteTrail(identParams, tleRecords);
        const expStartMs = obsDate.getTime();
        const expEndMs = expStartMs + expTime * 1000;
        candidates = result.candidates.map(c => ({
          ...c,
          duringExposure:
            new Date(c.crossingTimeUTC).getTime() >= expStartMs &&
            new Date(c.crossingTimeUTC).getTime() <= expEndMs,
        }));
        nearMissFallback = result.nearMissFallback;
      } catch (err) {
        console.error('Satellite identification error:', err);
      }
    }

    const detectedTrail = trailResult;
    const exposureStartUTC = dateObs
      ? (dateObs.endsWith('Z') ? dateObs : dateObs + 'Z')
      : undefined;
    const result = {
      trailDetected: true as const,
      identifyOnly: identifyOnly ?? false,
      angleDegrees: detectedTrail?.angleDegrees,
      lengthPixels: detectedTrail?.lengthPixels,
      midpoint: detectedTrail?.midpoint,
      endpoints: detectedTrail?.endpoints,
      confidence: detectedTrail?.confidence,
      profileWidth: detectedTrail?.profileWidth,
      exposureStart: exposureStartUTC,
      exposureSeconds: expTime ?? undefined,
      candidates,
      nearMissFallback,
      locationRequired: locationRequired || undefined,
      missingHeaders: missingFields.length > 0 ? missingFields : undefined,
      tleArchiveUnavailable: tleArchiveUnavailable || undefined,
    };

    // Don't cache when location was missing — once the user sets their location
    // (in app settings or via the geolocation prompt), the next scan should
    // re-identify without needing skipCache=true.
    if (!locationRequired) {
      updateCache({ [filePath]: result });
    }

    res.apiSuccess(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Trail detection failed';
    res.apiError(500, 'DETECTION_FAILED', message);
  }
});

// ─── Get cached results for specific file paths ─────────────────────
router.post('/results', requireAdmin, (req: Request, res: Response) => {
  try {
    const { filePaths } = req.body as { filePaths?: string[] };
    if (!filePaths || !Array.isArray(filePaths)) {
      res.apiError(400, 'MISSING_PATHS', 'filePaths array is required');
      return;
    }
    const cache = loadCache();
    const results: Record<string, CachedResult> = {};
    for (const fp of filePaths) {
      if (cache[fp]) results[fp] = cache[fp];
    }
    res.apiSuccess(results);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to read cache';
    res.apiError(500, 'CACHE_ERROR', message);
  }
});

// ─── Get TLE catalog status ─────────────────────────────────────────
router.get('/catalog/status', async (_req: Request, res: Response) => {
  try {
    const catalog = await satelliteCatalog.loadCatalog();
    res.apiSuccess({
      count: catalog.length,
      lastFetch: satelliteCatalog.getLastFetch()?.toISOString() || null,
      isStale: satelliteCatalog.isUsingStaleFallback(),
      archiveRange: satelliteCatalog.getArchiveRange(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load catalog';
    res.apiError(500, 'CATALOG_ERROR', message);
  }
});

// ─── Refresh TLE catalog ────────────────────────────────────────────
router.post('/catalog/refresh', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const catalog = await satelliteCatalog.fetchFromCelestrak();
    res.apiSuccess({
      count: catalog.length,
      refreshed: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to refresh catalog';
    res.apiError(500, 'REFRESH_FAILED', message);
  }
});

// ─── Clear detection cache ───────────────────────────────────────────
router.delete('/cache', requireAdmin, (_req: Request, res: Response) => {
  try {
    updateCache('clear');
    res.apiSuccess({ cleared: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to clear cache';
    res.apiError(500, 'CACHE_ERROR', message);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

function parseRaToDegs(ra: string): number {
  const m = ra.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/i);
  if (m) {
    const hours = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
    return hours * 15;
  }
  const num = parseFloat(ra);
  return isNaN(num) ? 0 : num;
}

function parseDecToDegs(dec: string): number {
  const m = dec.match(/([+-]?)(\d+)[°]\s*(\d+)[′']\s*([\d.]+)[″"]/);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseFloat(m[2]) + parseFloat(m[3]) / 60 + parseFloat(m[4]) / 3600);
  }
  const num = parseFloat(dec);
  return isNaN(num) ? 0 : num;
}

export { router as satelliteRouter };
