/**
 * Local library API routes.
 *
 * Serves objects/sessions/files from the locally-imported copy of the
 * SeeStar image library, and provides endpoints to trigger imports.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { strictRateLimiter, burstyRateLimiter } from '../middleware/rateLimit.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import archiver from 'archiver';
import multer from 'multer';
import { log } from '../lib/logger.js';
import { debugLog, isDebugLoggingEnabled } from '../lib/debugLogger.js';
import { isErrnoException } from '../lib/errors.js';
import { redactUrl } from '../lib/logSafe.js';
import { THUMBNAILS_DIR } from '../lib/paths.js';
import { getLibraryDir, isLibraryAvailable, statLibraryFileForServe, TimeoutError } from '../lib/libraryPath.js';
import { runRender } from '../lib/renderQueue.js';
import { mintDownloadToken, DOWNLOAD_TOKEN_TTL_MS } from '../lib/downloadToken.js';
import { isLibraryMigrating } from '../lib/libraryMaintenance.js';
import { getSite } from '../lib/observingSites.js';
import { plantSampleObject, purgeSampleObject } from '../lib/library/sampleLibrary.js';
import sharp from '../lib/sharp-optional.js';
import { generateFitsThumbnail, fitsThumbnailPath, type FitsThumbnailTier } from '../lib/fitsThumbnail.js';
import { generateTiffThumbnail, tiffThumbnailPath, type TiffThumbnailTier } from '../lib/tiffThumbnail.js';
import { normalizeCatalogId, clampToNightSafeTime, mimeTypeForExtension } from '../lib/telescopeFiles.js';
import {
  runImport,
  runAllTelescopesImport,
  reassignSessionTelescope,
  reassignSessionSite,
  backfillSingleSessionWeather,
  getImportStatus,
  cancelImport,
  claimImportLock,
  getLocalObjects,
  getLocalSessions,
  getLocalFiles,
  getLocalFile,
  getLocalObservations,
  getLocalObservationDetail,
  getObjectLocation,
  getLocalIntegrationStats,
  getLocalFitsHeader,
  deleteLocalFile,
  deleteLocalObject,
  deleteLocalSession,
  restoreLocalObject,
  restoreLocalSession,
  listDeletedObjects,
  listDeletedSessions,
  moveObservation,
  commitFolderImport,
  getFavorites,
  syncSessionSubFrames,
  syncObjectSubFrames,
  deleteSessionSubFrames,
  reclassifyObject,
  getSessionTelescopeId,
  getObjectPrimaryTelescopeId,
  setFavorite,
  getImageFavorites,
  setImageFavorite,
  getAllLibraryImages,
  invalidateAllImagesCache,
  createManualObservation,
  getGalleryImageRow,
  setGalleryImage,
  setGalleryImageUserChosen,
  setProcessingStatus,
  isCatalogSourceSentinel,
  findFallbackObservationImage,
  getStackedImages,
  getImportHistory,
  getSessionImage,
  setSessionImage,
  getProcessedImages,
  getAllProcessedImagesForObject,
  getProcessedImageRecord,
  addProcessedImage,
  replaceProcessedImageFile,
  deleteProcessedImage,
  getProcessedImageFile,
  isRenderableProcessedName,
  isStoredOnlyProcessedName,
  processedImageMimeType,
  createProcessingRun,
  getProcessingRun,
  getProcessingRunsForObject,
  getProjectArchivesForObject,
  addProjectArchive,
  deleteProjectArchive,
  getProjectArchivePath,
  isProjectArchiveName,
  projectArchiveMimeType,
  getProcessingProjectSummary,
  saveProcessingProjectFile,
  getObjectFolderName,
  scanImportFolder,
  LIBRARY_OBJECT_FILTERS,
  resolveObjectImagePath,
  objectThumbnailDiskCacheKey,
  fileThumbnailDiskCacheKey,
} from '../lib/localLibrary.js';
import { getArchiveDir, listArchivedFolders, listArchiveScopes } from '../lib/library/archiveFolders.js';
import { listCalibrationLibrary, findCalibrationBundle, calibrationBundleName, deleteCalibrationBundle, resolveFrameType } from '../lib/library/calibrationScan.js';
import {
  isAttachableCalibrationType,
  attachCalibrationBundle,
  detachCalibrationBundle,
  findAttachmentsForBundle,
  listAttachmentsForObject,
  resolveAttachmentsForSession,
} from '../lib/library/calibrationAttachments.js';
import { stmts as objectStmts } from '../lib/library/objects.js';
import { stageUploadDestPath } from '../lib/library/uploadPath.js';
import {
  IMPORT_TMP_BASE,
  isValidTmpId,
  getImportTmpUsage,
  purgeImportTmp,
  purgeImportTmpSession,
  checkFreeSpace,
  isImportStagingBase,
} from '../lib/library/importStaging.js';
import {
  getCaptureInfoForObject,
  summarizeSessionCapture,
  type CaptureInfoRow,
  type SessionCaptureSummary,
} from '../lib/library/captureInfo.js';
import { createNote, getNote } from '../lib/notes.js';
import { hasCachedCatalogImage, fovForEntry, prefetchObjectWiki, prefetchObjectHubble } from '../lib/catalogPrefetch.js';
import { prefetchSkyImage } from '../lib/skyImage.js';
import { getById as getDsoById } from '../lib/dsoCatalog.js';
import { caldwellToNgcId } from '../lib/caldwellCatalog.js';
import { resolveCanonicalId } from '../lib/catalogAliases.js';
import { getSettingsData, getProfileById } from '../lib/telescopes.js';
import { queryString, contentDispositionHeader } from '../lib/queryHelpers.js';

// Multer: temp-disk storage for file uploads.
// Filename is derived from a UUID rather than originalname so two rapid uploads
// in the same millisecond can't collide and so an originalname containing
// control characters or path-confusing tokens (`:` on Windows, NUL bytes, etc.)
// can't break the rename. Original name is preserved through multer's
// `file.originalname` and used downstream when distributing into the library.
// fileFilter: only allow extensions we actually ingest. Anything else is a
// caller error and shouldn't squat 200 MB of disk waiting for cleanup. This
// is a coarse pre-filter only — whether a video/thumbnail/etc. actually gets
// imported is still decided by classifyImportFile (importFilter.ts) once the
// staged upload reaches /import/scan, same as a folder import.
const ALLOWED_UPLOAD_EXTS = new Set([
  '.fit', '.fits', '.fts',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff',
  '.avi', '.mp4', '.mov',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, `nebulis_upload_${randomUUID()}`),
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
      log.warn({ ext, filename: file.originalname }, '[upload-temp] rejected unsupported file type');
      debugLog('upload', `rejected file — unsupported extension: ${ext || '(none)'} (${file.originalname})`);
      cb(new Error(`Unsupported file type: ${ext || '(no extension)'}`));
      return;
    }
    cb(null, true);
  },
  limits: {
    // 2 GB per file. Lucky-imaging video files can exceed 1 GB, so we keep
    // headroom for those. This path never buffers the file in memory: multer's
    // diskStorage streams the upload to a temp file, and distribution into the
    // library uses rename/copyFile (OS-level). The cap is a sanity bound on
    // per-file temp-disk usage, not a memory guard. (The in-memory Buffer paths
    // are the SMB telescope import and the 200 MB /manual-observations route.)
    fileSize: 2 * 1024 * 1024 * 1024,
    fieldSize: 50 * 1024 * 1024, // 50 MB — relativePaths JSON can be several MB for large folders
  },
});

const router = Router();

// ─── Library write guard ─────────────────────────────────────────────────────
// Block anything that writes to the library while it is being moved, or while
// its drive is disconnected. Reads (GET/HEAD) always pass so the UI can still
// browse cached data and show a reconnect prompt. Every library-mutating route
// here uses a non-GET method, so guarding on method is sufficient.
router.use(async (req: Request, res: Response, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (isLibraryMigrating()) {
    res.apiError(503, 'LIBRARY_MIGRATING', 'The library is being moved to a new location. Try again once the move finishes.');
    return;
  }
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'Your library drive is not connected. Reconnect it and try again.');
    return;
  }
  next();
});

/**
 * Fails fast with 503 if the library is unreachable right now, for GET routes
 * that read actual file bytes/listings off disk (thumbnails, downloads,
 * processed images, sub-frame listings) rather than just cached DB metadata.
 * The write-guard above intentionally exempts GET/HEAD so the UI can still
 * browse cached data while disconnected — but a route that goes on to call
 * fs.*Sync against a stale network-mounted library has no such exemption:
 * the sync call blocks the whole Node event loop until the OS's SMB client
 * gives up, which can hang the entire server, not just this one request (see
 * the isLibraryAvailable()/purgeJunkFiles() incident writeup in
 * libraryPath.ts and housekeeping.ts). isLibraryAvailable() itself is
 * timeout-bounded, so this check resolves in well under LIBRARY_IO_TIMEOUT_MS
 * even against a wedged share. Call at the top of a handler, before any fs
 * work, and `return` if it resolves false.
 */
async function requireLibraryReachable(res: Response): Promise<boolean> {
  if (isLibraryMigrating()) {
    res.apiError(503, 'LIBRARY_MIGRATING', 'The library is being moved to a new location. Try again once the move finishes.');
    return false;
  }
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'Your library drive is not connected. Reconnect it and try again.');
    return false;
  }
  return true;
}

/**
 * Map a failed `withTimeout(fs.*)` guard onto a response. A real ENOENT is a
 * 404; a {@link TimeoutError} means the disk is slow or wedged right now (a
 * burst of cold thumbnail renders saturating the threadpool is the common
 * cause), which is transient, so answer 503 + Retry-After and let the client
 * try again rather than caching a "missing image".
 */
function respondFsGuardError(res: Response, err: unknown): void {
  if (err instanceof TimeoutError) {
    res.status(503).set('Retry-After', '2').type('text/plain').send('Library is busy, retry shortly');
  } else {
    res.status(404).type('text/plain').send('Not found');
  }
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const ImportBodySchema = z.object({
  objectId: z.string().optional(),
  telescopeId: z.string().optional(),
  all: z.boolean().optional(),
});

const SessionTelescopeBodySchema = z.object({
  telescopeId: z.string().min(1, 'telescopeId is required'),
});

const SessionSiteBodySchema = z.object({
  siteId: z.string().nullable(),
});

const ReclassifyBodySchema = z.object({
  targetCatalogId: z.string().min(1, 'targetCatalogId is required'),
  remember: z.boolean().optional().default(true),
});

// Folder-import wizard: scan a folder (dry run) then commit an edited plan.
const FolderScanBodySchema = z.object({
  rootPath: z.string().min(1, 'rootPath is required'),
  importSubFrames: z.boolean().optional(),
  importFits: z.boolean().optional(),
  archiveAllFiles: z.boolean().optional(),
  // Mirrors FolderCommitBodySchema's telescopeId — resolved to a kind so the
  // scan can descend into the vendor base path (Astronomy, MyWorks, ...)
  // exactly as commitFolderImport does, so the two phases keep agreeing.
  telescopeId: z.string().nullable().optional(),
});

const FolderCommitObjectSchema = z.object({
  folderName: z.string().min(1),
  skip: z.boolean().optional(),
  targetObjectId: z.string().min(1),
  targetFolderName: z.string().min(1),
  // null = drop those files; a YYYY-MM-DD string = assign/merge.
  sessionMap: z.record(z.string(), z.string().nullable()),
});

const FolderCommitBodySchema = z.object({
  rootPath: z.string().min(1, 'rootPath is required'),
  objects: z.array(FolderCommitObjectSchema).min(1, 'No objects to import'),
  importSubFrames: z.boolean().optional(),
  importFits: z.boolean().optional(),
  archiveAllFiles: z.boolean().optional(),
  telescopeId: z.string().nullable().optional(),
});

const MoveObservationBodySchema = z.object({
  toObjectId: z.string().min(1, 'toObjectId is required'),
});

const SubframesBodySchema = z.object({
  dates: z.array(z.string()).min(1, 'dates must be a non-empty array'),
  filters: z.array(z.string()).optional(),
  // Matches `/sessions?includeVariants=true` and `/download/objects/:objectId?includeVariants=true`:
  // a mosaic/Ha/etc. variant's sub-frames live in that variant's own object
  // folder, not the base object's, so combining "all of M31" requires pulling
  // dates from every variant folder in the family.
  includeVariants: z.boolean().optional(),
  // When true, every sub-frame is flattened into a single `<objectFolder>/lights/`
  // directory inside the zip instead of keeping the per-session / per-variant
  // folder structure. Makes the archive drop-in ready for Siril's sequence
  // conversion, which wants all lights in one folder.
  sirilLayout: z.boolean().optional(),
});

const GalleryImageBodySchema = z.object({
  imagePath: z.string().nullable().optional(),
});

const ProcessingStatusBodySchema = z.object({
  status: z.enum(['unprocessed', 'processing', 'processed']),
});

const SessionImageBodySchema = z.object({
  imagePath: z.string().nullable().optional(),
});

const ImageFavoriteBodySchema = z.object({
  imagePath: z.string().min(1, 'imagePath is required'),
});

// /library/all-images supports optional offset/limit pagination. Both fields
// arrive as query strings and may be absent. We coerce, clamp, and let the
// gallery helper apply defaults so we never 4xx on out-of-range values.
const AllImagesQuerySchema = z.object({
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
});

// ─── Import ──────────────────────────────────────────────────────────────────

/**
 * Trigger a manual import.
 *  - { telescopeId }                         → all objects on that telescope
 *  - { objectId, telescopeId }               → that object on that telescope
 *  - ?all=1 or no telescopeId given          → every auto-import-enabled telescope, sequentially
 */
router.post('/import', requireAdmin, (req: Request, res: Response) => {
  const parsed = ImportBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { objectId, all } = parsed.data;
  let { telescopeId } = parsed.data;

  // objectId without an explicit telescopeId used to always fail with "no
  // telescope was selected" — fall back to the object's primaryTelescopeId
  // instead, same lookup pattern as getSessionTelescopeId for per-session
  // sync routes. Only objects with no attributed telescope at all (never
  // imported, or imported through a telescope-less path) get rejected.
  if (objectId && !telescopeId) {
    telescopeId = getObjectPrimaryTelescopeId(objectId) ?? undefined;
    if (!telescopeId) {
      res.apiError(
        422,
        'NO_TELESCOPE',
        `"${objectId}" has no telescope to sync from yet. Select a telescope in Settings, Hardware, or sync a session for this object first.`,
      );
      return;
    }
  }

  const importAll = req.query.all === '1' || all === true || !telescopeId;

  log.info(
    { telescopeId: telescopeId ?? null, objectId: objectId ?? null, all: importAll },
    '[import] Import triggered manually%s%s',
    telescopeId ? ` for telescope ${telescopeId}` : '',
    objectId ? ` object ${objectId}` : '',
  );

  if (!claimImportLock()) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is already in progress');
    return;
  }

  // Run in background — don't await. Lock already claimed above. Each branch
  // logs its own completion: unlike the scheduled auto-import tick, nothing
  // else confirms server-side that a manually-triggered run actually finished
  // and what it did.
  if (importAll && !objectId) {
    runAllTelescopesImport().catch(err => {
      console.error('Import error:', err.message);
    });
  } else {
    runImport(objectId, undefined, { telescopeId, manual: true })
      .then(() => {
        const status = getImportStatus();
        log.info(
          { telescopeId: status.telescopeId, telescopeName: status.telescopeName, filesDone: status.filesDone, skipped: status.skippedFiles, objects: status.objectsDone, error: status.error ?? null },
          '[import] Manual import completed',
        );
      })
      .catch(err => {
        console.error('Import error:', err.message);
      });
  }

  res.apiSuccess({
    started: true,
    objectId: objectId || null,
    telescopeId: telescopeId || null,
    all: importAll,
  });
});

/** Get the current import status. */
router.get('/import/status', (_req: Request, res: Response) => {
  res.apiSuccess(getImportStatus());
});

const CancelImportBodySchema = z.object({
  runId: z.string().optional(),
});

