import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { trailDetector, type TrailDetected } from '../lib/trailDetector.js';
import { satelliteCatalog } from '../lib/satelliteCatalog.js';
import { satelliteTracker, normalizeObservationTimestamp, type ObservationParams } from '../lib/satelliteTracker.js';
import { parseFitsHeader } from '../lib/fitsParser.js';
import { DATA_DIR } from '../lib/paths.js';
import { getLibraryDir } from '../lib/libraryPath.js';
import { requireAdmin } from '../middleware/auth.js';
import { getSessionTelescopeId } from '../lib/localLibrary.js';
import { getProfileById, type TelescopeKind } from '../lib/telescopes.js';
import { getActiveSite } from '../lib/observingSites.js';
import { parseFilename, normalizeObjectId, sessionNightFor } from '../lib/telescopeFiles.js';
import { isRecord } from '../lib/typeGuards.js';
import {
  parseRaToDegs,
  parseDecToDegs,
  headerNumber,
  readCdMatrix,
  imageAngleToSkyPA,
  sensorRotationFromCd,
} from '../lib/fitsWcs.js';

/**
 * Per-telescope-kind defaults for FITS keywords that may be missing.
 * Used as a fallback when FOCALLEN / XPIXSZ aren't written by the firmware.
 * The previous code hardcoded 250mm (SeeStar S50 only) for every frame,
 * so an S30 import without the keyword silently got an FOV computed at
 * 1.67× the wrong scale, narrowing the candidate filter and rejecting
 * legitimate satellites.
 */
const FITS_DEFAULTS_BY_KIND: Record<TelescopeKind, { focalLenMm: number; pixelSizeUm: number }> = {
  'seestar-s50':     { focalLenMm: 250, pixelSizeUm: 2.9 },
  'seestar-s50-pro': { focalLenMm: 260, pixelSizeUm: 2.9 },
  'seestar-s30':     { focalLenMm: 150, pixelSizeUm: 2.9 },
  // S30 Pro: 160mm apochromatic telephoto over a 1/1.2" 3840x2160 sensor
  // (Sony IMX585, 2.9um pixels). The wide 6mm camera is a framing finder and
  // never imports as science frames, so only the telephoto optic matters here.
  'seestar-s30-pro': { focalLenMm: 160, pixelSizeUm: 2.9 },
  'dwarf-3':         { focalLenMm: 35,  pixelSizeUm: 1.45 },
  'dwarf-2':         { focalLenMm: 100, pixelSizeUm: 1.45 },
  'dwarf-mini':      { focalLenMm: 135, pixelSizeUm: 2.9 },
  // ASIAIR is a controller, not a fixed optic: focal length and pixel size are
  // whatever telescope and camera the user bolted together, so there is no
  // correct per-kind value. This barely matters in practice, because ASIAIR
  // writes real FOCALLEN and XPIXSZ into every frame and this table is only a
  // fallback for headers that lack them. The placeholder is a common pairing
  // (a 400mm refractor with an ASI2600-class 3.76um sensor) rather than a
  // pretend-precise number.
  'asiair':          { focalLenMm: 400, pixelSizeUm: 3.76 },
  'other':           { focalLenMm: 250, pixelSizeUm: 2.9 },
};

/**
 * Per-kind imaging field, in degrees, for frames whose header carries no
 * NAXIS1/NAXIS2 at all (both are otherwise-mandatory FITS keywords, so this
 * only fires on a malformed/truncated header reached via the identifyOnly
 * path, which parses just the header rather than the full pixel array).
 *
 * Used instead of guessing a pixel count: NAXIS1/2 only exist in this file to
 * get multiplied by the per-kind plate scale into a FOV in degrees, so with
 * no real pixel count to multiply, reconstructing one (from an assumed
 * resolution) and then converting back to degrees compounds two guesses when
 * one will do. Values mirror FOV_PROFILES in src/lib/telescopeFov.ts (kept as
 * a separate, server-side copy since server code doesn't import from src/) —
 * same caveat applies: approximate, verify against the manufacturer spec
 * sheet before trusting any single value.
 */
