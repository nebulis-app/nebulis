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
import { randomUUID, createHash } from 'crypto';
import archiver from 'archiver';
import multer from 'multer';
import { log } from '../lib/logger.js';
import { debugLog, isDebugLoggingEnabled } from '../lib/debugLogger.js';
import { isErrnoException } from '../lib/errors.js';
import { THUMBNAILS_DIR } from '../lib/paths.js';
import { getLibraryDir, isLibraryAvailable, withTimeout, LIBRARY_IO_TIMEOUT_MS } from '../lib/libraryPath.js';
import { isLibraryMigrating } from '../lib/libraryMaintenance.js';
import { getSite } from '../lib/observingSites.js';
import sharp from '../lib/sharp-optional.js';
import { generateFitsThumbnail, fitsThumbnailPath, type FitsThumbnailTier } from '../lib/fitsThumbnail.js';
import { generateTiffThumbnail, tiffThumbnailPath, type TiffThumbnailTier } from '../lib/tiffThumbnail.js';
import { normalizeCatalogId, parseFilename, isRealFile, sessionNightFor, clampToNightSafeTime } from '../lib/telescopeFiles.js';
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
  getLocalThumbnail,
  getLocalFile,
  getLocalObservations,
  getLocalObservationDetail,
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
  deleteSessionSubFrames,
  purgeSubFrameImages,
  getSessionTelescopeId,
  getObjectPrimaryTelescopeId,
  setFavorite,
  getImageFavorites,
  setImageFavorite,
  getAllLibraryImages,
  invalidateAllImagesCache,
  createManualObservation,
  getGalleryImage,
  getGalleryImageRow,
  setGalleryImage,
  setGalleryImageUserChosen,
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
  deleteProcessedImage,
  getProcessedImageFile,
  isRenderableProcessedName,
  isStoredOnlyProcessedName,
  createProcessingRun,
  getProcessingRun,
  getProcessingRunsForObject,
  getObjectFolderName,
  scanImportFolder,
  LIBRARY_OBJECT_FILTERS,
  resolveObjectImagePath,
  resolveCatalogSourceSentinel,
} from '../lib/localLibrary.js';
import { getArchiveDir, listArchivedFolders } from '../lib/library/archiveFolders.js';
import { stageUploadDestPath } from '../lib/library/uploadPath.js';
import {
  IMPORT_TMP_BASE,
  isValidTmpId,
  getImportTmpUsage,
  purgeImportTmp,
  purgeImportTmpSession,
  checkFreeSpace,
} from '../lib/library/importStaging.js';
import { createNote, getNote } from '../lib/notes.js';
import { hasCachedCatalogImage, fovForEntry, findCachedMaster, prefetchObjectWiki, prefetchObjectHubble } from '../lib/catalogPrefetch.js';
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
// caller error and shouldn't squat 200 MB of disk waiting for cleanup.
const ALLOWED_UPLOAD_EXTS = new Set([
  '.fit', '.fits', '.fts',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff',
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
});