router.post('/import/cancel', requireAdmin, (req: Request, res: Response) => {
  // Body is optional — omitting runId keeps the generic "cancel whatever is
  // running" behavior for the main cancel button.
  const bodyParsed = CancelImportBodySchema.safeParse(req.body ?? {});
  cancelImport(bodyParsed.success ? bodyParsed.data.runId : undefined);
  res.apiSuccess({ cancelled: true });
});

/** Get paginated sync history: runs that imported new files, failed, or were
 *  explicitly triggered by the user (even if they found nothing new). A
 *  routine scheduled tick that finds nothing new stays hidden. */
router.get('/import/history', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.apiSuccess(getImportHistory(limit, offset));
});

/**
 * Sync FITS files for a specific session from the telescope.
 * Works even if syncEnabled is globally disabled.
 *
 * Previously gated on `isTelescopeOnline()` — that flag tracked the result of
 * the last *cached* SMB call and stayed stuck false long after recovery,
 * causing false "Telescope is not reachable" rejections. The actual SMB
 * call inside `runImport` will surface real connection errors via
 * `importStatus.error`, so the gate did nothing useful and was wrong half
 * the time.
 */
router.post('/objects/:objectId/sessions/:date/sync', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);

  if (!claimImportLock()) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is already in progress');
    return;
  }

  // Re-syncing this session must hit the telescope that captured it, not
  // whichever scope is currently "active" — otherwise an old S30 session
  // would silently re-pull from the S50 (or fail because the hostname differs).
  const telescopeId = getSessionTelescopeId(objectId, date) ?? undefined;
  log.info(
    { objectId, date, telescopeId: telescopeId ?? null },
    '[session-sync] Syncing FITS for %s session %s on telescope %s',
    objectId, date, telescopeId ?? 'unknown',
  );
  runImport(objectId, date, { telescopeId, manual: true }).catch(err => {
    console.error('Session sync error:', err.message);
  });

  res.apiSuccess({ started: true, objectId, date, telescopeId: telescopeId ?? null });
});

/**
 * Sync only raw sub-frame (.fit/.fits) files for a specific session.
 * Only downloads files from the _sub companion folder that match the session date.
 *
 * No pre-flight reachability gate — the global `isTelescopeOnline()` flag is
 * driven by cached SMB calls and stays stuck false after a transient blip
 * even when the scope is fine. Real SMB errors surface through
 * `importStatus.error` instead, so the modal shows the actual problem
 * (wrong host, auth failure, missing _sub folder, etc.).
 */
router.post('/objects/:objectId/sessions/:date/sync-subframes', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);

  if (!claimImportLock()) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is already in progress');
    return;
  }

  // Same reasoning as the FITS sync route above — pin to the originating scope.
  const telescopeId = getSessionTelescopeId(objectId, date) ?? undefined;
  log.info(
    { objectId, date, telescopeId: telescopeId ?? null },
    '[subframe-sync] Syncing sub-frames for %s session %s on telescope %s',
    objectId, date, telescopeId ?? 'unknown',
  );
  syncSessionSubFrames(objectId, date, telescopeId ? { telescopeId } : undefined).catch(err => {
    console.error('Sub-frame sync error:', err.message);
  });

  res.apiSuccess({ started: true, objectId, date, telescopeId: telescopeId ?? null });
});

/**
 * Sync raw sub-frames for every session of one object, in one pass. Runs the
 * per-session sync above once per night (each night against the telescope that
 * captured it), so the user does not have to open each observation and sync it
 * by hand. Same no-reachability-gate reasoning as the per-session route.
 */
router.post('/objects/:objectId/sync-subframes', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);

  if (!claimImportLock()) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is already in progress');
    return;
  }

  log.info({ objectId }, '[subframe-sync] Syncing sub-frames for every night of %s', objectId);
  syncObjectSubFrames(objectId).catch(err => {
    console.error('Object sub-frame sync error:', err.message);
  });

  res.apiSuccess({ started: true, objectId });
});

/**
 * Reclassify an object to a different catalog identity (Object Detail →
 * "..." → Reclassify), for when a target's designation was ambiguous or
 * mis-picked on import. Renames or merges depending on whether the target
 * catalog id already has a library object — see reclassifyObject's doc
 * comment in objects.ts for why this is DB-only (no on-disk folder move).
 */
router.post('/objects/:objectId/reclassify', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const bodyParsed = ReclassifyBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'BAD_REQUEST', bodyParsed.error.issues[0]?.message ?? 'targetCatalogId is required');
    return;
  }
  const { targetCatalogId, remember } = bodyParsed.data;
  try {
    const result = reclassifyObject(objectId, targetCatalogId, { remember, userId: req.userId ?? null });
    log.info(
      { objectId, targetCatalogId, mode: result.mode, newObjectId: result.objectId },
      '[reclassify] %s → %s (%s)', objectId, result.objectId, result.mode,
    );
    res.apiSuccess(result);
  } catch (err) {
    res.apiError(400, 'RECLASSIFY_FAILED', err instanceof Error ? err.message : 'Reclassify failed');
  }
});

/**
 * Reassign a session to a different telescope. The session is identified by
 * (objectId, date) since librarySessions uses that compound key — there's no
 * surrogate session id to pass.
 */
router.put('/objects/:objectId/sessions/:date/telescope', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  const bodyParsed = SessionTelescopeBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'BAD_REQUEST', bodyParsed.error.issues[0]?.message ?? 'telescopeId is required');
    return;
  }
  const { telescopeId } = bodyParsed.data;
  const updated = reassignSessionTelescope(objectId, date, telescopeId);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Session not found');
    return;
  }
  res.apiSuccess({ updated: true, telescopeId });
});

/**
 * Reassign a session to a different observing site. `siteId: null` clears the
 * tag (resolves back to the default site). Nulls the session's cached weather
 * — it was fetched at the old site's coordinates — and refetches it at the
 * new coordinates for just this session before responding. The client
 * invalidates its cached observation as soon as this responds, so if that
 * refetch were only fired in the background (as it used to be), the
 * observation would come back with `weather: null` and the Conditions card
 * would vanish from the Details tab until the next full reload.
 */
router.put('/objects/:objectId/sessions/:date/site', requireAdmin, async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  const bodyParsed = SessionSiteBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'BAD_REQUEST', bodyParsed.error.issues[0]?.message ?? 'siteId is required (or null)');
    return;
  }
  const { siteId } = bodyParsed.data;
  if (siteId !== null && !getSite(siteId)) {
    res.apiError(404, 'SITE_NOT_FOUND', 'Observing site not found');
    return;
  }
  const updated = reassignSessionSite(objectId, date, siteId);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Session not found');
    return;
  }
  await backfillSingleSessionWeather(objectId, date).catch(err =>
    // objectId is request-controlled; keep it out of the format-string position
    // (console.warn applies %-substitution to its first argument) and pass it
    // as a plain %s argument instead, so a value containing its own %-specifiers
    // can't be misinterpreted as formatting directives.
    console.warn('[library] Weather re-backfill after site retag failed for %s:', objectId, err instanceof Error ? err.message : err),
  );
  res.apiSuccess({ updated: true, siteId });
});

/**
 * Folder-import wizard, phase 1: scan a folder and return the import plan
 * (objects, catalog matches, derived sessions, unsorted files). Read-only —
 * copies nothing and does not claim the import lock.
 */
/**
 * Client-side breadcrumb sink for the manual (browser) folder-upload flow.
 * The debug log is otherwise server-only, so a browser-side stall (the exact
 * failure mode where an upload spins forever) leaves no trace. The Import modal
 * posts short one-line events here — files selected, per-batch progress, final
 * error — which land in the same debug log next to the server's own lines.
 * A no-op unless debug logging is active, so it costs nothing in normal use.
 */
const ClientDebugEventSchema = z.object({ message: z.string().min(1).max(500) });
router.post('/import/debug-event', requireAdmin, (req: Request, res: Response) => {
  if (!isDebugLoggingEnabled()) {
    res.apiSuccess({ logged: false });
    return;
  }
  const parsed = ClientDebugEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(400, 'INVALID_EVENT', 'message is required (max 500 chars)');
    return;
  }
  const oneLine = parsed.data.message.replace(/[\r\n]+/g, ' ').slice(0, 500);
  debugLog('import:client', oneLine);
  res.apiSuccess({ logged: true });
});

router.post('/import/scan', requireAdmin, (req: Request, res: Response) => {
  const parsed = FolderScanBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(400, 'MISSING_PATH', parsed.error.issues[0]?.message ?? 'rootPath is required');
    return;
  }
  const { rootPath, importSubFrames, importFits, archiveAllFiles, telescopeId } = parsed.data;
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    res.apiError(400, 'INVALID_PATH', `Folder not found or not a directory: ${rootPath}`);
    return;
  }
  if (isImportStagingBase(rootPath)) {
    res.apiError(400, 'INVALID_PATH', 'That folder is Nebulis\'s own upload staging area. Choose the folder that holds your images.');
    return;
  }
  try {
    const overrides: Record<string, unknown> = {};
    if (importSubFrames !== undefined) overrides.importSubFrames = importSubFrames;
    if (importFits !== undefined) overrides.importFits = importFits;
    if (archiveAllFiles !== undefined) overrides.archiveAllFiles = archiveAllFiles;
    const scanSettings = Object.keys(overrides).length > 0
      ? { ...getSettingsData(), ...overrides }
      : getSettingsData();
    const scanProfile = telescopeId ? getProfileById(telescopeId) : null;
    debugLog('import:folder-scan',
      `Manual folder scan: ${rootPath}  |  effective settings → ` +
      `JPG:${scanSettings.importJpg !== false} FITS:${scanSettings.importFits !== false} ` +
      `Thumbs:${scanSettings.importThumbnails !== false} Subs:${scanSettings.importSubFrames === true} ` +
      `Video:${scanSettings.importVideos === true} Archive-all:${scanSettings.archiveAllFiles === true}`);
    const scanResult = scanImportFolder(rootPath, scanSettings, scanProfile?.kind);
    debugLog('import:folder-scan',
      `Scan matched ${scanResult.totals.files} importable file(s) across ` +
      `${scanResult.totals.objects} object(s), ${scanResult.totals.sessions} session(s)` +
      `${scanResult.truncated ? ' (truncated: hit per-object file cap)' : ''}. ` +
      `Files classified as sub-frames are excluded unless "include sub-frames" is on.`);
    res.apiSuccess(scanResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Folder scan failed';
    res.apiError(500, 'SCAN_FAILED', message);
  }
});

/**
 * Folder-import wizard, phase 2: commit a reviewed plan. The folder is
 * re-walked and dates re-derived server-side, so the client only sends
 * decisions (object mapping, per-session final dates, skips), never paths to
 * trust. Runs in the background; progress shows on the shared import status.
 */
router.post('/import/commit', requireAdmin, (req: Request, res: Response) => {
  const parsed = FolderCommitBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid plan');
    return;
  }
  const plan = parsed.data;
  if (!fs.existsSync(plan.rootPath) || !fs.statSync(plan.rootPath).isDirectory()) {
    res.apiError(400, 'INVALID_PATH', `Folder not found or not a directory: ${plan.rootPath}`);
    return;
  }
  if (isImportStagingBase(plan.rootPath)) {
    res.apiError(400, 'INVALID_PATH', 'That folder is Nebulis\'s own upload staging area. Choose the folder that holds your images.');
    return;
  }
  if (!claimImportLock()) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is already in progress');
    return;
  }
  commitFolderImport(plan).catch(err => console.error('Folder commit error:', err.message));
  res.apiSuccess({ started: true, objects: plan.objects.filter(o => !o.skip).length });
});

/**
 * Folder-import wizard, preflight: does the staging volume have room for this
 * upload? Called with the total byte size of the picked folder before the
 * first batch goes out, so a doomed 125 GB upload is refused in the dialog
 * instead of filling the system drive and failing partway through.
 */
router.post('/import/preflight', requireAdmin, (req: Request, res: Response) => {
  const bytes = Number(req.body?.bytes);
  if (!Number.isFinite(bytes) || bytes < 0) {
    res.apiError(400, 'VALIDATION_ERROR', 'bytes must be a non-negative number');
    return;
  }
  const check = checkFreeSpace(IMPORT_TMP_BASE, bytes, 'to upload these files');
  res.apiSuccess({
    ok: check.ok,
    path: check.path,
    freeBytes: check.freeBytes,
    requiredBytes: check.requiredBytes,
    message: check.message,
  });
});

/**
 * Current size of the upload staging area, for the Storage settings card.
 */
router.get('/import/temp-usage', requireAdmin, (_req: Request, res: Response) => {
  res.apiSuccess(getImportTmpUsage());
});

/**
 * Manual "clean up temporary files". Deletes staged upload sessions that
 * haven't been written to recently.
 *
 * The short age floor is deliberate: an upload batch in flight refreshes its
 * session directory's mtime, so anything untouched for five minutes is not an
 * active upload. A running import is refused outright rather than age-gated,
 * since a commit reading from a staged dir would lose the files under it.
 */
const MANUAL_PURGE_MIN_AGE_MS = 5 * 60 * 1000;

router.post('/import/temp-cleanup', requireAdmin, (_req: Request, res: Response) => {
  if (getImportStatus().running) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is running. Wait for it to finish, then clean up.');
    return;
  }
  const result = purgeImportTmp(MANUAL_PURGE_MIN_AGE_MS, () => getImportStatus().running);
  log.info(result, '[library] manual import-tmp cleanup');
  res.apiSuccess(result);
});

/**
 * Drop one upload session. The wizard calls this when it is dismissed
 * mid-upload, so an abandoned staging dir is reclaimed immediately instead of
 * waiting for the sweeper.
 */
router.delete('/import/temp/:tmpId', requireAdmin, (req: Request, res: Response) => {
  const tmpId = String(req.params.tmpId);
  if (!isValidTmpId(tmpId)) {
    res.apiError(400, 'INVALID_TMP_ID', 'Invalid upload session ID');
    return;
  }
  if (getImportStatus().running) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is running. Wait for it to finish.');
    return;
  }
  const result = purgeImportTmpSession(tmpId);
  res.apiSuccess(result);
});

/**
 * Folder-import wizard, pre-phase: accept an uploaded folder, reconstruct its
 * directory tree under a UUID temp dir, and return the path so the caller can
 * feed it straight into /import/scan → /import/commit.
 *
 * The client strips the top-level folder name from relative paths before
 * sending, so the temp dir IS the scan root (no extra nesting).
 */