const FOV_DEFAULTS_BY_KIND: Record<TelescopeKind, { widthDeg: number; heightDeg: number }> = {
  'seestar-s50':     { widthDeg: 1.28, heightDeg: 0.73 },
  'seestar-s50-pro': { widthDeg: 1.23, heightDeg: 0.70 },
  'seestar-s30':     { widthDeg: 2.14, heightDeg: 1.22 },
  // 11.14mm x 6.26mm sensor at 160mm: 3.99 x 2.24 deg, 4.6 deg diagonal (matches ZWO's spec).
  'seestar-s30-pro': { widthDeg: 3.99, heightDeg: 2.24 },
  'dwarf-3':         { widthDeg: 2.94, heightDeg: 1.65 },
  'dwarf-2':         { widthDeg: 3.20, heightDeg: 1.80 },
  'dwarf-mini':      { widthDeg: 2.90, heightDeg: 1.63 },
  // Derived from the same placeholder rig as FITS_DEFAULTS_BY_KIND above, for
  // the same reason: an ASIAIR has no inherent field of view. See the note
  // there before treating this as a real number for any particular setup.
  'asiair':          { widthDeg: 3.36, heightDeg: 2.25 },
  'other':           { widthDeg: 1.28, heightDeg: 0.73 },
};

/**
 * Resolve telescope-kind defaults for a given file path. Walks the path back
 * to (objectId, sessionDate) → librarySessions.telescopeId → profile.kind.
 * Falls back to seestar-s50 defaults if any step fails — same as before for
 * fresh installs and for paths we can't attribute.
 */
function defaultsForFilePath(filePath: string): { focalLenMm: number; pixelSizeUm: number; kind: TelescopeKind } {
  // Annotated rather than asserted: the annotation checks 'seestar-s50'
  // against TelescopeKind instead of the assertion widening it, so removing
  // that kind from the union would be a compile error here.
  const fallback: { focalLenMm: number; pixelSizeUm: number; kind: TelescopeKind } =
    { ...FITS_DEFAULTS_BY_KIND['seestar-s50'], kind: 'seestar-s50' };
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
 * Number of track samples kept per candidate in the response and the on-disk
 * cache. The track is drawn as a path, so a few dozen points are visually
 * indistinguishable from hundreds.
 *
 * The tracker samples finely enough to catch a sub-degree transit — up to 400
 * points per candidate — and every point used to be serialized into
 * satellite-detections.json, which is read, parsed and rewritten in full for
 * each scanned file. Ten candidates × hundreds of points × hundreds of files
 * turned a session scan into a multi-hundred-megabyte file rewritten once per
 * frame.
 */
const MAX_TRACK_POINTS = 48;

/** Uniformly decimate a track to at most MAX_TRACK_POINTS, always keeping the
 *  first and last sample so the drawn path still spans the real extent. */
function thinTrack<T>(track: T[]): T[] {
  if (track.length <= MAX_TRACK_POINTS) return track;
  const out: T[] = [];
  const stride = (track.length - 1) / (MAX_TRACK_POINTS - 1);
  for (let i = 0; i < MAX_TRACK_POINTS; i++) {
    out.push(track[Math.round(i * stride)]);
  }
  return out;
}

const router = Router();

// ─── Detection result cache ─────────────────────────────────────────
// Concurrent scans used to read the full cache, mutate one key, and rewrite the
// whole file — two simultaneous writers raced and clobbered each other's
// detections. We now serialize cache mutation through a single in-process
// queue that re-reads from disk inside the critical section, merges the
// caller's delta, and writes atomically.
const CACHE_FILE = path.join(DATA_DIR, 'satellite-detections.json');

/**
 * Bump whenever a change to the detector or the tracker would give a different
 * answer for the same file. Entries stamped with an older version are dropped
 * on read, so an upgrade cannot leave users looking at results the current
 * code would never produce — the failure mode the manual "Clear detection
 * cache" button exists to undo, but only for users who know to press it.
 *
 * 2: trail width no longer masked as a star; star-mask padding decoupled from
 *    sensor resolution; 45/135 dead band on square sensors; angular length
 *    floor; reported angle is now the trail direction rather than its normal;
 *    sexagesimal RA/DEC; window-wide satellite search; FOV rotation.
 * 3: a plain detect() call (identifyOnly: false) no longer runs satellite
 *    identification automatically — it always used to, so every cached entry
 *    from before this version may carry `candidates` that were never asked
 *    for by anything reading them (see the "Identify Satellite" button,
 *    which never trusted this data and re-fetched fresh anyway). Not a
 *    different trailDetected/confidence/angle answer, but a different
 *    response shape for the same file, which the cache-version contract
 *    treats the same way.
 * 4: star masking now requires actual elongation (MIN_ELONGATION_RATIO), not
 *    just linearity + a size floor. A moderately large, moderately bright,
 *    perfectly ROUND star can clear both of those (linearity ≈ 1.1·r for a
 *    disk of radius r; a bbox just past the 20px floor needs no exotic
 *    brightness) despite having zero actual elongation — confirmed on real
 *    frames where a saturated star (elongation 1.06, i.e. a near-perfect
 *    circle) was left unmasked and scored a 27% confidence "trail" with an
 *    endpoint 12px from its center. Files previously reporting a low-
 *    confidence trail near a bright star may now report none.
 */
const CACHE_VERSION = 4;
const CACHE_VERSION_KEY = '__cacheVersion';

type CachedResult = Record<string, unknown>;

function loadCache(): Record<string, CachedResult> {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (!isRecord(parsed)) return {};
      if (parsed[CACHE_VERSION_KEY] !== CACHE_VERSION) return {};
      const out: Record<string, CachedResult> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k !== CACHE_VERSION_KEY && isRecord(v)) out[k] = v;
      }
      return out;
    }
  } catch { /* ignore */ }
  return {};
}