const GalleryImageBodySchema = z.object({
  imagePath: z.string().nullable().optional(),
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
    url: req.url,
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

router.get('/object-filters', (_req: Request, res: Response) => {
  res.apiSuccess(LIBRARY_OBJECT_FILTERS);
});

/**
 * Folders archive mode kept but did not model: calibration frames, restacks,
 * daytime captures. A plain directory listing, deliberately: these are bytes in
 * the library, not objects, and giving them a home in the UI is what makes
 * archive mode read as an import rather than a silent copy. The absolute path
 * is returned so the user can point Siril or PixInsight straight at it.
 */
router.get('/archive', (_req: Request, res: Response) => {
  try {
    res.apiSuccess({ path: getArchiveDir(), folders: listArchivedFolders() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list the archive';
    res.apiError(500, 'ARCHIVE_LIST_FAILED', message);
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

/**
 * Fixed-length disk-cache key. A raw base64url of `path:WxH:mtime` grows with
 * the path, and a Dwarf's device-folder-plus-filename combination (session
 * folder name alone can run ~90 chars, doubled once for the raw file and again
 * for its "stacked-16_..." master) pushes the encoded key past the OS's
 * 255-byte filename-component limit. sharp's toFile() then fails to open the
 * temp file with ENAMETOOLONG, which the client sees as a 500 and the `<img>`
 * renders as broken. A hash is constant-length regardless of input length.
 */
function thumbnailCacheKey(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

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
    const mtimeMs = (await withTimeout(fs.promises.stat(srcPath), LIBRARY_IO_TIMEOUT_MS)).mtimeMs;
    const cacheKey = thumbnailCacheKey(`${srcPath}:${w}x${h}:${mtimeMs}`);
    const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);

    if (!fs.existsSync(cachePath)) {
      try {
        fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
        await sharp(srcPath)
          .resize(w, h, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, progressive: true })
          .toFile(cachePath);
      } catch (sharpErr) {
        const msg = sharpErr instanceof Error ? sharpErr.message : '';
        if (msg.includes('corrupt') || msg.includes('not a known file format')) {
          console.warn(`[thumbnail] corrupt source file, deleting: ${srcPath}`);
          try { fs.unlinkSync(srcPath); } catch { /* ignore */ }
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

// ─── Delete object / session (tombstone) ─────────────────────────────────────

// A running import can be actively writing into the same directory tree
// these routes delete/move from (a new file mid-copy, a session folder being
// created). Refused outright rather than age-gated or best-effort, same
// posture as the import-tmp cleanup routes above.
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

// ─── Maintenance: purge frame-named JPG previews ─────────────────────────────
//
// One-off cleanup for libraries imported before sub-frame import was made
// FITS-only: older imports copied `Light_*.jpg` previews out of the telescope's
// _sub folder into the library. Deletes only files that parse as a sub-frame
// AND carry an image extension — never raw .fit subs or stacked JPGs. Pass
// `{ dryRun: true }` to get a count without deleting (the Danger-zone button
// scans first, then purges on confirm).
router.post('/maintenance/purge-subframe-previews', requireAdmin, (req: Request, res: Response) => {
  const dryRun = req.body?.dryRun === true;
  try {
    res.apiSuccess(purgeSubFrameImages({ dryRun }));
  } catch (err) {
    res.apiError(500, 'PURGE_FAILED', err instanceof Error ? err.message : 'Cleanup failed');
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

  const ext = result.name.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    tif: 'image/tiff', tiff: 'image/tiff',
    fit: 'application/fits', fits: 'application/fits',
    avi: 'video/avi', mp4: 'video/mp4', mov: 'video/quicktime',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const isInline = mimeType.startsWith('image/');

  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'public, max-age=3600');
  if (!isInline) {
    res.set('Content-Disposition', contentDispositionHeader('attachment', result.name));
  }
  res.send(result.data);
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

  const w = Math.min(Math.max(parseInt(queryString(req.query.w) || '400', 10) || 400, 32), 1200);
  const h = Math.min(Math.max(parseInt(queryString(req.query.h) || '400', 10) || 400, 32), 1200);

  // Only serve image files — reject FITS/video
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (!['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp'].includes(ext)) {
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
  try {
    await withTimeout(fs.promises.access(absPath), LIBRARY_IO_TIMEOUT_MS);
  } catch {
    res.status(404).send('Not found');
    return;
  }

  // Cache key includes mtime, matching the object-thumbnail route above: without
  // it an in-place overwrite (a re-import replacing the same filename) serves the
  // old thumbnail forever.
  let mtimeMs = 0;
  try {
    mtimeMs = (await withTimeout(fs.promises.stat(absPath), LIBRARY_IO_TIMEOUT_MS)).mtimeMs;
  } catch { /* fall through with 0; a miss is better than a stale hit */ }
  const cacheKey = thumbnailCacheKey(`${filePath}:${w}x${h}:${mtimeMs}`);
  const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);

  try {
    if (!fs.existsSync(cachePath)) {
      // Single-flight per cache key. This route converts formats a browser
      // cannot display, which now includes a Dwarf's ~100 MB 32-bit float
      // `img_stacked_all.tif`. An observation page asks for the same file twice
      // at once (hero plus grid card), and without this each request starts its
      // own 100 MB decode.
      await renderThumbnailOnce(cacheKey, cachePath, absPath, w, h);
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
    await withTimeout(fs.promises.access(absPath), LIBRARY_IO_TIMEOUT_MS);
  } catch {
    res.status(404).send('Not found');
    return;
  }

  const thumbPath = fitsThumbnailPath(absPath, tier);
  try {
    // No-ops if it already exists; otherwise parses + renders + writes.
    await generateFitsThumbnail(absPath, tier);
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
    await withTimeout(fs.promises.access(absPath), LIBRARY_IO_TIMEOUT_MS);
  } catch {
    res.status(404).send('Not found');
    return;
  }

  const thumbPath = tiffThumbnailPath(absPath, tier);
  try {
    await generateTiffThumbnail(absPath, tier);
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

router.get('/download/objects/:objectId', strictRateLimiter, async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const fileType = queryString(req.query.fileType); // 'image', 'fits', 'all'
  const sessionDate = queryString(req.query.date);
  // `?includeVariants=true` pulls in files from every variant of this object
  // (e.g. M8 + M8_Mosaic), matching what the web UI's "Observations" grid and
  // session count show. Without it, "Download All" silently omits any date
  // that only exists under a variant id. Same family-discovery logic as the
  // `/sessions?includeVariants=true` route above.
  const includeVariants = req.query.includeVariants === 'true';

  try {
    if (!(await requireLibraryReachable(res))) return;
    let ids = [objectId];
    if (includeVariants) {
      const all = getLocalObjects(req.userId ?? '');
      const grouped = groupByVariants(all);
      const family = grouped.find(g => g.id === objectId || g.variants.some(v => v.objectId === objectId));
      ids = family ? [family.id, ...family.variants.map(v => v.objectId)] : [objectId];
    }
    let files = ids.flatMap(id => getLocalFiles(id, sessionDate));

    // Exclude thumbnails
    files = files.filter(f => !f.isThumbnail);

    // Filter by type
    if (fileType && fileType !== 'all') {
      files = files.filter(f => f.type === fileType);
    }

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
  status: 'running' | 'done' | 'error';
  token?: string;
  filename?: string;
  size?: number;
  error?: string;
  startedAt: number;
  expiresAt: number;
}
const archiveJobs = new Map<string, ArchiveJob>();
const MAX_ARCHIVE_JOBS = 200;

// Periodic cleanup — remove expired tokens and jobs
setInterval(() => {
  const now = Date.now();
  for (const [token, meta] of tempDownloads) {
    if (now > meta.expiresAt) {
      fs.unlink(meta.filePath, () => {});
      tempDownloads.delete(token);
    }
  }
  for (const [id, job] of archiveJobs) {
    if (now > job.expiresAt) archiveJobs.delete(id);
  }
}, 10 * 60 * 1000);

// Filter query — returns distinct filter names found across sub-frames for the given dates
router.post('/download/objects/:objectId/subframe-filters', strictRateLimiter, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const bodyParsed = z.object({ dates: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!bodyParsed.success) {
    res.apiError(400, 'INVALID_DATES', 'dates must be a non-empty array');
    return;
  }
  const dateSet = new Set(bodyParsed.data.dates.map(String));
  const folderName = getObjectFolderName(objectId);
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.resolve(LIBRARY_DIR, folderName);
  if (!objDir.startsWith(LIBRARY_DIR + path.sep)) {
    res.apiError(400, 'INVALID_OBJECT_ID', 'Object id resolves outside the library');
    return;
  }
  if (!fs.existsSync(objDir)) {
    res.apiSuccess({ filters: [] });
    return;
  }
  const filters = new Set<string>();
  for (const f of fs.readdirSync(objDir)) {
    if (!isRealFile(f)) continue;
    const parsed = parseFilename(f);
    const night = sessionNightFor(parsed);
    if (parsed.type === 'sub' && night !== null && dateSet.has(night) && parsed.filter) {
      filters.add(parsed.filter);
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
  const { dates, filters } = bodyParsed.data;

  const dateSet = new Set(dates.map(String));
  const filterSet = filters && filters.length > 0 ? new Set(filters) : null;
  // Resolve the object folder strictly inside LIBRARY_DIR — `getObjectFolderName`
  // falls back to the raw objectId when the lookup misses, which means a
  // crafted objectId with traversal tokens would otherwise escape.
  const folderName = getObjectFolderName(objectId);
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.resolve(LIBRARY_DIR, folderName);
  if (!objDir.startsWith(LIBRARY_DIR + path.sep)) {
    res.apiError(400, 'INVALID_OBJECT_ID', 'Object id resolves outside the library');
    return;
  }

  if (!fs.existsSync(objDir)) {
    res.apiError(404, 'NOT_FOUND', 'Object not found in local library');
    return;
  }

  const subFrames = fs.readdirSync(objDir).filter(f => {
    if (!isRealFile(f)) return false;
    const parsed = parseFilename(f);
    const night = sessionNightFor(parsed);
    if (parsed.type !== 'sub' || night === null || !dateSet.has(night)) return false;
    if (filterSet !== null && (!parsed.filter || !filterSet.has(parsed.filter))) return false;
    return true;
  });

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

  archive.on('entry', () => { job.filesDone++; });

  output.on('close', () => {
    const token = randomUUID();
    if (tempDownloads.size >= MAX_TEMP_DOWNLOADS) {
      tempDownloads.delete(tempDownloads.keys().next().value!);
    }
    tempDownloads.set(token, { filePath: tmpPath, filename, expiresAt: Date.now() + 10 * 60 * 1000 });
    job.status = 'done';
    job.token = token;
    job.size = archive.pointer();
  });

  archive.on('error', (err: Error) => {
    fs.unlink(tmpPath, () => {});
    job.status = 'error';
    job.error = err.message;
  });

  archive.pipe(output);

  for (const fname of subFrames) {
    archive.file(path.join(objDir, fname), { name: `${objectId}/${fname}` });
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
  if (job.status === 'error') {
    payload.error = job.error;
    archiveJobs.delete(String(req.params.jobId));
  }
  res.apiSuccess(payload);
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

  // Always fill in Wikipedia and Hubble in the background when not yet present.
  // Both functions guard against redundant network calls (file-existence check +
  // catalogCache entry), so they're cheap no-ops once the object is fully cached.
  prefetchObjectWiki(resolvedId).catch(() => {});
  prefetchObjectHubble(resolvedId).catch(() => {});

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

  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    tif: 'image/tiff', tiff: 'image/tiff',
    // Stored-but-not-rendered formats. Real IANA types where one exists, so a
    // browser download names and handles the file correctly.
    fit: 'application/fits', fits: 'application/fits', fts: 'application/fits',
    xisf: 'application/x-xisf',
    psd: 'image/vnd.adobe.photoshop', xcf: 'image/x-xcf',
    dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3',
    nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw',
  };
  const ext = file.originalname.split('.').pop()?.toLowerCase() || '';
  // Falling back to image/jpeg would tell the client an XISF is a renderable
  // JPEG, so the grid would show a broken thumbnail instead of a file card.
  const mimeType = mimeMap[ext] || 'application/octet-stream';

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

    // Build a filename that parseFilename can associate with the correct session
    // date: <objectId>_YYYYMMDD-HHMMSSE.jpg  — the trailing `E` marks this as an
    // edited variant and lands in the simpleMatch suffix slot (`[A-Z]?`). Adding
    // free-form text like ` (edited)` here breaks the regex, so the file would
    // be saved on disk but invisible to getLocalFiles().
    //
    // `date` is the session the user is editing, not this file's own capture
    // time — the embedded time-of-day is clamped into the rollover-safe zone
    // (see clampToNightSafeTime) so an edit made at, say, 2am doesn't get
    // rolled back a day by sessionNightFor the next time it's read.
    const now = new Date();
    const datePart = date.replace(/-/g, ''); // YYYYMMDD from session date
    const rawTimePart = now.toTimeString().slice(0, 8).replace(/:/g, ''); // HHMMSS
    const timePart = clampToNightSafeTime(rawTimePart);
    const ext = file.originalname.split('.').pop()?.toLowerCase() || 'jpg';
    const filename = `${objectId}_${datePart}-${timePart}E.${ext}`;
    const destPath = path.join(objDir, filename);
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