router.post('/import/upload-temp', requireAdmin, (req: Request, res: Response, next) => {
  const contentLengthHeader = req.headers['content-length'];
  const contentMb = contentLengthHeader
    ? (parseInt(contentLengthHeader, 10) / (1024 * 1024)).toFixed(1)
    : 'unknown';

  // Per-batch space guard. The client preflights the whole upload before it
  // starts, but batches arrive over minutes and something else may eat the
  // disk in between, so each one is re-checked against what it declares. This
  // is what stops a long upload from consuming the last free byte on the
  // system drive: once free space drops under a batch plus headroom, the
  // upload fails with an explanation instead of filling the volume.
  const declaredBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;
  if (Number.isFinite(declaredBytes)) {
    const space = checkFreeSpace(IMPORT_TMP_BASE, declaredBytes, 'to stage this upload');
    if (!space.ok) {
      log.warn({ declaredBytes, free: space.freeBytes, path: space.path }, '[upload-temp] refused: disk nearly full');
      res.apiError(507, 'INSUFFICIENT_STORAGE', space.message ?? 'Not enough free space to stage this upload.');
      return;
    }
  }

  req.__uploadStart = Date.now();
  req.__bytesReceived = 0;
  // Passive byte counter: does not put the stream in a competing flow — Node
  // dispatches each 'data' chunk to every registered listener, so this runs
  // alongside (not instead of) busboy's own consumption below. Its only job
  // is to tell us, if busboy later throws "Unexpected end of form", whether
  // the client actually sent fewer bytes than it declared (real truncation)
  // or sent everything it declared but busboy still couldn't find the
  // closing boundary (a Content-Type/boundary mismatch instead).
  req.on('data', (chunk: Buffer) => { req.__bytesReceived = (req.__bytesReceived ?? 0) + chunk.length; });
  req.on('aborted', () => {
    log.warn({ contentLengthHeader, bytesReceived: req.__bytesReceived }, '[upload-temp] request aborted mid-stream');
  });
  log.info({
    method: req.method,
    url: redactUrl(req.url),
    contentMb,
    contentLengthHeader,
    contentType: req.headers['content-type'],
    // Temporary diagnostic (see X-Diag-File-Sizes in uploadFolderTemp): the
    // sizes the client believed each File had right at xhr.send() time. Sent
    // as a header so it survives even when the body itself arrives empty.
    clientDiagFileSizes: req.headers['x-diag-file-sizes'],
  }, '[upload-temp] upload started');
  debugLog('upload', `upload started — Content-Length: ${contentMb} MB (${contentLengthHeader ?? 'unknown'} bytes)`);
  next();
}, upload.array('files', 100_000), (req: Request, res: Response) => {
  const files = Array.isArray(req.files) ? req.files : undefined;
  if (!files || files.length === 0) {
    res.apiError(400, 'NO_FILES', 'No files uploaded');
    return;
  }

  let relativePaths: string[] = [];
  try {
    if (req.body?.relativePaths) relativePaths = JSON.parse(req.body.relativePaths);
  } catch { /* fall back to filename */ }

  // Support batched uploads: an existing tmpId resumes into the same dir instead
  // of creating a new one. UUID format is enforced to prevent path traversal.
  const existingTmpId: string | undefined = typeof req.body?.tmpId === 'string' ? req.body.tmpId : undefined;
  let tmpId: string;
  let tmpDir: string;
  if (existingTmpId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existingTmpId)) {
      for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
      res.apiError(400, 'INVALID_TMP_ID', 'Invalid upload session ID');
      return;
    }
    tmpDir = path.join(IMPORT_TMP_BASE, existingTmpId);
    if (!fs.existsSync(tmpDir)) {
      for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
      res.apiError(400, 'TMP_NOT_FOUND', 'Upload session not found. Please start over.');
      return;
    }
    tmpId = existingTmpId;
  } else {
    tmpId = randomUUID();
    tmpDir = path.join(IMPORT_TMP_BASE, tmpId);
  }

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // Sanitize the client-supplied relative path so it can never escape
      // tmpDir (.. segments, absolute/leading-slash paths, backslash
      // separators, control chars). Unsafe entries are skipped, not written.
      const rawRel = relativePaths[i] || f.originalname;
      const destAbs = stageUploadDestPath(tmpDir, rawRel);
      if (!destAbs) {
        log.warn({ rawRel }, '[upload-temp] rejected unsafe upload path');
        try { fs.unlinkSync(f.path); } catch { /* ignore */ }
        continue;
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      try {
        fs.renameSync(f.path, destAbs);
      } catch (renameErr) {
        // DATA_DIR may be on a different filesystem than os.tmpdir() (external drive).
        // Fall back to copy + delete so we never leave multer temps behind.
        if (isErrnoException(renameErr) && renameErr.code === 'EXDEV') {
          fs.copyFileSync(f.path, destAbs);
          fs.unlinkSync(f.path);
        } else {
          throw renameErr;
        }
      }
    }

    const ms = Date.now() - (req.__uploadStart ?? Date.now());
    const totalMb = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    log.info({ fileCount: files.length, totalMb: totalMb.toFixed(1), ms }, '[upload-temp] upload complete');
    debugLog('upload', `upload complete — ${files.length} file(s), ${totalMb.toFixed(1)} MB, ${ms} ms`);
    res.apiSuccess({ tmpPath: tmpDir, tmpId, fileCount: files.length });
  } catch (err) {
    // Only wipe the temp dir on the first batch (existingTmpId absent); for
    // subsequent batches, leave whatever was already placed there intact so the
    // user can retry from the failed batch without re-uploading everything.
    if (!existingTmpId) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
    const message = err instanceof Error ? err.message : 'Upload failed';
    res.apiError(500, 'UPLOAD_FAILED', message);
  }
});


// ─── Observations (calendar + detail) ────────────────────────────────────────
// DEPRECATED: /library/observations and /library/observations/:objectId/:date
// are duplicates of the canonical /observations routes. Use /observations instead.