let cacheWriteChain: Promise<void> = Promise.resolve();

function writeCacheAtomic(cache: Record<string, CachedResult>): void {
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ [CACHE_VERSION_KEY]: CACHE_VERSION, ...cache }, null, 2));
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
    if (path.isAbsolute(filePath) || filePath.includes('..')) {
      res.apiError(400, 'INVALID_PATH', 'filePath must be a relative library path');
      return;
    }
    const localPath = path.resolve(LIBRARY_DIR, filePath);
    if (!localPath.startsWith(LIBRARY_DIR + path.sep) && localPath !== LIBRARY_DIR) {
      res.apiError(403, 'FORBIDDEN', 'Invalid file path');
      return;
    }
    const fileBuffer = await fs.promises.readFile(localPath);

    // Step 1: Read the FITS header FIRST.
    //
    // Detection used to run before this, but the detector's minimum-trail-length
    // rule needs the plate scale to be expressed on the sky rather than as a
    // fraction of whatever sensor took the picture. Parsing the header is
    // header-only work (no pixel decode), so doing it first costs nothing.
    const header = parseFitsHeader(fileBuffer);
    const v = header.values;

    const rawDateObs = v['DATE-OBS'] ?? v['DATE_OBS'] ?? v['DATE'];
    const dateObs = typeof rawDateObs === 'string' ? rawDateObs : undefined;
    const expTime = headerNumber(v, 'EXPTIME', 'EXPOSURE', 'EXP');
    const ra = v['RA'] ?? v['OBJCTRA'] ?? v['CRVAL1'] ?? v['RA_OBJ'];
    const dec = v['DEC'] ?? v['OBJCTDEC'] ?? v['CRVAL2'] ?? v['DEC_OBJ'];

    // Resolution order for observer coordinates:
    //   1. FITS headers (SeeStar writes SITELAT/SITELONG; others use variants)
    //   2. The active observing site (user-configured location for planning/forecasting)
    //   3. Client-supplied override (from browser geolocation popup)
    let obsLat: unknown = v['OBS-LAT'] ?? v['SITELAT'] ?? v['LAT-OBS'] ?? v['OBSLAT'] ?? v['LATITUDE'];
    let obsLon: unknown = v['OBS-LONG'] ?? v['SITELONG'] ?? v['LONG-OBS'] ?? v['OBSLONG'] ?? v['LONGITUD'];
    if (obsLat == null || obsLon == null) {
      const site = getActiveSite();
      if (site.latitude != null) obsLat = site.latitude;
      if (site.longitude != null) obsLon = site.longitude;
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
    const naxis1 = headerNumber(v, 'NAXIS1') ?? null;
    const naxis2 = headerNumber(v, 'NAXIS2') ?? null;
    const focalLenMm = headerNumber(v, 'FOCALLEN') ?? fitsDefaults.focalLenMm;
    const pixelSizeXUm = headerNumber(v, 'XPIXSZ') ?? fitsDefaults.pixelSizeUm;
    const pixelSizeYUm = headerNumber(v, 'YPIXSZ') ?? pixelSizeXUm;
    // Binning. N.I.N.A. and ASIAIR report XPIXSZ as the SENSOR pixel size and
    // record the bin factor separately, so a 2×2 binned frame came out with a
    // FOV half its true size and an over-tight satellite crossing test. Writers
    // that already fold binning into XPIXSZ (MaxIm DL) also write XBINNING, so
    // this can overcorrect there; a plate solve, when present, overrides both
    // below and is the authority.
    const xBinning = Math.max(1, Math.round(headerNumber(v, 'XBINNING', 'BINX', 'CCDXBIN') ?? 1));
    const yBinning = Math.max(1, Math.round(headerNumber(v, 'YBINNING', 'BINY', 'CCDYBIN') ?? 1));

    // A plate-solved CD matrix states the true scale directly and needs no
    // assumptions about focal length, pixel size or binning at all. Prefer it.
    const cdMatrix = readCdMatrix(v);
    const cdScaleX = cdMatrix ? Math.hypot(cdMatrix.cd11, cdMatrix.cd21) : null;
    const cdScaleY = cdMatrix ? Math.hypot(cdMatrix.cd12, cdMatrix.cd22) : null;

    let fovWidthDeg: number;
    let fovHeightDeg: number;
    let degPerPixel: number | undefined;
    if (naxis1 != null && naxis2 != null) {
      const degPerPixelX = cdScaleX && cdScaleX > 0
        ? cdScaleX
        : ((pixelSizeXUm * xBinning) / 1000 / focalLenMm) * (180 / Math.PI);
      const degPerPixelY = cdScaleY && cdScaleY > 0
        ? cdScaleY
        : ((pixelSizeYUm * yBinning) / 1000 / focalLenMm) * (180 / Math.PI);
      fovWidthDeg = naxis1 * degPerPixelX;
      fovHeightDeg = naxis2 * degPerPixelY;
      degPerPixel = Math.min(degPerPixelX, degPerPixelY);
    } else {
      const fov = FOV_DEFAULTS_BY_KIND[fitsDefaults.kind] ?? FOV_DEFAULTS_BY_KIND.other;
      fovWidthDeg = fov.widthDeg;
      fovHeightDeg = fov.heightDeg;
    }

    // Step 2: Detect the trail, now that the plate scale is known.
    // trailResult holds the *positive* half of the detector's discriminated
    // union only: the no-trail outcome returns immediately below, so everything
    // after this block reads measurements without re-testing the discriminant,
    // and `undefined` means exactly one thing (identifyOnly skipped detection).
    let trailResult: TrailDetected | undefined;
    if (!identifyOnly) {
      const detection = trailDetector.detect(fileBuffer, { degreesPerPixel: degPerPixel });
      if (!detection.trailDetected) {
        const noTrail = { trailDetected: false as const };
        updateCache({ [filePath]: noTrail });
        res.apiSuccess(noTrail);
        return;
      }

      // A plain detect() call stops here — pixel-level trail detection only.
      // Satellite identification (the TLE catalog fetch/match below) is a
      // separate, explicit, per-file action: the client only ever exposes it
      // behind the "Identify Satellite" button (identifyOnly: true), never as
      // part of a bulk scan. This used to fall through into full
      // identification for every positively-detected frame, which meant a
      // session scan of a couple hundred sub-frames made that many automatic
      // celestrak.org round-trips — and the result was thrown away anyway,
      // since the Identify Satellite button always re-runs identification
      // fresh rather than trusting whatever a scan happened to fetch earlier.
      const detectOnlyResult = {
        trailDetected: true as const,
        identifyOnly: false,
        angleDegrees: detection.angleDegrees,
        lengthPixels: detection.lengthPixels,
        midpoint: detection.midpoint,
        endpoints: detection.endpoints,
        confidence: detection.confidence,
        profileWidth: detection.profileWidth,
        exposureStart: dateObs ? normalizeObservationTimestamp(dateObs).toISOString() : undefined,
        exposureSeconds: expTime ?? undefined,
        candidates: [] as unknown[],
        nearMissFallback: false,
      };
      updateCache({ [filePath]: detectOnlyResult });
      res.apiSuccess(detectOnlyResult);
      return;
    }

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

      // Load the TLE catalog closest to the observation date for accurate identification.
      // DATE-OBS sometimes carries a numeric UTC offset (firmware-dependent) rather
      // than 'Z' — naively appending 'Z' to that produces an invalid ISO string
      // ("...+02:00Z") and an Invalid Date, silently poisoning every duringExposure
      // check below. normalizeObservationTimestamp only appends 'Z' when no
      // timezone info is already present.
      const obsDate = normalizeObservationTimestamp(dateObs);
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
      const trailSkyPA = trailResult?.angleDegrees != null && cdMatrix
        ? imageAngleToSkyPA(trailResult.angleDegrees, cdMatrix)
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
        // Orient the FOV rectangle to the sensor. Without a WCS solution we
        // cannot know the camera angle, so the tracker keeps its historical
        // "+x points east" assumption.
        fovRotationDeg: cdMatrix ? sensorRotationFromCd(cdMatrix) : undefined,
      };
      try {
        const result = await satelliteTracker.identifySatelliteTrail(identParams, tleRecords);
        const expStartMs = obsDate.getTime();
        const expEndMs = expStartMs + expTime * 1000;
        candidates = result.candidates.map(c => ({
          ...c,
          track: thinTrack(c.track),
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
    // Derived from the same normalized instant as obsDate above, not a second
    // naive 'Z'-append, so a DATE-OBS with a numeric offset reports the
    // correct UTC instant here too.
    const exposureStartUTC = dateObs
      ? normalizeObservationTimestamp(dateObs).toISOString()
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

/**
 * Read `filePaths` out of an untrusted request body. Returns null when the
 * field is absent or not an array (the caller answers 400), and otherwise the
 * string entries only, so a `[1, null]` body can't reach the cache lookup as
 * if it were a list of paths.
 */
function parseFilePathsBody(body: unknown): string[] | null {
  if (!isRecord(body)) return null;
  const { filePaths } = body;
  if (!Array.isArray(filePaths)) return null;
  return filePaths.filter((entry): entry is string => typeof entry === 'string');
}

// ─── Get cached results for specific file paths ─────────────────────
router.post('/results', requireAdmin, (req: Request, res: Response) => {
  try {
    const filePaths = parseFilePathsBody(req.body);
    if (!filePaths) {
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
      usingSeed: satelliteCatalog.isUsingSeed(),
      seedEpoch: satelliteCatalog.getSeedEpoch(),
      lastError: satelliteCatalog.getLastFetchError(),
      retryInMinutes: Math.ceil(satelliteCatalog.backoffRemainingMs() / 60000),
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

export { router as satelliteRouter };
