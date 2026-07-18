/**
 * Local library API routes.
 *
 * Serves objects/sessions/files from the locally-imported copy of the
 * SeeStar image library, and provides endpoints to trigger imports.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import archiver from 'archiver';
import multer from 'multer';
import { log } from '../lib/logger.js';
import { debugLog, isDebugLoggingEnabled } from '../lib/debugLogger.js';
import { isErrnoException } from '../lib/errors.js';
import { THUMBNAILS_DIR, DATA_DIR } from '../lib/paths.js';
import { getLibraryDir, isLibraryAvailable, withTimeout, LIBRARY_IO_TIMEOUT_MS } from '../lib/libraryPath.js';
import { isLibraryMigrating } from '../lib/libraryMaintenance.js';
import sharp from '../lib/sharp-optional.js';
import { normalizeCatalogId, parseFilename, isRealFile, sessionNightFor, clampToNightSafeTime } from '../lib/telescopeFiles.js';
import {
  runImport,
  runAllTelescopesImport,
  reassignSessionTelescope,
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
  getObjectFolderName,
  scanImportFolder,
  LIBRARY_OBJECT_FILTERS,
  resolveObjectImagePath,
  resolveCatalogSourceSentinel,
} from '../lib/localLibrary.js';
import { stageUploadDestPath } from '../lib/library/uploadPath.js';
import { createNote, getNote } from '../lib/notes.js';
import { hasCachedCatalogImage, fovForEntry, findCachedMaster, prefetchObjectWiki, prefetchObjectHubble } from '../lib/catalogPrefetch.js';
import { prefetchSkyImage } from '../lib/skyImage.js';
import { getById as getDsoById } from '../lib/dsoCatalog.js';
import { caldwellToNgcId } from '../lib/caldwellCatalog.js';
import { resolveCanonicalId } from '../lib/catalogAliases.js';
import { getSettingsData } from '../lib/telescopes.js';
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

// Folder-import wizard: scan a folder (dry run) then commit an edited plan.
const FolderScanBodySchema = z.object({
  rootPath: z.string().min(1, 'rootPath is required'),
  importSubFrames: z.boolean().optional(),
  importFits: z.boolean().optional(),
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

  // Run in background — don't await. Lock already claimed above.
  if (importAll && !objectId) {
    runAllTelescopesImport().catch(err => {
      console.error('Import error:', err.message);
    });
  } else {
    runImport(objectId, undefined, telescopeId ? { telescopeId } : undefined).catch(err => {
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

/** Get paginated sync history (runs with new files only). */
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
  runImport(objectId, date, telescopeId ? { telescopeId } : undefined).catch(err => {
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
  const { rootPath, importSubFrames, importFits } = parsed.data;
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    res.apiError(400, 'INVALID_PATH', `Folder not found or not a directory: ${rootPath}`);
    return;
  }
  try {
    const overrides: Record<string, unknown> = {};
    if (importSubFrames !== undefined) overrides.importSubFrames = importSubFrames;
    if (importFits !== undefined) overrides.importFits = importFits;
    const scanSettings = Object.keys(overrides).length > 0
      ? { ...getSettingsData(), ...overrides }
      : getSettingsData();
    debugLog('import:folder-scan',
      `Manual folder scan: ${rootPath}  |  effective settings → ` +
      `JPG:${scanSettings.importJpg !== false} FITS:${scanSettings.importFits !== false} ` +
      `Thumbs:${scanSettings.importThumbnails !== false} Subs:${scanSettings.importSubFrames === true} ` +
      `Video:${scanSettings.importVideos === true}`);
    const scanResult = scanImportFolder(rootPath, scanSettings);
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

const IMPORT_TMP_BASE = path.join(DATA_DIR, 'import-tmp');

/**
 * Folder-import wizard, pre-phase: accept an uploaded folder, reconstruct its
 * directory tree under a UUID temp dir, and return the path so the caller can
 * feed it straight into /import/scan → /import/commit.
 *
 * The client strips the top-level folder name from relative paths before
 * sending, so the temp dir IS the scan root (no extra nesting).
 */
router.post('/import/upload-temp', requireAdmin, (req: Request, _res: Response, next) => {
  const contentLengthHeader = req.headers['content-length'];
  const contentMb = contentLengthHeader
    ? (parseInt(contentLengthHeader, 10) / (1024 * 1024)).toFixed(1)
    : 'unknown';
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
    const cacheKey = Buffer.from(`${srcPath}:${w}x${h}:${mtimeMs}`).toString('base64url');
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

router.delete('/objects/:objectId', requireAdmin, (req: Request, res: Response) => {
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

router.delete('/objects/:objectId/sessions/:date/subframes', requireAdmin, (req: Request, res: Response) => {
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

router.get('/file/thumbnail', async (req: Request, res: Response) => {
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

  // Cache key: sha of (relative path + dimensions)
  const cacheKey = Buffer.from(`${filePath}:${w}x${h}`).toString('base64url');
  const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);

  try {
    if (!fs.existsSync(cachePath)) {
      fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
      await sharp(absPath)
        .resize(w, h, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toFile(cachePath);
    }

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(cachePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Thumbnail generation failed';
    res.status(500).send(msg);
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

router.get('/download/objects/:objectId', async (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const fileType = queryString(req.query.fileType); // 'image', 'fits', 'all'
  const sessionDate = queryString(req.query.date);

  try {
    if (!(await requireLibraryReachable(res))) return;
    let files = getLocalFiles(objectId, sessionDate);

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
router.post('/download/objects/:objectId/subframe-filters', (req: Request, res: Response) => {
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
router.post('/download/objects/:objectId/subframes', (req: Request, res: Response) => {
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
      const folderName = getObjectFolderName(objectId);
      const objDir = path.join(getLibraryDir(), folderName);
      try {
        const skyFile = fs.readdirSync(objDir).find(f => f.startsWith('sky_') && /\.(jpg|jpeg|png)$/i.test(f));
        if (skyFile) resolved = `${folderName}/${skyFile}`;
      } catch { /* dir may not exist */ }
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
    const folderName = getObjectFolderName(objectId);
    const objDir = path.join(getLibraryDir(), folderName);
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

router.put('/objects/:objectId/sessions/:date/session-image', requireAdmin, (req: Request, res: Response) => {
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
  setSessionImage(objectId, date, imagePath ?? null);
  res.apiSuccess({ objectId, date, sessionImage: imagePath ?? null });
});

// ─── Processed images (user-uploaded post-processing results) ─────────────────

const processedUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `processed_${randomUUID()}_${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: 300 * 1024 * 1024, fieldSize: 1 * 1024 * 1024 }, // 300 MB file, 1 MB fields
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|tiff?|tif)$/i;
    cb(null, allowed.test(file.originalname));
  },
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

  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    tif: 'image/tiff', tiff: 'image/tiff',
  };
  const ext = file.originalname.split('.').pop()?.toLowerCase() || 'jpg';
  const mimeType = mimeMap[ext] || 'image/jpeg';

  try {
    const record = addProcessedImage(objectId, date, file.path, file.originalname, mimeType, title, notes);
    res.apiSuccess(record);
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.apiError(500, 'UPLOAD_FAILED', err instanceof Error ? err.message : 'Upload failed');
  }
});

// ─── Save edited telescope image back into the library folder ─────────────────
// Writes the canvas export alongside the original telescope files so it
// appears in the Telescope Images section instead of Processed Images.
router.post('/objects/:objectId/sessions/:date/library-files', requireAdmin, processedUpload.single('image'), (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const date = String(req.params.date);
  const file = req.file;
  if (!file) {
    res.apiError(400, 'NO_IMAGE', 'No image file provided');
    return;
  }

  try {
    const folderName = getObjectFolderName(objectId);
    const objDir = path.join(getLibraryDir(), folderName);
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