router.get('/observations', (_req: Request, res: Response) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 01 Jan 2028 00:00:00 GMT');
  res.setHeader('Link', '</api/v1/observations>; rel="successor-version"');
  try {
    res.apiSuccess(getLocalObservations());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list observations';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

router.get('/observations/:objectId/:date', (req: Request, res: Response) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 01 Jan 2028 00:00:00 GMT');
  res.setHeader('Link', '</api/v1/observations>; rel="successor-version"');
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  try {
    const detail = getLocalObservationDetail(objectId, date);
    res.apiSuccess(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get observation detail';
    res.apiError(500, 'FETCH_FAILED', message);
  }
});

// ─── Objects ─────────────────────────────────────────────────────────────────

const VARIANT_LABELS: Record<string, string> = {
  mosaic: 'Mosaic', mosaick: 'Mosaic', mosiac: 'Mosaic',
  ha: 'Hα', oiii: 'OIII', sii: 'SII',
  sho: 'SHO', hoo: 'HOO',
  rgb: 'RGB', lrgb: 'LRGB',
  lum: 'Luminance', luminance: 'Luminance',
  nb: 'Narrowband', narrowband: 'Narrowband', broadband: 'Broadband',
  bicolor: 'Bicolor', tricolor: 'Tricolor', hargb: 'HaRGB',
  photo: 'Photo', video: 'Video',
};

// Keep this suffix list in sync with normalizeCatalogId (telescopeFiles.ts):
// any suffix the normalizer strips for grouping must be recognized here so the
// folded variant gets a clean label instead of falling back to its raw id.
function extractVariantLabel(objectId: string): string | null {
  const m = objectId.match(/[_\s]+(mosai[ck]|mosiac|panel\d*|ha|oiii|sii|sho|hoo|rgb|lrgb|nb|narrowband|broadband|luminance|lum|bicolor|tricolor|hargb|photo|video)\s*\d*$/i);
  if (!m) return null;
  const key = m[1].toLowerCase().replace(/\d+$/, '');
  return VARIANT_LABELS[key] ?? (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase());
}

function groupByVariants(objects: ReturnType<typeof getLocalObjects>) {
  const groups = new Map<string, typeof objects>();
  for (const obj of objects) {
    // Resolve the catalogId through catalog aliases so a variant captured under
    // an alias name groups with its canonical primary — e.g. "NGC224_Mosaic"
    // (catalogId "NGC224") folds into the "M31" card instead of showing as a
    // separate "NGC224" card.
    const key = resolveCanonicalId(obj.catalogId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(obj);
  }

  const maxStr = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '') >= (b ?? '') ? (a ?? null) : (b ?? null);

  const result: (typeof objects[0] & { variants: { objectId: string; label: string }[] })[] = [];
  for (const [key, group] of groups.entries()) {
    if (group.length === 1) {
      result.push({ ...group[0], variants: [] });
      continue;
    }
    // Primary = the entry whose id is the canonical key, else the entry whose id
    // matches its own catalogId, else the shortest id.
    const primary =
      group.find(o => o.id === key) ??
      group.find(o => o.id === o.catalogId) ??
      [...group].sort((a, b) => a.id.length - b.id.length)[0];
    const variants = group
      .filter(o => o.id !== primary.id)
      .map(o => ({ objectId: o.id, label: extractVariantLabel(o.id) ?? o.id }));

    // Aggregate recency and telescope coverage across the whole group so the
    // card's session/import sorts, telescope facet filter, and telescope dots
    // reflect every variant — not just the primary's own data.
    const totalSessionCount = group.reduce((sum, o) => sum + (o.sessionCount ?? 0), 0);
    const lastSessionDate = group.reduce<string | null>((acc, o) => maxStr(acc, o.lastSessionDate), null);
    const lastImport = group.reduce<string>((acc, o) => maxStr(acc, o.lastImport) ?? acc, primary.lastImport);
    const telescopeIds: string[] = [];
    const seenTelescopes = new Set<string>();
    for (const o of group) {
      for (const id of o.telescopeIds ?? []) {
        if (!seenTelescopes.has(id)) { seenTelescopes.add(id); telescopeIds.push(id); }
      }
    }

    result.push({
      ...primary,
      sessionCount: totalSessionCount,
      lastSessionDate,
      lastImport,
      telescopeIds,
      variants,
    });
  }
  return result;
}

/** Every object id in objectId's variant family (itself plus its Mosaic/Ha/etc.
 *  siblings), or just `[objectId]` when there is no family. Shared by every
 *  `?includeVariants=true` route so "combine subs" / "download all" / session
 *  listing agree on which ids make up one target. */
function resolveVariantIds(objectId: string, userId: string): string[] {
  const all = getLocalObjects(userId);
  const grouped = groupByVariants(all);
  const family = grouped.find(g => g.id === objectId || g.variants.some(v => v.objectId === objectId));
  return family ? [family.id, ...family.variants.map(v => v.objectId)] : [objectId];
}

router.get('/object-filters', (_req: Request, res: Response) => {
  res.apiSuccess(LIBRARY_OBJECT_FILTERS);
});

/**
 * Folders archive mode kept but did not model: calibration frames and daytime
 * captures. A plain directory listing, deliberately: these are bytes in the
 * library, not objects, and giving them a home in the UI is what makes
 * archive mode read as an import rather than a silent copy. The absolute path
 * is returned so the user can point Siril or PixInsight straight at it.
 *
 * `telescopeId` scopes to one telescope's archive (two Dwarf units can have
 * distinct CALI_FRAME/DWARF_DARK files); omitted, this returns the shared
 * unscoped bucket (a folder-import run with no telescope assigned, or
 * pre-scoping data migrated there — see archiveFolders.ts). Unmatched
 * RESTACKED leftovers are not part of this endpoint at all: they live in the
 * shared RESTACKED/ folder at the library root, not under a telescope scope.
 */
router.get('/archive', (req: Request, res: Response) => {
  try {
    const telescopeId = typeof req.query.telescopeId === 'string' ? req.query.telescopeId : null;
    res.apiSuccess({ path: getArchiveDir(telescopeId), folders: listArchivedFolders(telescopeId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list the archive';
    res.apiError(500, 'ARCHIVE_LIST_FAILED', message);
  }
});

/** Every scope (telescope id, or null for the shared unscoped bucket) that
 *  currently has archived data — lets Settings show a stat per telescope
 *  without probing each one individually. */
router.get('/archive/scopes', (_req: Request, res: Response) => {
  try {
    res.apiSuccess(listArchiveScopes());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list archive scopes';
    res.apiError(500, 'ARCHIVE_SCOPES_FAILED', message);
  }
});

/**
 * The Calibration Library: every bias/dark/flat/flat-dark folder currently
 * archived (see calibrationScan.ts), grouped by telescope scope and frame
 * type, with per-file metadata parsed from filenames where recognized. This
 * is the dedicated, browsable home for calibration data — /archive above is
 * the older plain-folder-listing view (still used by the per-telescope
 * Settings modal), this one is what the top-nav "Calibrations" page reads.
 *
 * Flat/flat-dark settings groups are enriched with `attachments` here rather
 * than in calibrationScan.ts, which stays a pure filesystem read with no
 * database — this route is the one place calibration data and the
 * attachments table meet. Checked per bundle via `resolveFrameType`, not per
 * group: a Dwarf `mixed` (CALI_FRAME) group blends bias/dark/flat, so one of
 * its own bundles can be attachable while a sibling bundle in the very same
 * group is not. Bias/dark bundles are never attachable (see
 * calibrationAttachments.ts), so they are skipped rather than paying for a
 * lookup that can never find anything.
 */
router.get('/calibrations', (_req: Request, res: Response) => {
  try {
    const groups = listCalibrationLibrary();
    for (const group of groups) {
      for (const set of group.settingsGroups) {
        if (!isAttachableCalibrationType(resolveFrameType(group.type, set.frameType))) continue;
        set.attachments = findAttachmentsForBundle(group.scope, group.folderName, set.key);
      }
    }
    res.apiSuccess({ groups });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list the calibration library';
    res.apiError(500, 'CALIBRATIONS_LIST_FAILED', message);
  }
});

// ─── Calibration bundle attachment (flats / flat-darks → object/session) ────
//
// Bias/darks are stable across sessions on a cooled camera and stay a shared,
// reusable pool (the whole point of organizing them by settings). Flats and
// their matching flat-darks are shot fresh per session and correct for that
// session's optical-train state, so they are session-specific — this lets a
// user point one at the object (and, optionally, the exact session date) it
// was captured for. See calibrationAttachments.ts for the full reasoning.

const AttachBundleBodySchema = z.object({
  scope: z.string().nullable(),
  folderName: z.string().min(1),
  key: z.string().min(1),
  objectId: z.string().min(1),
  date: z.string().min(1).optional(),
});

router.post('/calibrations/attach', requireAdmin, (req: Request, res: Response) => {
  const parsed = AttachBundleBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(400, 'INVALID_BODY', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { scope, folderName, key, objectId, date } = parsed.data;

  const found = findCalibrationBundle(scope, folderName, key);
  if (!found) {
    res.apiError(404, 'BUNDLE_NOT_FOUND', 'No matching calibration bundle — the archive may have changed since this page loaded');
    return;
  }
  const effectiveType = resolveFrameType(found.group.type, found.set.frameType);
  if (!isAttachableCalibrationType(effectiveType)) {
    res.apiError(
      400,
      'NOT_ATTACHABLE',
      'Only flats and flat-darks can be attached to an object. Bias and darks are stable across sessions on a cooled camera and stay in the shared calibration pool.',
    );
    return;
  }

  const obj = objectStmts.getObject.get(objectId);
  if (!obj || obj.deleted) {
    res.apiError(404, 'OBJECT_NOT_FOUND', 'No such library object');
    return;
  }

  const attachment = attachCalibrationBundle({
    objectId,
    date,
    calibrationType: effectiveType,
    scope,
    folderName,
    settingsKey: key,
  });
  res.apiSuccess({ attachment: { ...attachment, objectName: obj.objectName ?? obj.folderName } });
});

router.delete('/calibrations/attach/:id', requireAdmin, (req: Request, res: Response) => {
  const ok = detachCalibrationBundle(String(req.params.id));
  if (!ok) {
    res.apiError(404, 'ATTACHMENT_NOT_FOUND', 'No such attachment');
    return;
  }
  res.apiSuccess({ detached: true });
});

/** What's attached to one object — every session that has its own attachment
 *  plus the whole-object one, or (with `?date=`) just what resolves for that
 *  one session (a session-specific pick wins over the whole-object one). Not
 *  read by the Calibration Library page itself (that page reads the reverse
 *  direction via GET /calibrations above) — this is for a future object/
 *  session detail view to show "flats attached: ...".*/
router.get('/calibrations/attachments', (req: Request, res: Response) => {
  const objectId = queryString(req.query.objectId);
  if (!objectId) {
    res.apiError(400, 'MISSING_OBJECT_ID', 'objectId is required');
    return;
  }
  const date = queryString(req.query.date);
  const attachments = date ? resolveAttachmentsForSession(objectId, date) : listAttachmentsForObject(objectId);
  res.apiSuccess({ attachments });
});

/**
 * Permanently deletes one bias/dark bundle's files from the archive — meant
 * for a set flagged `isExpired` (older than the configured calibration
 * expiry, Settings → Library → "Dark/bias validity") that the user wants to
 * reclaim disk space from after re-shooting fresh ones, though nothing here
 * requires it to actually be expired first. Restricted to bias/dark: flats/
 * flat-darks are managed by attaching them to an object (see above), not by
 * deleting them from here — deleting one out from under an active
 * attachment would silently orphan it with no confirmation this route is
 * built to give.
 */
const DeleteBundleBodySchema = z.object({
  scope: z.string().nullable(),
  folderName: z.string().min(1),
  key: z.string().min(1),
});

router.delete('/calibrations/bundle', requireAdmin, (req: Request, res: Response) => {
  const parsed = DeleteBundleBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(400, 'INVALID_BODY', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { scope, folderName, key } = parsed.data;

  const found = findCalibrationBundle(scope, folderName, key);
  if (!found) {
    res.apiError(404, 'BUNDLE_NOT_FOUND', 'No matching calibration bundle — the archive may have changed since this page loaded');
    return;
  }
  const effectiveType = resolveFrameType(found.group.type, found.set.frameType);
  if (effectiveType !== 'bias' && effectiveType !== 'dark') {
    res.apiError(
      400,
      'NOT_DELETABLE_HERE',
      'Only bias and dark bundles can be deleted here. Flats and flat-darks are managed by attaching them to an object instead.',
    );
    return;
  }

  const result = deleteCalibrationBundle(scope, folderName, key);
  res.apiSuccess(result);
});

// ─── Calibration bundle ZIP ───────────────────────────────────────────────
//
// A "bundle" is one CalibrationSettingsGroup — every frame sharing the same
// exposure/binning/gain/TEC temperature, the grouping a stacking app actually
// matches calibration frames by. Same two-step signed-URL flow as the
// whole-object ZIP above (a browser <a download> click cannot send an
// Authorization header): POST .../link mints a short-lived token, GET
// consumes it. The (scope, folderName, key) selector is opaque-encoded into
// the path itself (never a client-supplied file path) so the GET route can
// re-derive the exact file list from a fresh, authoritative filesystem scan —
// findCalibrationBundle() re-scans rather than trusting anything decoded here.

interface CalibrationBundleSelector {
  scope: string | null;
  folderName: string;
  key: string;
}

function encodeCalibrationBundleId(sel: CalibrationBundleSelector): string {
  return Buffer.from(JSON.stringify(sel)).toString('base64url');
}

function decodeCalibrationBundleId(id: string): CalibrationBundleSelector | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' || parsed === null ||
      !('folderName' in parsed) || !('key' in parsed) || !('scope' in parsed)
    ) return null;
    const { scope, folderName, key } = parsed as Record<string, unknown>;
    if ((scope !== null && typeof scope !== 'string') || typeof folderName !== 'string' || typeof key !== 'string') {
      return null;
    }
    return { scope, folderName, key };
  } catch {
    return null;
  }
}

const CalibrationBundleLinkBodySchema = z.object({
  scope: z.string().nullable(),
  folderName: z.string().min(1),
  key: z.string().min(1),
});

router.post('/calibrations/download/link', strictRateLimiter, (req: Request, res: Response) => {
  const parsed = CalibrationBundleLinkBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(400, 'INVALID_BODY', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { scope, folderName, key } = parsed.data;
  const found = findCalibrationBundle(scope, folderName, key);
  if (!found) {
    res.apiError(404, 'BUNDLE_NOT_FOUND', 'No matching calibration bundle — the archive may have changed since this page loaded');
    return;
  }

  const id = encodeCalibrationBundleId({ scope, folderName, key });
  // Scope must match the prefix-stripped path the browser GET produces, which
  // the auth middleware compares against decodeURIComponent(req.path).
  const token = mintDownloadToken(`/library/calibrations/download/${id}`);

  res.apiSuccess({
    url: `/api/v1/library/calibrations/download/${id}?t=${encodeURIComponent(token)}`,
    filename: `${calibrationBundleName(found.group, found.set)}.zip`,
    expiresInMs: DOWNLOAD_TOKEN_TTL_MS,
  });
});

router.get('/calibrations/download/:id', strictRateLimiter, async (req: Request, res: Response) => {
  const decoded = decodeCalibrationBundleId(String(req.params.id));
  if (!decoded) {
    res.apiError(400, 'INVALID_BUNDLE_ID', 'Malformed bundle id');
    return;
  }
  const found = findCalibrationBundle(decoded.scope, decoded.folderName, decoded.key);
  if (!found) {
    res.apiError(404, 'BUNDLE_NOT_FOUND', 'No matching calibration bundle — the archive may have changed since this link was created');
    return;
  }

  try {
    const zipName = `${calibrationBundleName(found.group, found.set)}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', contentDispositionHeader('attachment', zipName));

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err: Error) => {
      if (!res.headersSent) res.status(500).send(err.message);
    });
    archive.pipe(res);

    for (const f of found.set.files) {
      if (fs.existsSync(f.path)) {
        archive.file(f.path, { name: f.name });
      }
    }

    await archive.finalize();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bundle download failed';
    if (!res.headersSent) res.status(500).send(message);
  }
});

router.get('/objects', (req: Request, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const objects = getLocalObjects(req.userId ?? '', search);
    res.apiSuccess(groupByVariants(objects));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list objects';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

/**
 * The trash: objects and sessions deleted locally but not yet restored or
 * re-synced. Registered before `/objects/:objectId` below — as literal path
 * segments in that position they would otherwise be swallowed by it (Express
 * would try to look up an object literally named "deleted").
 */
router.get('/objects/deleted', requireAdmin, (_req: Request, res: Response) => {
  try {
    res.apiSuccess(listDeletedObjects());
  } catch (err) {
    res.apiError(500, 'LIST_FAILED', err instanceof Error ? err.message : 'Failed to list deleted objects');
  }
});

router.get('/objects/deleted-sessions', requireAdmin, (_req: Request, res: Response) => {
  try {
    res.apiSuccess(listDeletedSessions());
  } catch (err) {
    res.apiError(500, 'LIST_FAILED', err instanceof Error ? err.message : 'Failed to list deleted sessions');
  }
});

/**
 * Detail for a single library object. Returns the same shape one entry from
 * `GET /objects` would have (with variants merged), so the iOS/tvOS clients
 * that fetch object metadata by id (`getObjectDetail`) can decode it directly.
 *
 * Resolves variant IDs to their primary entry — e.g. requesting M31_Mosaic
 * returns the M31 row with the mosaic listed under `variants`. This mirrors
 * the redirect the web app does on /object/:id.
 */
router.get('/objects/:objectId', (req: Request, res: Response) => {
  try {
    const requestedId = String(req.params.objectId);
    const all = getLocalObjects(req.userId ?? '');
    const grouped = groupByVariants(all);
    const match = grouped.find(o =>
      o.id === requestedId
      || o.variants.some(v => v.objectId === requestedId),
    );
    if (!match) {
      res.apiError(404, 'NOT_FOUND', `Library object "${requestedId}" not found`);
      return;
    }
    res.apiSuccess(match);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch object';
    res.apiError(500, 'GET_FAILED', message);
  }
});

// ─── Thumbnail ────────────────────────────────────────────────────────────────
//
// Disk-cache keys are sha256 hashes (objectThumbnailDiskCacheKey /
// fileThumbnailDiskCacheKey in library/gallery.ts): a raw base64url of
// `path:WxH:mtime` grows with the path, and a Dwarf's device-folder-plus-
// filename combination pushes it past the OS's 255-byte filename-component
// limit, so sharp's toFile() fails with ENAMETOOLONG and the `<img>` breaks.

router.get('/objects/:objectId/thumbnail', async (req: Request, res: Response) => {
  try {
    if (!(await requireLibraryReachable(res))) return;
    const objectId = String(req.params.objectId);
    const w = Math.min(Math.max(parseInt(queryString(req.query.w) || '400', 10) || 400, 32), 1200);
    const h = Math.min(Math.max(parseInt(queryString(req.query.h) || '400', 10) || 400, 32), 1200);
    const preferRaw = queryString(req.query.prefer);
    const prefer: 'sky' | 'telescope' | undefined =
      preferRaw === 'sky' || preferRaw === 'telescope' ? preferRaw : undefined;

    const srcPath = await resolveObjectImagePath(objectId, prefer);
    if (!srcPath) {
      res.status(404).send('No image available');
      return;
    }

    // Include source mtime in the cache key so an in-place overwrite
    // (e.g. re-uploading a custom gallery_<id>.jpg, or a refreshed catalog
    // master) busts the disk-cached thumbnail. Without mtime, srcPath alone
    // would map to the same .jpg forever even after the source bytes change.
    let mtimeMs: number;
    try {
      mtimeMs = (await statLibraryFileForServe(srcPath)).mtimeMs;
    } catch (err) {
      respondFsGuardError(res, err);
      return;
    }
    const cacheKey = objectThumbnailDiskCacheKey(srcPath, w, h, mtimeMs);
    const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);

    if (!fs.existsSync(cachePath)) {
      try {
        fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
        // Capped so a dashboard/calendar fan-out of cold thumbnails can't
        // saturate the threadpool and time out sibling requests.
        await runRender(() => sharp(srcPath)
          .resize(w, h, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, progressive: true })
          .toFile(cachePath));
      } catch (sharpErr) {
        // A source sharp cannot decode is SKIPPED, never deleted. This route is
        // public (see the auth bypass list in middleware/auth.ts), and `srcPath`
        // is whatever resolveObjectImagePath picked — one user's gallery image,
        // or the shared catalog master in the sky cache. On an earlier version a
        // single unauthenticated GET of an undecodable source was therefore
        // enough to destroy bytes on disk, and the sibling /file/thumbnail route
        // has never done it. A decode failure is also not proof the file is
        // worthless: a truncated-but-recoverable image is exactly the case that
        // reaches this branch.
        const msg = sharpErr instanceof Error ? sharpErr.message : '';
        if (msg.includes('corrupt') || msg.includes('not a known file format')) {
          console.warn(`[thumbnail] source is not decodable, leaving it in place: ${srcPath}`);
        }
        if (!res.headersSent) res.status(404).send('No image available');
        return;
      }
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(cachePath);
  } catch (err) {
    console.error('[thumbnail] failed to generate:', err);
    if (!res.headersSent) res.status(500).send('Failed to generate thumbnail');
  }
});

// ─── Sessions ────────────────────────────────────────────────────────────────

router.get('/objects/:objectId/sessions', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  // `?includeVariants=true` merges sessions across the base object AND all
  // its variants (e.g. M31, M31_Mosaic, M31_Ha) — matching what the web UI
  // shows on /object/:id. Default behavior (no flag) is unchanged: only the
  // exact objectId's sessions are returned, for callers that need a single
  // variant in isolation (e.g. delete-session UI).
  const includeVariants = req.query.includeVariants === 'true';
  try {
    if (!includeVariants) {
      const sessions = getLocalSessions(objectId);
      res.apiSuccess(sessions);
      return;
    }

    // Discover variants: same logic the library-objects endpoint uses to group
    // M31 + M31_Mosaic + M31_Ha into one card. We re-run it here scoped to the
    // requested object's variant family rather than the whole library.
    const all = getLocalObjects(req.userId ?? '');
    const grouped = groupByVariants(all);
    const family = grouped.find(g => g.id === objectId || g.variants.some(v => v.objectId === objectId));
    const ids = family
      ? [family.id, ...family.variants.map(v => v.objectId)]
      : [objectId];

    // Fetch sessions for each id, annotate each session with which variant
    // it came from so the client can show a small "Mosaic" / "Ha" pill, then
    // sort newest-first to match the web view.
    const merged = ids.flatMap(id => {
      const variantLabel = family && id !== family.id
        ? family.variants.find(v => v.objectId === id)?.label ?? null
        : null;
      return getLocalSessions(id).map(s => ({
        ...s,
        sourceObjectId: id,
        variantLabel,
      }));
    });
    merged.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    res.apiSuccess(merged);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list sessions';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// Where an object's (or one session's) files live on disk / on the telescope,
// for the "Show file location" panel. `?date=` scopes to a session; without it,
// the whole variant family's folders are returned so the object card's
// location covers M31 + M31_Mosaic + M31_Ha.
router.get('/objects/:objectId/location', async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
  try {
    const primary = await getObjectLocation(objectId, date);

    let variants: Array<{ objectId: string; label: string; relPath: string; path: string; exists: boolean }> = [];
    if (!date) {
      const grouped = groupByVariants(getLocalObjects(req.userId ?? ''));
      const family = grouped.find(g => g.id === objectId || g.variants.some(v => v.objectId === objectId));
      if (family) {
        const ids = [family.id, ...family.variants.map(v => v.objectId)].filter(id => id !== objectId);
        variants = await Promise.all(
          ids.map(async id => {
            const loc = await getObjectLocation(id);
            const label =
              family.id === id ? 'Primary' : family.variants.find(v => v.objectId === id)?.label ?? id;
            return { objectId: id, label, ...loc.object };
          }),
        );
      }
    }

    res.apiSuccess({ ...primary, variants });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve file location';
    res.apiError(500, 'LOCATION_FAILED', message);
  }
});

// ─── Delete object / session (tombstone) ─────────────────────────────────────

// A running import can be actively writing into the same directory tree
// these routes delete/move from (a new file mid-copy, a session folder being
// created). Refused outright rather than age-gated or best-effort, same
// posture as the import-tmp cleanup routes above.
// ─── Product tour demo object ────────────────────────────────────────────────
// The tour needs a real object to walk through on an install that has none
// yet. It is planted when the tour starts and removed when the tour ends, so
// it is never left sitting in the user's library. Both are no-ops when the
// library already holds real objects (nothing is planted) or when nothing is
// planted (nothing to remove).

router.post('/sample-object', requireAdmin, async (_req: Request, res: Response) => {
  const planted = await plantSampleObject();
  if (planted.object) invalidateAllImagesCache();
  res.apiSuccess(planted);
});

router.delete('/sample-object', requireAdmin, (_req: Request, res: Response) => {
  const purged = purgeSampleObject();
  if (purged.object) invalidateAllImagesCache();
  res.apiSuccess(purged);
});

router.delete('/objects/:objectId', requireAdmin, (req: Request, res: Response) => {
  if (getImportStatus().running) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is running. Wait for it to finish, then delete.');
    return;
  }
  const objectId = String(req.params.objectId);
  try {
    deleteLocalObject(objectId);
    invalidateAllImagesCache();
    res.apiSuccess({ deleted: true, objectId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    res.apiError(500, 'DELETE_FAILED', message);
  }
});

router.delete('/objects/:objectId/sessions/:date', requireAdmin, (req: Request, res: Response) => {
  if (getImportStatus().running) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is running. Wait for it to finish, then delete.');
    return;
  }
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  try {
    deleteLocalSession(objectId, date);
    invalidateAllImagesCache();
    res.apiSuccess({ deleted: true, objectId, date });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    res.apiError(500, 'DELETE_FAILED', message);
  }
});

// ─── Restore from the trash ──────────────────────────────────────────────────
//
// Restoring is a pure DB flag flip, not a filesystem write into the tree an
// import walks, so unlike the deletes above it is not refused while an import
// is running: there is nothing here for a concurrent import to race against.
// It re-enables sync; it does not bring back the local files a delete already
// removed, which is exactly the distinction the confirm copy on the delete
// dialogs now states plainly.

router.post('/objects/:objectId/restore', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    const restored = restoreLocalObject(objectId);
    if (!restored) {
      res.apiError(404, 'NOT_FOUND', `"${objectId}" is not in the trash.`);
      return;
    }
    res.apiSuccess({ restored: true, objectId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Restore failed';
    res.apiError(500, 'RESTORE_FAILED', message);
  }
});

router.post('/objects/:objectId/sessions/:date/restore', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  try {
    const restored = restoreLocalSession(objectId, date);
    if (!restored) {
      res.apiError(404, 'NOT_FOUND', `The ${date} session of "${objectId}" is not in the trash.`);
      return;
    }
    res.apiSuccess({ restored: true, objectId, date });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Restore failed';
    res.apiError(500, 'RESTORE_FAILED', message);
  }
});

router.delete('/objects/:objectId/sessions/:date/subframes', requireAdmin, (req: Request, res: Response) => {
  if (getImportStatus().running) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is running. Wait for it to finish, then delete.');
    return;
  }
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  try {
    const result = deleteSessionSubFrames(objectId, date);
    res.apiSuccess({ ...result, objectId, date });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    res.apiError(500, 'DELETE_FAILED', message);
  }
});

// ─── Move observation ────────────────────────────────────────────────────────

router.post('/objects/:objectId/sessions/:date/move', requireAdmin, (req: Request, res: Response) => {
  if (getImportStatus().running) {
    res.apiError(409, 'IMPORT_RUNNING', 'An import is running. Wait for it to finish, then move.');
    return;
  }
  const fromObjectId = String(req.params.objectId);
  const date = String(req.params.date);
  const bodyParsed = MoveObservationBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'MISSING_TARGET', bodyParsed.error.issues[0]?.message ?? 'toObjectId is required');
    return;
  }
  const { toObjectId } = bodyParsed.data;

  try {
    const result = moveObservation(fromObjectId, date, toObjectId.trim());
    res.apiSuccess({ moved: result.moved, fromObjectId, toObjectId: toObjectId.trim(), date });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Move failed';
    res.apiError(500, 'MOVE_FAILED', message);
  }
});

// ─── Files ────────────────────────────────────────────────────────────────────

router.get('/objects/:objectId/sessions/:date/files', async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  try {
    if (!(await requireLibraryReachable(res))) return;
    const files = getLocalFiles(objectId, date);
    res.apiSuccess(files);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list files';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

router.get('/objects/:objectId/files', async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    if (!(await requireLibraryReachable(res))) return;
    const files = getLocalFiles(objectId);
    res.apiSuccess(files);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list files';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// ─── File download/view ───────────────────────────────────────────────────────

router.get('/file', async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.status(400).send('Missing path');
    return;
  }
  if (!(await requireLibraryReachable(res))) return;

  const result = await getLocalFile(filePath);
  if (!result) {
    res.status(404).send('Not found');
    return;
  }

  const mimeType = mimeTypeForExtension(result.name);
  const isInline = mimeType.startsWith('image/');

  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'public, max-age=3600');
  if (!isInline) {
    res.set('Content-Disposition', contentDispositionHeader('attachment', result.name));
  }
  res.send(result.data);
});

// ─── Video streaming (inline, byte-range) ────────────────────────────────────
//
// Separate from `/file` for two reasons:
//   1. `/file` reads the whole file into a Buffer and sends it with no `Range`
//      support. A `<video>` element (Safari especially) needs `206 Partial
//      Content` to play at all, and an AVPlayer / ExoPlayer on the native
//      clients seeks with range requests. `res.sendFile` streams from disk and
//      implements the entire range contract (206, Content-Range, 416, If-Range,
//      HEAD) — do not hand-roll it.
//   2. `/file` sets `Content-Disposition: attachment` for non-images so the
//      Download button downloads. This route sets `inline` so the same file can
//      also be played in place.
// Only H.264 MP4 / MOV actually plays in a browser or on the mobile clients;
// raw AVI (older SeeStar planetary captures) is served correctly here but the
// UI must fall back to a download for it.
const STREAMABLE_VIDEO_EXTS = new Set(['mp4', 'mov', 'avi']);

router.get('/video', async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.status(400).send('Missing path');
    return;
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (!STREAMABLE_VIDEO_EXTS.has(ext)) {
    res.status(415).type('text/plain').send('Unsupported file type for video streaming');
    return;
  }

  // Resolve and contain inside the library root, trailing-separator compared so
  // a sibling like `<...>/library-x` can't satisfy a bare startsWith. Same guard
  // as /file/thumbnail.
  const LIBRARY_DIR = getLibraryDir();
  const absPath = path.resolve(LIBRARY_DIR, filePath);
  const libRoot = LIBRARY_DIR.endsWith(path.sep) ? LIBRARY_DIR : LIBRARY_DIR + path.sep;
  if (!absPath.startsWith(libRoot)) {
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }

  if (!(await requireLibraryReachable(res))) return;
  try {
    await statLibraryFileForServe(absPath);
  } catch {
    res.status(404).type('text/plain').send('Not found');
    return;
  }

  const mimeType = ext === 'mp4' ? 'video/mp4' : ext === 'mov' ? 'video/quicktime' : 'video/x-msvideo';
  res.type(mimeType);
  res.set('Content-Disposition', contentDispositionHeader('inline', path.basename(absPath)));
  res.set('Cache-Control', 'public, max-age=3600');

  res.sendFile(absPath, { acceptRanges: true, dotfiles: 'deny' }, (err) => {
    if (!err) return;
    // A dropped connection mid-stream surfaces here as ECONNABORTED / write
    // after end — not an error worth logging or responding to.
    if (res.headersSent) return;
    const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
    res.status(status).type('text/plain').send('Could not read video');
  });
});

// ─── Thumbnail (on-demand resize with disk cache) ────────────────────────────

/**
 * In-flight thumbnail renders, keyed by cache key.
 *
 * Concurrent requests for the same uncached thumbnail share one sharp decode
 * instead of racing. That matters most for the formats this route exists to
 * convert: a 32-bit float TIFF at sensor resolution is around 100 MB, and the
 * observation page requests the same one more than once on load.
 */
const inFlightThumbnails = new Map<string, Promise<void>>();

async function renderThumbnailOnce(
  cacheKey: string,
  cachePath: string,
  absPath: string,
  w: number,
  h: number,
): Promise<void> {
  const existing = inFlightThumbnails.get(cacheKey);
  if (existing) return existing;

  const work = (async () => {
    fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
    // Write to a temp path and rename, so a concurrent reader can never pick up
    // a half-written JPEG (sendFile does not coordinate with this write).
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    try {
      await sharp(absPath)
        .resize(w, h, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toFile(tmpPath);
      await fs.promises.rename(tmpPath, cachePath);
    } catch (err) {
      try { await fs.promises.rm(tmpPath, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  })().finally(() => {
    inFlightThumbnails.delete(cacheKey);
  });

  inFlightThumbnails.set(cacheKey, work);
  return work;
}

router.get('/file/thumbnail', burstyRateLimiter, async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.status(400).send('Missing path');
    return;
  }

  // Ceiling is the full-screen preview tier (previewUrl asks for 2048); the
  // grid card asks for the 400 default. Anything larger than 2048 is past what
  // any client displays and just bloats the on-disk thumbnail cache.
  const w = Math.min(Math.max(parseInt(queryString(req.query.w) || '400', 10) || 400, 32), 2048);
  const h = Math.min(Math.max(parseInt(queryString(req.query.h) || '400', 10) || 400, 32), 2048);

  // Only serve image files — reject FITS/video. No library pipeline can ever
  // produce a .webp (not in ALLOWED_UPLOAD_EXTS above, PROCESSED_FORMATS in
  // lib/library/processed.ts, or REAL_EXTENSIONS in lib/telescopeFiles.ts),
  // so it was dead and inconsistent here; keep this list matching those.
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (!['jpg', 'jpeg', 'png', 'tif', 'tiff'].includes(ext)) {
    res.status(415).send('Unsupported file type for thumbnail');
    return;
  }

  // Resolve absolute path and keep it inside LIBRARY_DIR. Compare against the
  // directory *with a trailing separator* so a sibling like `<...>/library-x`
  // can't satisfy a bare `startsWith('<...>/library')` and escape the root.
  const LIBRARY_DIR = getLibraryDir();
  const absPath = path.resolve(LIBRARY_DIR, filePath);
  const libRoot = LIBRARY_DIR.endsWith(path.sep) ? LIBRARY_DIR : LIBRARY_DIR + path.sep;
  if (!absPath.startsWith(libRoot)) {
    res.status(403).send('Forbidden');
    return;
  }

  if (!(await requireLibraryReachable(res))) return;

  // Cache key includes mtime, matching the object-thumbnail route above: without
  // it an in-place overwrite (a re-import replacing the same filename) serves the
  // old thumbnail forever. `stat` doubles as the existence guard.
  let mtimeMs = 0;
  try {
    mtimeMs = (await statLibraryFileForServe(absPath)).mtimeMs;
  } catch (err) {
    respondFsGuardError(res, err);
    return;
  }
  const cacheKey = fileThumbnailDiskCacheKey(filePath, w, h, mtimeMs);
  const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);

  try {
    if (!fs.existsSync(cachePath)) {
      // Single-flight per cache key. This route converts formats a browser
      // cannot display, which now includes a Dwarf's ~100 MB 32-bit float
      // `img_stacked_all.tif`. An observation page asks for the same file twice
      // at once (hero plus grid card), and without this each request starts its
      // own 100 MB decode. `runRender` additionally caps how many *distinct*
      // renders run at once so a calendar-load burst can't starve the
      // threadpool (which used to surface as 5s timeouts → 404s here).
      await runRender(() => renderThumbnailOnce(cacheKey, cachePath, absPath, w, h));
    }

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(cachePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Thumbnail generation failed';
    // Explicit text/plain: res.send(string) defaults to text/html, and this
    // message can carry the request's own `path` query value (e.g. inside an
    // ENOENT message), which the browser would otherwise be free to render
    // and, in principle, execute as markup.
    res.status(500).type('text/plain').send(msg);
  }
});

// ─── FITS thumbnail (colorized MTF autostretch → JPEG, generate-if-missing) ──
//
// Serves the pre-rendered JPEG for a FITS sub-frame so clients (mobile
// especially) never download and decode the full multi-MB FITS just to show a
// preview. Thumbnails are generated eagerly on import; this route lazily
// generates any that are missing (older imports, or the 1024px preview tier
// which is not pre-generated) and caches the result on disk next to the file.
router.get('/fits-thumbnail', async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.status(400).send('Missing path');
    return;
  }

  const tier: FitsThumbnailTier = queryString(req.query.size) === 'preview' ? 'preview' : 'thumb';

  // Only FITS files have a renderable thumbnail.
  if (!/\.f(?:it|its|ts)$/i.test(filePath)) {
    res.status(415).send('Unsupported file type for FITS thumbnail');
    return;
  }

  // Resolve absolute path and keep it inside LIBRARY_DIR. Compare against the
  // directory *with a trailing separator* so a sibling like `<...>/library-x`
  // can't satisfy a bare `startsWith('<...>/library')` and escape the root.
  const LIBRARY_DIR = getLibraryDir();
  const absPath = path.resolve(LIBRARY_DIR, filePath);
  const libRoot = LIBRARY_DIR.endsWith(path.sep) ? LIBRARY_DIR : LIBRARY_DIR + path.sep;
  if (!absPath.startsWith(libRoot)) {
    res.status(403).send('Forbidden');
    return;
  }

  if (!(await requireLibraryReachable(res))) return;

  try {
    await statLibraryFileForServe(absPath);
  } catch (err) {
    respondFsGuardError(res, err);
    return;
  }

  const thumbPath = fitsThumbnailPath(absPath, tier);
  try {
    // No-ops if it already exists; otherwise parses + renders + writes. The
    // cache-hit check stays outside the render cap so a warm burst never
    // queues; only an actual render takes a slot.
    if (!fs.existsSync(thumbPath)) {
      await runRender(() => generateFitsThumbnail(absPath, tier));
    }
    // Read + send the buffer rather than res.sendFile: the thumbnail lives in a
    // `.thumbs/` directory, and Express's sendFile (via `send`) defaults to
    // dotfiles:'ignore', which 404s any path with a dot-prefixed segment.
    const data = await fs.promises.readFile(thumbPath);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'FITS thumbnail generation failed';
    // See the /file/thumbnail route above — explicit text/plain so a `path`
    // value reflected into the error message is never eligible for the
    // browser to render as HTML.
    res.status(500).type('text/plain').send(msg);
  }
});

// ─── TIFF thumbnail (linear-float MTF autostretch → JPEG, generate-if-missing) ──
//
// A Dwarf's `img_stacked_all.tif` master stack is ~100 MB of 32-bit float
// scene-linear data. sharp's normal resize+encode reads it as clipped-white
// (see server/lib/tiffThumbnail.ts for the measurements), so this route
// exists the same way /fits-thumbnail does: decode the true samples and
// autostretch before ever handing bytes to sharp, then cache the JPEG.
router.get('/tiff-thumbnail', async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.status(400).send('Missing path');
    return;
  }

  const tier: TiffThumbnailTier = queryString(req.query.size) === 'preview' ? 'preview' : 'thumb';

  if (!/\.tiff?$/i.test(filePath)) {
    res.status(415).send('Unsupported file type for TIFF thumbnail');
    return;
  }

  const LIBRARY_DIR = getLibraryDir();
  const absPath = path.resolve(LIBRARY_DIR, filePath);
  const libRoot = LIBRARY_DIR.endsWith(path.sep) ? LIBRARY_DIR : LIBRARY_DIR + path.sep;
  if (!absPath.startsWith(libRoot)) {
    res.status(403).send('Forbidden');
    return;
  }

  if (!(await requireLibraryReachable(res))) return;

  try {
    await statLibraryFileForServe(absPath);
  } catch (err) {
    respondFsGuardError(res, err);
    return;
  }

  const thumbPath = tiffThumbnailPath(absPath, tier);
  try {
    if (!fs.existsSync(thumbPath)) {
      await runRender(() => generateTiffThumbnail(absPath, tier));
    }
    // Read + send the buffer rather than res.sendFile: the thumbnail lives in
    // a `.thumbs/` directory, and Express's sendFile (via `send`) defaults to
    // dotfiles:'ignore', which 404s any path with a dot-prefixed segment.
    const data = await fs.promises.readFile(thumbPath);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'TIFF thumbnail generation failed';
    res.status(500).type('text/plain').send(msg);
  }
});

// ─── Capture summaries for every night of one object ─────────────────────────

/**
 * What the device recorded for each observing night of this object, keyed by
 * night. One indexed query and no filesystem work, which is what makes it
 * cheap enough for the object page to ask for on load.
 *
 * Deliberately not the same thing as `/integration`: that one opens every
 * sub-frame's FITS header to estimate exposure. This reads the device's own
 * sidecar, so it is both exact and free, and simply has nothing to say for a
 * telescope that writes no sidecar. An absent night means "not recorded", never
 * "zero", and the UI must render it as absent.
 */
router.get('/objects/:objectId/capture', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const byNight = new Map<string, CaptureInfoRow[]>();
  for (const row of getCaptureInfoForObject(objectId)) {
    if (!row.sessionDate) continue;
    const rows = byNight.get(row.sessionDate);
    if (rows) rows.push(row);
    else byNight.set(row.sessionDate, [row]);
  }

  const result: Record<string, SessionCaptureSummary> = {};
  for (const [date, rows] of byNight) {
    const summary = summarizeSessionCapture(rows);
    if (summary) result[date] = summary;
  }
  res.apiSuccess(result);
});

// ─── Integration stats (local sub-frames only) ───────────────────────────────

router.get('/objects/:objectId/integration', async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    if (!(await requireLibraryReachable(res))) return;
    const stats = getLocalIntegrationStats(objectId);
    res.apiSuccess(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute integration stats';
    res.apiError(500, 'STATS_FAILED', message);
  }
});

// ─── FITS header (local file) ─────────────────────────────────────────────────

router.get('/headers', async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.apiError(400, 'MISSING_PATH', 'Query parameter "path" is required');
    return;
  }
  if (!(await requireLibraryReachable(res))) return;

  const header = getLocalFitsHeader(filePath);
  if (!header) {
    res.apiError(404, 'NOT_FOUND', 'File not found in local library');
    return;
  }

  const essential = ['SIMPLE', 'BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'BZERO', 'BSCALE'];
  const observation = ['OBJECT', 'DATE-OBS', 'EXPTIME', 'EXPOSURE', 'GAIN', 'EGAIN', 'FILTER', 'INSTRUME'];
  const coordinates = ['RA', 'DEC', 'CRVAL1', 'CRVAL2', 'OBJCTRA', 'OBJCTDEC', 'SITELAT', 'SITELONG'];
  const sensor = ['CCD-TEMP', 'TEMPERAT', 'TEMP', 'XBINNING', 'YBINNING', 'FOCUSPOS', 'IMAGETYP'];
  const quality = ['HFR', 'FWHM', 'STARS', 'STARCOUNT', 'STARCNT', 'BACKGND', 'PEDESTAL', 'NOISE', 'SKYLEVEL'];

  const categorized = {
    essential: header.cards.filter(c => essential.includes(c.key)),
    observation: header.cards.filter(c => observation.includes(c.key)),
    coordinates: header.cards.filter(c => coordinates.includes(c.key)),
    sensor: header.cards.filter(c => sensor.includes(c.key)),
    quality: header.cards.filter(c => quality.includes(c.key)),
    other: header.cards.filter(c =>
      !essential.includes(c.key) && !observation.includes(c.key) &&
      !coordinates.includes(c.key) && !sensor.includes(c.key) &&
      !quality.includes(c.key) && c.key !== 'COMMENT' && c.key !== 'HISTORY' && c.key !== ''
    ),
    comments: header.cards.filter(c => c.key === 'COMMENT' || c.key === 'HISTORY'),
  };

  res.apiSuccess({ cards: header.cards, values: header.values, categorized });
});

// ─── ZIP download (local files only) ─────────────────────────────────────────

// Mint a short-lived signed URL for the whole-object ZIP below. Authenticated
// (any signed-in role — a download is a read), because the browser's <a download>
// click that ultimately hits the ZIP route cannot send an Authorization header.
// The returned URL carries `?t=<token>` which server/middleware/auth.ts verifies
// against this exact path. See lib/downloadToken.ts.
const DownloadLinkBodySchema = z.object({
  fileType: z.string().optional(),
  date: z.string().optional(),
  includeVariants: z.boolean().optional(),
});

router.post('/download/objects/:objectId/link', strictRateLimiter, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const parsed = DownloadLinkBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(400, 'INVALID_BODY', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { fileType, date, includeVariants } = parsed.data;

  // Scope must match the prefix-stripped path the browser GET produces, which
  // the auth middleware compares against decodeURIComponent(req.path).
  const scope = `/library/download/objects/${objectId}`;
  const token = mintDownloadToken(scope);

  const params = new URLSearchParams();
  if (fileType) params.set('fileType', fileType);
  if (date) params.set('date', date);
  if (includeVariants) params.set('includeVariants', 'true');
  params.set('t', token);

  res.apiSuccess({
    url: `/api/v1/library/download/objects/${encodeURIComponent(objectId)}?${params.toString()}`,
    expiresInMs: DOWNLOAD_TOKEN_TTL_MS,
  });
});

// Shared by the summary route (below) and the ZIP stream route, so "how many
// files / how many bytes" can never drift from what actually gets zipped.
function resolveObjectDownloadFiles(
  objectId: string,
  userId: string,
  opts: { fileType?: string; sessionDate?: string; includeVariants?: boolean },
) {
  // `includeVariants` pulls in files from every variant of this object (e.g.
  // M8 + M8_Mosaic), matching what the web UI's "Observations" grid and
  // session count show. Without it, "Download All" silently omits any date
  // that only exists under a variant id. Same family-discovery logic as the
  // `/sessions?includeVariants=true` route above.
  let ids = [objectId];
  if (opts.includeVariants) {
    const all = getLocalObjects(userId);
    const grouped = groupByVariants(all);
    const family = grouped.find(g => g.id === objectId || g.variants.some(v => v.objectId === objectId));
    ids = family ? [family.id, ...family.variants.map(v => v.objectId)] : [objectId];
  }
  let files = ids.flatMap(id => getLocalFiles(id, opts.sessionDate));
  files = files.filter(f => !f.isThumbnail);
  if (opts.fileType && opts.fileType !== 'all') {
    files = files.filter(f => f.type === opts.fileType);
  }
  return files;
}

// Lets the web UI show "X files, Y GB" in a confirmation dialog before the
// user commits to zipping and downloading the whole object. Cheap: the file
// stat work it does is the same `getLocalFiles` walk the ZIP route already
// pays for, just without archiver in the loop.
router.get('/download/objects/:objectId/summary', strictRateLimiter, async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const fileType = queryString(req.query.fileType);
  const sessionDate = queryString(req.query.date);
  const includeVariants = req.query.includeVariants === 'true';

  try {
    if (!(await requireLibraryReachable(res))) return;
    const files = resolveObjectDownloadFiles(objectId, req.userId ?? '', { fileType, sessionDate, includeVariants });
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    res.apiSuccess({ fileCount: files.length, totalBytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to summarize download';
    res.apiError(500, 'DOWNLOAD_SUMMARY_FAILED', message);
  }
});

router.get('/download/objects/:objectId', strictRateLimiter, async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const fileType = queryString(req.query.fileType); // 'image', 'fits', 'all'
  const sessionDate = queryString(req.query.date);
  const includeVariants = req.query.includeVariants === 'true';

  try {
    if (!(await requireLibraryReachable(res))) return;
    const files = resolveObjectDownloadFiles(objectId, req.userId ?? '', { fileType, sessionDate, includeVariants });

    if (files.length === 0) {
      res.apiError(404, 'NO_FILES', 'No files match the filter criteria');
      return;
    }

    const zipName = `${objectId}${sessionDate ? `_${sessionDate}` : ''}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', contentDispositionHeader('attachment', zipName));

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err: Error) => {
      if (!res.headersSent) res.status(500).send(err.message);
    });
    archive.pipe(res);

    for (const f of files) {
      const fullPath = path.join(getLibraryDir(), f.path);
      if (fs.existsSync(fullPath)) {
        archive.file(fullPath, { name: f.path });
      }
    }

    await archive.finalize();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Download failed';
    if (!res.headersSent) res.status(500).send(message);
  }
});

// ─── Multi-session subframe ZIP ───────────────────────────────────────────────
//
// Three-phase flow:
//   1. POST /download/objects/:objectId/subframes
//      Validates request, kicks off async ZIP build, returns { jobId, filesTotal }.
//   2. GET  /download/status/:jobId   (poll every ~500ms)
//      Returns { status, filesDone, filesTotal, elapsedMs } while running,
//      adds { token, size } on done, adds { error } on failure.
//   3. GET  /download/tmp/:token      (auth-free — token IS the credential)
//      Serves the ZIP from disk, deletes it afterwards.

interface TempDownload {
  filePath: string;
  filename: string;
  expiresAt: number;
}
const tempDownloads = new Map<string, TempDownload>();
const MAX_TEMP_DOWNLOADS = 200;

interface ArchiveJob {
  filesTotal: number;
  filesDone: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  token?: string;
  filename?: string;
  size?: number;
  error?: string;
  startedAt: number;
  expiresAt: number;
  /** Set once the ZIP build starts; aborts the archiver + removes the partial file. */
  abort?: () => void;
}
const archiveJobs = new Map<string, ArchiveJob>();
const MAX_ARCHIVE_JOBS = 200;

/** Prefix every temp download ZIP is written with (`os.tmpdir()`). Used by the
 *  boot sweep below to find files a previous process left behind. */
const TEMP_DOWNLOAD_PREFIX = 'nebulis-';

/**
 * Delete the ZIP behind a cache entry and drop the entry. Every removal path
 * (expiry, eviction, one-shot serve) goes through here: deleting the map entry
 * alone left the file on disk forever, because the sweeper only ever looks at
 * entries still in the map.
 */
function deleteTempDownload(token: string): void {
  const meta = tempDownloads.get(token);
  if (!meta) return;
  tempDownloads.delete(token);
  fs.unlink(meta.filePath, () => { /* best-effort: the boot sweep also covers it */ });
}

/**
 * Remove `nebulis-*.zip` files no entry in this process owns. Nothing else
 * writes that prefix into the OS temp dir, and without this a restart orphaned
 * every ZIP the previous process had handed out (the map is in-memory, so the
 * tokens die with the process and the files were never referenced again).
 * Runs once, at module load, off the request path.
 */
function sweepOrphanedTempDownloads(): void {
  const dir = os.tmpdir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // unreadable temp dir: nothing we can safely do
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_DOWNLOAD_PREFIX) || !name.endsWith('.zip')) continue;
    const filePath = path.join(dir, name);
    let owned = false;
    for (const meta of tempDownloads.values()) {
      if (meta.filePath === filePath) { owned = true; break; }
    }
    if (owned) continue;
    // Only our own UUID-named archives: `nebulis-<uuid>.zip`.
    if (!/^nebulis-[0-9a-f-]{36}\.zip$/i.test(name)) continue;
    fs.unlink(filePath, () => { /* best-effort */ });
  }
}
sweepOrphanedTempDownloads();

// Periodic cleanup — remove expired tokens and jobs. unref: importing this
// router (e.g. tests/backend/routeDecoding.test.ts) must not pin the process's
// event loop open on a 10-minute interval no one is waiting on.
setInterval(() => {
  const now = Date.now();
  for (const [token, meta] of tempDownloads) {
    if (now > meta.expiresAt) deleteTempDownload(token);
  }
  for (const [id, job] of archiveJobs) {
    if (now > job.expiresAt) archiveJobs.delete(id);
  }
}, 10 * 60 * 1000).unref?.();

// Filter query — returns distinct filter names found across sub-frames for the given dates
router.post('/download/objects/:objectId/subframe-filters', strictRateLimiter, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const bodyParsed = z.object({
    dates: z.array(z.string()).min(1),
    includeVariants: z.boolean().optional(),
  }).safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'INVALID_DATES', 'dates must be a non-empty array');
    return;
  }
  // A mosaic/Ha/etc. variant's sub-frames live in that variant's own object
  // folder, not the base object's — see resolveVariantIds. Uses getLocalFiles
  // (same layout-aware, libraryFiles-backed accessor `getLocalSessions` uses)
  // rather than a flat readdir, because a nested object stores files under
  // per-session subfolders that a flat listing never sees.
  const ids = bodyParsed.data.includeVariants ? resolveVariantIds(objectId, req.userId ?? '') : [objectId];
  const filters = new Set<string>();
  for (const id of ids) {
    for (const date of bodyParsed.data.dates) {
      for (const f of getLocalFiles(id, date)) {
        if (f.fileType === 'sub' && f.filter) filters.add(f.filter);
      }
    }
  }
  res.apiSuccess({ filters: [...filters].sort() });
});

// Phase 1 — start async ZIP job
router.post('/download/objects/:objectId/subframes', strictRateLimiter, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const bodyParsed = SubframesBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'INVALID_DATES', bodyParsed.error.issues[0]?.message ?? 'dates must be a non-empty array');
    return;
  }
  const { dates, filters, includeVariants, sirilLayout } = bodyParsed.data;

  const filterSet = filters && filters.length > 0 ? new Set(filters) : null;
  // A mosaic/Ha/etc. variant's sub-frames live in that variant's own object
  // folder, not the base object's — see resolveVariantIds. Uses getLocalFiles
  // (same layout-aware, libraryFiles-backed accessor `getLocalSessions` uses)
  // rather than a flat readdir, because a nested object stores files under
  // per-session subfolders that a flat listing never sees.
  const ids = includeVariants ? resolveVariantIds(objectId, req.userId ?? '') : [objectId];
  const LIBRARY_DIR = getLibraryDir();
  const anyObjectExists = ids.some(id => {
    const objDir = path.resolve(LIBRARY_DIR, getObjectFolderName(id));
    return objDir.startsWith(LIBRARY_DIR + path.sep) && fs.existsSync(objDir);
  });
  if (!anyObjectExists) {
    res.apiError(404, 'NOT_FOUND', 'Object not found in local library');
    return;
  }

  const subFrames: { libPath: string }[] = [];
  for (const id of ids) {
    for (const date of dates) {
      for (const f of getLocalFiles(id, date)) {
        if (f.fileType !== 'sub') continue;
        if (filterSet !== null && (!f.filter || !filterSet.has(f.filter))) continue;
        subFrames.push({ libPath: f.path });
      }
    }
  }

  if (subFrames.length === 0) {
    res.apiError(404, 'NO_FILES', 'No subframes found for the selected sessions');
    return;
  }

  const nowDate = new Date();
  const datePart = nowDate.toISOString().slice(0, 10).replace(/-/g, '');
  const timePart = nowDate.toTimeString().slice(0, 8).replace(/:/g, '');
  const filename = `${objectId}-${datePart}${timePart}.zip`;
  const tmpPath = path.join(os.tmpdir(), `nebulis-${randomUUID()}.zip`);

  const jobId = randomUUID();
  const job: ArchiveJob = {
    filesTotal: subFrames.length,
    filesDone: 0,
    status: 'running',
    filename,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
  if (archiveJobs.size >= MAX_ARCHIVE_JOBS) {
    archiveJobs.delete(archiveJobs.keys().next().value!);
  }
  archiveJobs.set(jobId, job);

  // Respond immediately so client can start polling
  res.apiSuccess({ jobId, filesTotal: subFrames.length });

  // Build ZIP asynchronously
  const output = fs.createWriteStream(tmpPath);
  const archive = archiver('zip', { zlib: { level: 1 } });

  // Cancellation: the client's "Cancel" now actually stops the server work
  // instead of only halting the poll. abort() clears the pending file queue,
  // detaches the pipes, and we drop the partial ZIP.
  job.abort = () => {
    if (job.status !== 'running') return;
    job.status = 'cancelled';
    try { archive.abort(); } catch { /* best effort */ }
    fs.unlink(tmpPath, () => {});
  };

  archive.on('entry', () => { job.filesDone++; });

  output.on('close', () => {
    if (job.status === 'cancelled') { fs.unlink(tmpPath, () => {}); return; }
    const token = randomUUID();
    if (tempDownloads.size >= MAX_TEMP_DOWNLOADS) {
      // Evict AND delete: dropping only the map entry leaked the ZIP (the
      // per-token expiry sweeper never sees an entry that is no longer there).
      const oldest = tempDownloads.keys().next().value;
      if (oldest !== undefined) deleteTempDownload(oldest);
    }
    tempDownloads.set(token, { filePath: tmpPath, filename, expiresAt: Date.now() + 10 * 60 * 1000 });
    job.status = 'done';
    job.token = token;
    job.size = archive.pointer();
  });

  archive.on('error', (err: Error) => {
    fs.unlink(tmpPath, () => {});
    if (job.status === 'cancelled') return;
    job.status = 'error';
    job.error = err.message;
  });

  archive.pipe(output);

  // libPath is folderName-relative (may include a session subfolder for a
  // nested object); by default keep that structure in the zip entry name too,
  // both to avoid same-filename collisions across sessions and to stay
  // meaningful once extracted.
  //
  // With sirilLayout, flatten everything into `<objectFolder>/lights/` so the
  // archive extracts straight into a Siril working folder. Filenames are kept
  // as-is (SeeStar and Dwarf sub-frame names already carry a per-frame
  // timestamp), and any residual collision gets a `-2`, `-3` suffix.
  const sirilFolder = sirilLayout ? getObjectFolderName(objectId) : null;
  const usedNames = new Set<string>();
  for (const { libPath } of subFrames) {
    let entryName = libPath;
    if (sirilFolder) {
      const base = path.basename(libPath);
      entryName = `${sirilFolder}/lights/${base}`;
      if (usedNames.has(entryName)) {
        const ext = path.extname(base);
        const stem = ext ? base.slice(0, -ext.length) : base;
        let n = 2;
        while (usedNames.has(`${sirilFolder}/lights/${stem}-${n}${ext}`)) n++;
        entryName = `${sirilFolder}/lights/${stem}-${n}${ext}`;
      }
      usedNames.add(entryName);
    }
    archive.file(path.join(LIBRARY_DIR, libPath), { name: entryName });
  }

  archive.finalize();
});

// Phase 2 — poll job status
router.get('/download/status/:jobId', (req: Request, res: Response) => {
  const job = archiveJobs.get(String(req.params.jobId));
  if (!job) {
    res.apiError(404, 'NOT_FOUND', 'Job not found or expired');
    return;
  }
  const payload: Record<string, unknown> = {
    status: job.status,
    filesTotal: job.filesTotal,
    filesDone: job.filesDone,
    elapsedMs: Date.now() - job.startedAt,
  };
  if (job.status === 'done') {
    payload.token = job.token;
    payload.filename = job.filename;
    payload.size = job.size;
    archiveJobs.delete(String(req.params.jobId));
  }
  if (job.status === 'error' || job.status === 'cancelled') {
    payload.error = job.error;
    archiveJobs.delete(String(req.params.jobId));
  }
  res.apiSuccess(payload);
});

// Cancel an in-flight ZIP build. Without this "Cancel" only stopped the client
// poll while the server kept zipping (potentially tens of GB) to the tmp dir.
router.post('/download/status/:jobId/cancel', strictRateLimiter, (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = archiveJobs.get(jobId);
  if (job) {
    job.abort?.();
    archiveJobs.delete(jobId);
  }
  // Idempotent: an already-finished / unknown job is a successful no-op.
  res.apiSuccess({ cancelled: true });
});

// Phase 3 — serve pre-built ZIP via one-time token (auth-free; token = credential)
router.get('/download/tmp/:token', (req: Request, res: Response) => {
  const token = String(req.params.token);
  const meta = tempDownloads.get(token);

  if (!meta || Date.now() > meta.expiresAt) {
    res.apiError(404, 'EXPIRED', 'Download link has expired or does not exist');
    return;
  }

  tempDownloads.delete(token);

  res.download(meta.filePath, meta.filename, err => {
    fs.unlink(meta.filePath, () => {});
    if (err && !res.headersSent) res.apiError(500, 'SERVE_FAILED', 'Failed to send file');
  });
});

// ─── Delete local file ────────────────────────────────────────────────────────

router.delete('/file', requireAdmin, (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.apiError(400, 'MISSING_PATH', 'Query parameter "path" is required');
    return;
  }
  try {
    deleteLocalFile(filePath);
    invalidateAllImagesCache();
    res.apiSuccess({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    res.apiError(500, 'DELETE_FAILED', message);
  }
});

// ─── Manual observation creation ─────────────────────────────────────────────

const manualUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `manual_${Date.now()}_${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, fieldSize: 1 * 1024 * 1024 }, // 200 MB file, 1 MB fields
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png)$/i;
    cb(null, allowed.test(file.originalname));
  },
});

router.post('/manual-observations', requireAdmin, manualUpload.single('image'), (req: Request, res: Response) => {
  const { objectName, date, notes, telescopeId } = req.body || {};

  if (!objectName || typeof objectName !== 'string' || !objectName.trim()) {
    res.apiError(400, 'MISSING_OBJECT', 'objectName is required');
    return;
  }
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.apiError(400, 'INVALID_DATE', 'date must be YYYY-MM-DD');
    return;
  }

  let imageBuffer: Buffer | null = null;
  let imageExt: string | null = null;

  // req.file is already typed `Express.Multer.File | undefined` by @types/multer.
  const imageFile = req.file;
  if (imageFile) {
    try {
      imageBuffer = fs.readFileSync(imageFile.path);
      imageExt = imageFile.originalname.split('.').pop()?.toLowerCase() || 'jpg';
    } catch { /* ignore, treat as no image */ }
    try { fs.unlinkSync(imageFile.path); } catch { /* ignore */ }
  }

  log.info(
    { objectName: objectName.trim(), date },
    '[observation] Creating manual observation for %s on %s',
    objectName.trim(), date,
  );
  try {
    const telescopeIdValue = typeof telescopeId === 'string' && telescopeId.trim() ? telescopeId.trim() : null;
    const result = createManualObservation(objectName.trim(), date, imageBuffer, imageExt, telescopeIdValue);
    invalidateAllImagesCache();

    // Persist notes if provided
    if (notes && typeof notes === 'string' && notes.trim()) {
      const existing = getNote(result.objectId, date);
      if (!existing) {
        createNote({ objectId: result.objectId, date, notes: notes.trim() });
      }
    }

    res.apiSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create observation';
    res.apiError(500, 'CREATE_FAILED', message);
  }
});

// ─── Gallery image ──────────────────────────────────────────────────────────

/** Get the current gallery image path for an object.
 *
 * When no gallery image has been set and the catalog sky-image cache
 * has nothing for this object either, fall back to an existing
 * observation image (thumbnail → stacked → any) and persist it so the
 * UI doesn't show an empty placeholder.
 *
 * Auto-set (non-user-chosen) gallery images are re-evaluated on every
 * call: if a catalog image has since been downloaded, the auto-set
 * fallback is cleared so the catalog image takes over. This self-heals
 * the case where a telescope observation image was set as the fallback
 * before the Caldwell/catalog prefetch ran.
 */
router.get('/objects/:objectId/gallery-image', async (req: Request, res: Response) => {
  if (!(await requireLibraryReachable(res))) return;
  const objectId = String(req.params.objectId);
  const catalogId = normalizeCatalogId(objectId);
  const row = getGalleryImageRow(objectId);
  let galleryImage = row.galleryImage;

  const settings = getSettingsData();
  const preferTelescope = typeof settings.galleryImageSource === 'string'
    ? settings.galleryImageSource === 'telescope'
    : false;

  // Re-evaluate auto-set fallbacks: clear if a catalog image is now available
  // and the user hasn't chosen to prefer telescope images. If they prefer
  // telescope, keep the auto-set telescope image so the detail header matches
  // the library card (which also respects galleryImageSource).
  if (galleryImage && !row.userSet && !preferTelescope && hasCachedCatalogImage(catalogId)) {
    setGalleryImage(objectId, null);
    galleryImage = null;
  }

  const resolvedId = caldwellToNgcId(catalogId) ?? catalogId;

  // Set a fallback observation image only when no catalog image exists.
  // Also kick off a background DSS2 prefetch so the next request finds the
  // catalog image on disk — preventing the detail header and library card
  // from diverging on first visit.
  if (!hasCachedCatalogImage(catalogId)) {
    if (!galleryImage) {
      const fallback = findFallbackObservationImage(objectId);
      if (fallback) {
        setGalleryImage(objectId, fallback);
        galleryImage = fallback;
      }
    }
    const dsoEntry = getDsoById(resolvedId);
    const fov = fovForEntry(dsoEntry?.majorAxisArcmin ?? null);
    prefetchSkyImage(resolvedId, {
      fov,
      ra: dsoEntry?.ra != null ? dsoEntry.ra * 15 : undefined,
      dec: dsoEntry?.dec,
    }).catch(() => { /* external service unavailable — silent */ });
  }

  // Fill in Wikipedia and Hubble imagery in the background so a later view can
  // upgrade from a bare DSS2 plate — but NOT when the user has pinned a specific
  // master for this object. findCachedMaster ranks hubble > wiki > dss2, so
  // downloading a higher-priority file for a pinned object just leaves it on
  // disk waiting to override the user's choice on some other screen (the exact
  // "my clean image keeps reverting after a restart" complaint). Both functions
  // are already no-ops once their file exists; this only stops the first fetch.
  if (!row.userSet || !isCatalogSourceSentinel(row.galleryImage ?? '')) {
    prefetchObjectWiki(resolvedId).catch(() => {});
    prefetchObjectHubble(resolvedId).catch(() => {});
  }

  res.apiSuccess({ objectId, galleryImage });
});

/** Set the gallery image for an object (from an existing library file path).
 *  Pass imagePath=null to reset to the default sky survey image. */
router.put('/objects/:objectId/gallery-image', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const bodyParsed = GalleryImageBodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    res.apiError(400, 'INVALID_PATH', bodyParsed.error.issues[0]?.message ?? 'imagePath must be a string or null');
    return;
  }
  const { imagePath } = bodyParsed.data;
  if (imagePath !== null && imagePath !== undefined && !imagePath.trim()) {
    res.apiError(400, 'INVALID_PATH', 'imagePath must be a non-empty string or null');
    return;
  }
  try {
    let resolved = imagePath || null;
    // When resetting to default (null), find the stored sky survey image
    if (resolved === null) {
      // getObjectFolderName falls back to the raw objectId on a DB miss, so a
      // crafted objectId with traversal tokens would otherwise escape LIBRARY_DIR.
      const folderName = getObjectFolderName(objectId);
      const LIBRARY_DIR = getLibraryDir();
      const objDir = path.resolve(LIBRARY_DIR, folderName);
      if (!objDir.startsWith(LIBRARY_DIR + path.sep)) {
        res.apiError(400, 'INVALID_OBJECT_ID', 'Object id resolves outside the library');
        return;
      }
      try {
        const skyFile = fs.readdirSync(objDir).find(f => f.startsWith('sky_') && /\.(jpg|jpeg|png)$/i.test(f));
        if (skyFile) resolved = `${folderName}/${skyFile}`;
      } catch { /* dir may not exist */ }
    }
    // A client-supplied imagePath (the common case: picking one of this
    // object's own images) must resolve inside LIBRARY_DIR. Without this,
    // a value like "../../../../etc/passwd" gets stored verbatim and later
    // reaches sharp() on the *public*, auth-bypassed /thumbnail route via
    // resolveObjectImagePath — an unauthenticated arbitrary-file read, and
    // (on a decode failure) delete. The catalog-source:* sentinel is a fixed
    // literal, not a path, so it's exempt.
    if (resolved !== null && !isCatalogSourceSentinel(resolved)) {
      const LIBRARY_DIR = getLibraryDir();
      const abs = path.resolve(LIBRARY_DIR, resolved);
      if (abs !== LIBRARY_DIR && !abs.startsWith(LIBRARY_DIR + path.sep)) {
        res.apiError(400, 'INVALID_PATH', 'imagePath resolves outside the library');
        return;
      }
    }
    setGalleryImageUserChosen(objectId, resolved);
    res.apiSuccess({ objectId, galleryImage: resolved });
  } catch (err) {
    res.apiError(500, 'SET_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

/**
 * Set where an object sits in the user's own processing pipeline
 * (unprocessed → processing → processed). A plain user-set label, not
 * derived from processed-image/project-archive counts — see ProcessingStatus's
 * own doc comment in objects.ts for why. `requireAdmin` matches every other
 * object-metadata write in this file (gallery image, telescope reassignment).
 */
router.put('/objects/:objectId/processing-status', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const bodyParsed = ProcessingStatusBodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    res.apiError(400, 'BAD_REQUEST', bodyParsed.error.issues[0]?.message ?? 'status must be one of unprocessed, processing, processed');
    return;
  }
  try {
    const { status } = bodyParsed.data;
    const updated = setProcessingStatus(objectId, status);
    if (!updated) {
      res.apiError(404, 'NOT_FOUND', `Library object "${objectId}" not found`);
      return;
    }
    res.apiSuccess({ objectId, processingStatus: status });
  } catch (err) {
    res.apiError(500, 'SET_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

/** Upload a custom gallery image for an object. */
router.post('/objects/:objectId/gallery-image/upload', requireAdmin, manualUpload.single('image'), (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const imageFile = req.file;

  if (!imageFile) {
    res.apiError(400, 'NO_IMAGE', 'No image file uploaded');
    return;
  }

  try {
    // getObjectFolderName falls back to the raw objectId on a DB miss, so a
    // crafted objectId with traversal tokens would otherwise let this upload
    // (which mkdirs + writes) land outside LIBRARY_DIR.
    const folderName = getObjectFolderName(objectId);
    const LIBRARY_DIR = getLibraryDir();
    const objDir = path.resolve(LIBRARY_DIR, folderName);
    if (!objDir.startsWith(LIBRARY_DIR + path.sep)) {
      try { fs.unlinkSync(imageFile.path); } catch { /* ignore */ }
      res.apiError(400, 'INVALID_OBJECT_ID', 'Object id resolves outside the library');
      return;
    }
    if (!fs.existsSync(objDir)) {
      fs.mkdirSync(objDir, { recursive: true });
    }

    const ext = imageFile.originalname.split('.').pop()?.toLowerCase() || 'jpg';
    const filename = `gallery_${objectId}.${ext}`;
    const destPath = path.join(objDir, filename);
    try {
      fs.renameSync(imageFile.path, destPath);
    } catch (renameErr) {
      if (isErrnoException(renameErr) && renameErr.code === 'EXDEV') {
        fs.copyFileSync(imageFile.path, destPath);
        fs.unlinkSync(imageFile.path);
      } else {
        throw renameErr;
      }
    }

    const relativePath = `${folderName}/${filename}`;
    setGalleryImageUserChosen(objectId, relativePath);
    res.apiSuccess({ objectId, galleryImage: relativePath });
  } catch (err) {
    try { if (imageFile) fs.unlinkSync(imageFile.path); } catch { /* ignore */ }
    res.apiError(500, 'UPLOAD_FAILED', err instanceof Error ? err.message : 'Upload failed');
  }
});

// ─── Session image (designated raw telescope JPG per session) ─────────────────

router.get('/objects/:objectId/sessions/:date/session-image', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  const sessionImage = getSessionImage(objectId, date);
  res.apiSuccess({ objectId, date, sessionImage });
});

router.put('/objects/:objectId/sessions/:date/session-image', requireAdmin, strictRateLimiter, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  const bodyParsed = SessionImageBodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    res.apiError(400, 'INVALID_PATH', bodyParsed.error.issues[0]?.message ?? 'imagePath must be a non-empty string or null');
    return;
  }
  const { imagePath } = bodyParsed.data;
  if (imagePath !== null && imagePath !== undefined && !imagePath.trim()) {
    res.apiError(400, 'INVALID_PATH', 'imagePath must be a non-empty string or null');
    return;
  }
  // Stored verbatim and later joined with LIBRARY_DIR for an existence check
  // (see getLocalSessions) — reject anything that would resolve outside it.
  if (imagePath) {
    const LIBRARY_DIR = getLibraryDir();
    const abs = path.resolve(LIBRARY_DIR, imagePath);
    if (abs !== LIBRARY_DIR && !abs.startsWith(LIBRARY_DIR + path.sep)) {
      res.apiError(400, 'INVALID_PATH', 'imagePath resolves outside the library');
      return;
    }
  }
  setSessionImage(objectId, date, imagePath ?? null);
  res.apiSuccess({ objectId, date, sessionImage: imagePath ?? null });
});

// ─── Processed images (user-uploaded post-processing results) ─────────────────
// isRenderableProcessedName / isStoredOnlyProcessedName live in
// lib/library/processed.ts (the domain module), imported below via the
// localLibrary barrel — observations.ts needs the same renderability check for
// the session auto-thumbnail pick, so the single source of truth moved there.

const processedUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `processed_${randomUUID()}_${path.basename(file.originalname)}`),
  }),
  // 2 GB: a 32-bit XISF or FITS integration of a multi-night project routinely
  // passes the old 300 MB cap. multer streams to a temp file, so the ceiling is
  // disk rather than memory.
  limits: { fileSize: 2 * 1024 * 1024 * 1024, fieldSize: 1 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, isRenderableProcessedName(file.originalname) || isStoredOnlyProcessedName(file.originalname));
  },
});

// Separate, deliberately narrow uploader for the "save edited image back into
// the library folder" route below. That one writes into the *object* directory,
// where getLocalFiles gates visibility on isRealFile's image extensions — a
// stored-only format like XISF would land on disk and then be invisible. The
// image editor only ever exports a canvas as JPG or PNG, so restricting to
// renderable formats matches what that route can actually represent.
const editedImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `edited_${randomUUID()}_${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: 300 * 1024 * 1024, fieldSize: 1 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, isRenderableProcessedName(file.originalname)),
});

router.get('/objects/:objectId/sessions/:date/processed-images', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  res.apiSuccess(getProcessedImages(objectId, date));
});

router.post('/objects/:objectId/sessions/:date/processed-images', requireAdmin, processedUpload.single('image'), (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  const file = req.file;
  if (!file) {
    res.apiError(400, 'NO_IMAGE', 'No image file provided');
    return;
  }

  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  const runIdRaw = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
  let runId: string | null = null;
  if (runIdRaw) {
    const run = getProcessingRun(runIdRaw);
    if (!run || run.objectId !== objectId) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      res.apiError(422, 'VALIDATION_ERROR', 'runId does not belong to this object');
      return;
    }
    runId = runIdRaw;
  }

  const mimeType = processedImageMimeType(file.originalname);

  try {
    const record = addProcessedImage(objectId, date, file.path, file.originalname, mimeType, title, notes, runId);
    // A renderable upload can now appear in the all-images gallery walk (see
    // gallery.ts), which is cached for 15s — without this the new image would
    // not show up there until the TTL happened to expire.
    invalidateAllImagesCache();
    res.apiSuccess(record);
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.apiError(500, 'UPLOAD_FAILED', err instanceof Error ? err.message : 'Upload failed');
  }
});

// Overwrite an existing processed image's file bytes in place, keeping its row
// and id — the image editor's "Save" (vs the POST above, "Save as new
// version"). Not scoped by session date so it also covers an object-level
// processed image (date NULL).
router.put('/objects/:objectId/processed-images/:id', requireAdmin, processedUpload.single('image'), (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const id = String(req.params.id);
  const file = req.file;
  if (!file) {
    res.apiError(400, 'NO_IMAGE', 'No image file provided');
    return;
  }

  const existing = getProcessedImageRecord(id);
  if (!existing || existing.objectId !== objectId) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.apiError(404, 'NOT_FOUND', 'Processed image not found');
    return;
  }

  try {
    const record = replaceProcessedImageFile(
      id, file.path, file.originalname, processedImageMimeType(file.originalname),
    );
    if (!record) {
      res.apiError(404, 'NOT_FOUND', 'Processed image not found');
      return;
    }
    invalidateAllImagesCache();
    res.apiSuccess(record);
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.apiError(500, 'SAVE_FAILED', err instanceof Error ? err.message : 'Save failed');
  }
});

// ─── Processing runs (which nights a combined processed image draws on) ────

const CreateProcessingRunSchema = z.object({
  dates: z.array(z.string()).min(1, 'dates must be a non-empty array'),
  title: z.string().optional(),
  notes: z.string().optional(),
  software: z.string().optional(),
});

router.get('/objects/:objectId/processing-runs', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  res.apiSuccess(getProcessingRunsForObject(objectId));
});

router.post('/objects/:objectId/processing-runs', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const parsed = CreateProcessingRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { dates, title, notes, software } = parsed.data;
  const run = createProcessingRun(objectId, dates, title?.trim() ?? '', notes?.trim() ?? '', software?.trim() ?? '');
  res.apiSuccess(run);
});

// ─── Processing-project archives (Siril/PixInsight project bundles) ───────────
// The working project behind a finished processed image (process icons,
// masters, logs, ...) — see server/lib/library/projectArchives.ts for the
// domain reasoning. Object-scoped only, no session date.

const projectArchiveUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `projectarchive_${randomUUID()}_${path.basename(file.originalname)}`),
  }),
  // 20 GB: a real PixInsight project (masters + every intermediate XISF
  // process stage) or a full Siril working folder can run well past the 2 GB
  // cap the processed-image uploader uses for one finished picture — this is
  // meant to hold a whole project, not one file. multer streams to a temp
  // file, so — same as every other uploader in this file — the ceiling bounds
  // temp-disk usage, not memory; see checkArchiveUploadSpace below for the
  // free-space guard that actually protects the disk at this size.
  limits: { fileSize: 20 * 1024 * 1024 * 1024, fieldSize: 1 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, isProjectArchiveName(file.originalname)),
});

const processingProjectFileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `processingproj_${randomUUID()}_${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 * 1024, fieldSize: 1 * 1024 * 1024 },
});

/**
 * Free-space preflight for a project-archive upload, keyed off the
 * Content-Length header before multer starts streaming the body anywhere.
 *
 * At up to 20 GB per upload this is not optional the way it might be for a
 * small JSON body: the file lands in full at `os.tmpdir()` first (multer's
 * diskStorage destination), which on a container/Docker host is routinely a
 * small tmpfs sized off available RAM, not the library's own volume — a
 * 20 GB upload can exhaust that long before it ever reaches the library
 * directory it's ultimately destined for. Checked against *both* candidate
 * volumes (mirrors the same per-request re-check /import/upload-temp already
 * does against IMPORT_TMP_BASE) so a caller gets one clear 507 up front
 * instead of an upload that runs for however long, then fails opaquely with
 * ENOSPC partway through.
 */
function checkArchiveUploadSpace(req: Request, res: Response, next: () => void): void {
  const contentLengthHeader = req.headers['content-length'];
  const declaredBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;
  if (Number.isFinite(declaredBytes)) {
    const tmpSpace = checkFreeSpace(os.tmpdir(), declaredBytes, 'to stage this project archive upload');
    if (!tmpSpace.ok) {
      log.warn({ declaredBytes, free: tmpSpace.freeBytes, path: tmpSpace.path }, '[project-archives] refused: temp storage nearly full');
      res.apiError(507, 'INSUFFICIENT_STORAGE', tmpSpace.message ?? 'Not enough temporary storage to stage this upload.');
      return;
    }
    const libSpace = checkFreeSpace(getLibraryDir(), declaredBytes, 'to store this project archive');
    if (!libSpace.ok) {
      log.warn({ declaredBytes, free: libSpace.freeBytes, path: libSpace.path }, '[project-archives] refused: library volume nearly full');
      res.apiError(507, 'INSUFFICIENT_STORAGE', libSpace.message ?? 'Not enough free space in your library to store this archive.');
      return;
    }
  }
  next();
}

router.get('/objects/:objectId/project-archives', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  res.apiSuccess(getProjectArchivesForObject(objectId));
});

router.post(
  '/objects/:objectId/project-archives',
  requireAdmin,
  checkArchiveUploadSpace,
  projectArchiveUpload.single('archive'),
  (req: Request, res: Response) => {
    const objectId = String(req.params.objectId);
    const file = req.file;
    if (!file) {
      res.apiError(400, 'NO_ARCHIVE', 'No archive file provided, or it was not a .zip');
      return;
    }

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    const software = typeof req.body?.software === 'string' ? req.body.software.trim() : '';

    try {
      const record = addProjectArchive(objectId, file.path, file.originalname, projectArchiveMimeType(), title, notes, software);
      res.apiSuccess(record);
    } catch (err) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      res.apiError(500, 'UPLOAD_FAILED', err instanceof Error ? err.message : 'Upload failed');
    }
  },
);

router.delete('/objects/:objectId/project-archives/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const record = getProjectArchivePath(id);
  if (!record) {
    res.apiError(404, 'NOT_FOUND', 'Project archive not found');
    return;
  }
  deleteProjectArchive(id);
  res.apiSuccess({ deleted: true, id });
});

/** Serve a project archive by id. Streamed via res.download rather than read
 *  into a Buffer (see getProjectArchivePath's own doc comment) — these files
 *  can legitimately be several GB. */
router.get('/project-archives/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!(await requireLibraryReachable(res))) return;
  const file = getProjectArchivePath(id);
  if (!file) {
    res.status(404).send('Not found');
    return;
  }
  res.download(file.filePath, file.name, err => {
    if (err && !res.headersSent) res.status(500).send('Failed to send file');
  });
});

// ─── Processing project direct inspection and file synchronization ────────────
router.get('/objects/:objectId/processing-project', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    const summary = getProcessingProjectSummary(objectId);
    res.apiSuccess(summary);
  } catch (err) {
    res.apiError(500, 'PROJECT_SUMMARY_FAILED', err instanceof Error ? err.message : 'Failed to get processing project');
  }
});

router.post(
  '/objects/:objectId/processing-project/file',
  requireAdmin,
  checkArchiveUploadSpace,
  processingProjectFileUpload.single('file'),
  (req: Request, res: Response) => {
    const objectId = String(req.params.objectId);
    const file = req.file;
    if (!file) {
      res.apiError(400, 'NO_FILE', 'No file provided');
      return;
    }

    const subPath = typeof req.body?.subPath === 'string' && req.body.subPath.trim()
      ? req.body.subPath.trim()
      : file.originalname;

    try {
      const result = saveProcessingProjectFile(objectId, subPath, file.path);
      res.apiSuccess(result);
    } catch (err) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      res.apiError(500, 'UPLOAD_FAILED', err instanceof Error ? err.message : 'Failed to save project file');
    }
  },
);

// ─── Save edited telescope image back into the library folder ─────────────────
// Writes the canvas export alongside the original telescope files so it
// appears in the Telescope Images section instead of Processed Images.
router.post('/objects/:objectId/sessions/:date/library-files', requireAdmin, editedImageUpload.single('image'), (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  const file = req.file;
  if (!file) {
    res.apiError(400, 'NO_IMAGE', 'No image file provided');
    return;
  }

  // Both params are spliced into the destination FILENAME below, and
  // `path.join` normalizes, so leaving them unvalidated made this route an
  // arbitrary-write primitive: `date = 'x/../../../tmp/pwned'` landed the staged
  // upload outside the library entirely. The object half of the path was
  // already contained; the filename half was not. A session date is only ever
  // YYYY-MM-DD, and an object id is only ever a single path segment.
  const rejectUpload = (message: string) => {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.apiError(400, 'INVALID_REQUEST', message);
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { rejectUpload('Invalid session date'); return; }
  if (!objectId || objectId === '.' || objectId === '..' || /[\\/]/.test(objectId)) {
    rejectUpload('Invalid object id');
    return;
  }

  try {
    // getObjectFolderName falls back to the raw objectId on a DB miss, so a
    // crafted objectId with traversal tokens would otherwise let this upload
    // (which mkdirs + writes) land outside LIBRARY_DIR. Thrown, not returned
    // directly, so the catch below still cleans up the staged upload.
    const folderName = getObjectFolderName(objectId);
    const LIBRARY_DIR = getLibraryDir();
    const objDir = path.resolve(LIBRARY_DIR, folderName);
    if (!objDir.startsWith(LIBRARY_DIR + path.sep)) {
      throw new Error('Object id resolves outside the library');
    }
    if (!fs.existsSync(objDir)) fs.mkdirSync(objDir, { recursive: true });

    // `overwritePath` (optional): the image editor's "Save", which replaces one
    // exact existing file rather than adding an "…E.jpg" variant ("Save as new
    // version"). Must be a library-relative path resolving to an existing JPEG
    // *inside this object's folder* — anything else is rejected so the route
    // can never be steered to clobber another object's data or escape the tree.
    const overwriteRaw = typeof req.body?.overwritePath === 'string' ? req.body.overwritePath.trim() : '';
    let filename: string;
    let destPath: string;
    if (overwriteRaw) {
      const resolved = path.resolve(LIBRARY_DIR, overwriteRaw);
      if (!resolved.startsWith(objDir + path.sep)) {
        throw new Error('overwritePath is outside this object folder');
      }
      if (!/\.jpe?g$/i.test(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error('overwritePath does not name an existing JPEG in this object');
      }
      destPath = resolved;
      filename = path.basename(resolved);
    } else {
      // Build a filename that parseFilename can associate with the correct
      // session date: <objectId>_YYYYMMDD-HHMMSSE.jpg — the trailing `E` marks
      // this as an edited variant and lands in the simpleMatch suffix slot
      // (`[A-Z]?`). Adding free-form text like ` (edited)` here breaks the
      // regex, so the file would be saved on disk but invisible to
      // getLocalFiles().
      //
      // `date` is the session the user is editing, not this file's own capture
      // time — the embedded time-of-day is clamped into the rollover-safe zone
      // (see clampToNightSafeTime) so an edit made at, say, 2am doesn't get
      // rolled back a day by sessionNightFor the next time it's read.
      const now = new Date();
      const datePart = date.replace(/-/g, ''); // YYYYMMDD from session date
      const rawTimePart = now.toTimeString().slice(0, 8).replace(/:/g, ''); // HHMMSS
      const timePart = clampToNightSafeTime(rawTimePart);
      // The extension also comes from a client-supplied filename, so strip
      // anything that is not a plain alphanumeric extension token.
      const ext = (file.originalname.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      filename = `${objectId}_${datePart}-${timePart}E.${ext}`;
      destPath = path.join(objDir, filename);
    }
    // Belt and braces: whatever the halves produced, the write must land
    // strictly inside this object's folder.
    const destResolved = path.resolve(destPath);
    if (!destResolved.startsWith(objDir + path.sep)) {
      throw new Error('Resolved destination is outside this object folder');
    }
    try {
      fs.renameSync(file.path, destPath);
    } catch (renameErr) {
      if (isErrnoException(renameErr) && renameErr.code === 'EXDEV') {
        fs.copyFileSync(file.path, destPath);
        fs.unlinkSync(file.path);
      } else {
        throw renameErr;
      }
    }

    invalidateAllImagesCache();
    res.apiSuccess({ objectId, date, filename });
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.apiError(500, 'SAVE_FAILED', err instanceof Error ? err.message : 'Save failed');
  }
});

router.delete('/objects/:objectId/sessions/:date/processed-images/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const record = getProcessedImageRecord(id);
  if (!record) {
    res.apiError(404, 'NOT_FOUND', 'Processed image not found');
    return;
  }
  deleteProcessedImage(id);
  invalidateAllImagesCache();
  res.apiSuccess({ deleted: true, id });
});

/** Object-scoped delete, no session date — mirrors the session-scoped route
 *  above for the aggregate "Processed" section (see deleteObjectProcessedImage
 *  in src/lib/api/library.ts), which mixes images from many dates. */
router.delete('/objects/:objectId/processed-images/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const record = getProcessedImageRecord(id);
  if (!record) {
    res.apiError(404, 'NOT_FOUND', 'Processed image not found');
    return;
  }
  deleteProcessedImage(id);
  invalidateAllImagesCache();
  res.apiSuccess({ deleted: true, id });
});

/** Serve a processed image file by id. */
router.get('/processed-images/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!(await requireLibraryReachable(res))) return;
  const file = getProcessedImageFile(id);
  if (!file) {
    res.status(404).send('Not found');
    return;
  }
  res.set('Content-Type', file.mimeType || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(file.data);
});

/** Object-scoped upload, no session date — for a processed image the user
 *  wants filed against the object itself rather than one observing night.
 *  Stored with date NULL (source stays 'user'), so it shows in the object's
 *  aggregate Processed Images section but under no single observation. No
 *  runId: combining nights is a per-session-upload concept. */
router.post('/objects/:objectId/processed-images', requireAdmin, processedUpload.single('image'), (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const file = req.file;
  if (!file) {
    res.apiError(400, 'NO_IMAGE', 'No image file provided');
    return;
  }

  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  const mimeType = processedImageMimeType(file.originalname);

  try {
    const record = addProcessedImage(objectId, null, file.path, file.originalname, mimeType, title, notes, null);
    invalidateAllImagesCache();
    res.apiSuccess(record);
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.apiError(500, 'UPLOAD_FAILED', err instanceof Error ? err.message : 'Upload failed');
  }
});

/** List all processed images across all sessions for this object. */
router.get('/objects/:objectId/processed-images', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    res.apiSuccess(getAllProcessedImagesForObject(objectId));
  } catch (err) {
    res.apiError(500, 'LIST_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

/** List all stacked/image JPGs across all sessions for this object. */
router.get('/objects/:objectId/stacked-images', async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    if (!(await requireLibraryReachable(res))) return;
    const images = getStackedImages(objectId);
    res.apiSuccess(images);
  } catch (err) {
    res.apiError(500, 'LIST_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

// ─── Favorites ────────────────────────────────────────────────────────────────

router.get('/favorites', (req: Request, res: Response) => {
  res.apiSuccess(getFavorites(req.userId ?? ''));
});

router.post('/objects/:objectId/favorite', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    setFavorite(objectId, req.userId ?? '', true);
    res.apiSuccess({ objectId, isFavorite: true });
  } catch (err) {
    res.apiError(500, 'FAVORITE_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

router.delete('/objects/:objectId/favorite', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  try {
    setFavorite(objectId, req.userId ?? '', false);
    res.apiSuccess({ objectId, isFavorite: false });
  } catch (err) {
    res.apiError(500, 'UNFAVORITE_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

// ─── Image favorites ──────────────────────────────────────────────────────────

router.get('/image-favorites', (req: Request, res: Response) => {
  res.apiSuccess(getImageFavorites(req.userId ?? ''));
});

router.post('/images/favorite', (req: Request, res: Response) => {
  const bodyParsed = ImageFavoriteBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'MISSING_PATH', bodyParsed.error.issues[0]?.message ?? 'imagePath is required');
    return;
  }
  const { imagePath } = bodyParsed.data;
  try {
    setImageFavorite(imagePath, req.userId ?? '', true);
    res.apiSuccess({ imagePath, isFavorite: true });
  } catch (err) {
    res.apiError(500, 'FAVORITE_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

router.delete('/images/favorite', (req: Request, res: Response) => {
  const bodyParsed = ImageFavoriteBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'MISSING_PATH', bodyParsed.error.issues[0]?.message ?? 'imagePath is required');
    return;
  }
  const { imagePath } = bodyParsed.data;
  try {
    setImageFavorite(imagePath, req.userId ?? '', false);
    res.apiSuccess({ imagePath, isFavorite: false });
  } catch (err) {
    res.apiError(500, 'UNFAVORITE_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

router.get('/all-images', async (req: Request, res: Response) => {
  try {
    if (!(await requireLibraryReachable(res))) return;
    // Parse pagination params. Invalid values (non-numeric, out of range) fall
    // through to the helper which clamps rather than 4xx — see contract above.
    const parsed = AllImagesQuerySchema.safeParse(req.query);
    const options = parsed.success ? parsed.data : {};
    // Backwards-compat: if neither was provided, the helper returns the full
    // list with nextOffset=null. iOS passes both; the SPA may not.
    res.apiSuccess(getAllLibraryImages(req.userId ?? '', options));
  } catch (err) {
    res.apiError(500, 'LIST_FAILED', err instanceof Error ? err.message : 'Failed');
  }
});

export { router as libraryRouter };
