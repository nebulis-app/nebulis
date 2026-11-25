/**
 * Routes for the Google Drive backup, under `/api/v1/storage/gdrive-backup`.
 *
 * The Drive backup runs alongside the disk archive and has nothing in common with
 * its routes but the router they hang off (see lib/archive/gdrive/gdriveBackupConfig.ts
 * for why it is a separate feature). The flow the settings page follows:
 *
 *  1. `connect` stores the OAuth client and starts the device-code sign-in; the page
 *     polls `sign-in` while the user enters the code at google.com/device.
 *  2. `folder` prepares the backup folder (a `Nebulis` folder at the top of My Drive,
 *     made when missing) and the page saves its id with `PUT`.
 *  3. `enable` adopts the folder (writes our `.nebulisarchive` marker, with the same
 *     confirmation rule as a disk for another install's folder) and switches it on.
 *  4. `run` starts a backup now; the schedule does the rest.
 */

import type { Request, Response, Router } from 'express';
import { log } from '../lib/logger.js';
import { requireAdmin } from '../middleware/auth.js';
import { strictRateLimiter } from '../middleware/rateLimit.js';
import { logEvent } from '../lib/systemLog.js';
import { isRecord } from '../lib/typeGuards.js';
import { isLibraryAvailable } from '../lib/libraryPath.js';
import { ArchiveConfigError } from '../lib/archive/archiveConfig.js';
import { archiveScheduleTimeZoneInfo, nextArchiveRun } from '../lib/archive/archiveScheduler.js';
import { getGdriveBackupConfig, setGdriveBackupConfig, type GdriveBackupConfig } from '../lib/archive/gdrive/gdriveBackupConfig.js';
import {
  adoptGdriveArchive,
  ensureGdriveArchiveReady,
  gdriveDestinationState,
  GdriveFolderError,
  prepareGdriveArchiveFolder,
  type GdriveDestinationView,
} from '../lib/archive/gdrive/driveArchive.js';
import {
  cancelGdriveSignIn,
  disconnectGdrive,
  GdriveAuthError,
  GdriveSignInError,
  getGdriveSignInStatus,
  startGdriveSignIn,
} from '../lib/archive/gdrive/driveAuth.js';
import {
  cancelGdriveBackupRun,
  gdriveBackupBlockedByLibraryWork,
  getGdriveBackupProgress,
  getLastGdriveBackupRun,
  gdriveScheduleOf,
  isGdriveBackupRunning,
  runGdriveBackup,
} from '../lib/archive/gdrive/gdriveBackupRunner.js';

/** Fields a settings save may not carry: the switch and the adoption have their own
 *  routes, which check Drive first, and the run record is written by runs. */
const NOT_SETTABLE = ['enabled', 'archiveId', 'lastRunAt', 'lastResult', 'lastAttemptAt'] as const;

// A passive read of where the folder stands is two Drive calls (the folder, then its
// marker), about a second. The page polls this route every 1.5 s during a run, and a
// background tab's throttled timer still polls about every 20 s, so the view is cached
// for longer than either. During a run the cached view is kept whatever its age: the
// run checked the folder before copying, and asking Drive again only slows each poll.
// Anything that changes the backup clears the cache.
let viewCache: { key: string; at: number; value: GdriveDestinationView } | null = null;
export const VIEW_TTL_MS = 60_000;

function viewKey(config: GdriveBackupConfig): string {
  return `${config.clientId}:${config.connected}:${config.account}:${config.folderId}:${config.archiveId}`;
}

function invalidateView(): void {
  viewCache = null;
}

async function destinationView(config: GdriveBackupConfig, fresh = false): Promise<GdriveDestinationView> {
  const key = viewKey(config);
  const cached = viewCache !== null && viewCache.key === key ? viewCache : null;
  if (!fresh && cached !== null && (isGdriveBackupRunning() || Date.now() - cached.at < VIEW_TTL_MS)) return cached.value;
  const value = await gdriveDestinationState(config);
  viewCache = { key, at: Date.now(), value };
  return value;
}

/** The schedule as the page shows it: which time zone it runs in, and when it will
 *  next start a run (null when off, or when a custom expression names no minute). */
function scheduleView(config: GdriveBackupConfig): { timeZone: string; timeZoneSource: 'site' | 'server'; nextRunAt: string | null } {
  const { timeZone, source } = archiveScheduleTimeZoneInfo();
  const on = config.enabled && config.scheduleEnabled && config.archiveId !== '';
  const next = on ? nextArchiveRun(new Date(), gdriveScheduleOf(config), config.lastRunAt, timeZone) : null;
  return { timeZone, timeZoneSource: source, nextRunAt: next ? next.toISOString() : null };
}

function actor(req: Request): { userId?: string; username?: string; ip?: string } {
  return { userId: req.userId, username: req.username, ip: req.ip ?? req.socket.remoteAddress };
}

/** Answer a folder failure: a known refusal with its own status, a lost sign-in as 409,
 *  and anything else (Drive unreachable) as 502. */
function sendFolderError(res: Response, err: unknown): void {
  if (err instanceof GdriveFolderError) {
    res.apiError(err.status, err.code, err.message);
    return;
  }
  if (err instanceof GdriveAuthError) {
    res.apiError(409, 'GDRIVE_NOT_CONNECTED', err.message);
    return;
  }
  const detail = err instanceof Error ? err.message : String(err);
  log.warn({ err: detail }, 'gdrive_backup_folder_failed');
  res.apiError(502, 'GDRIVE_UNREACHABLE', `Google Drive could not be reached: ${detail}`);
}

export function registerGdriveBackupRoutes(router: Router): void {
  // GET — the settings, where the folder stands, and how a run is going. Read-only,
  // like the archive's status, so it needs no admin. Secrets are never in `config`.
  router.get('/gdrive-backup', async (_req: Request, res: Response) => {
    const config = getGdriveBackupConfig();
    res.apiSuccess({
      config,
      destination: await destinationView(config),
      progress: getGdriveBackupProgress(),
      running: isGdriveBackupRunning(),
      lastRun: getLastGdriveBackupRun(),
      schedule: scheduleView(config),
    });
  });

  // PUT — save settings: what to copy, the schedule, the OAuth client and the folder.
  router.put('/gdrive-backup', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
    if (!isRecord(req.body)) {
      res.apiError(400, 'GDRIVE_INVALID_CONFIG', 'Expected an object of Google Drive backup settings.');
      return;
    }
    const refused = NOT_SETTABLE.find(key => key in req.body);
    if (refused !== undefined) {
      res.apiError(400, 'GDRIVE_INVALID_CONFIG', `${refused} cannot be set here.`);
      return;
    }
    try {
      setGdriveBackupConfig(req.body);
    } catch (err) {
      if (err instanceof ArchiveConfigError) {
        res.apiError(400, 'GDRIVE_INVALID_CONFIG', err.message);
        return;
      }
      throw err;
    }
    invalidateView();
    const config = getGdriveBackupConfig();
    res.apiSuccess({ config, destination: await destinationView(config, true) });
  });

  // POST enable — adopt the folder (write our marker) and switch the backup on.
  router.post('/gdrive-backup/enable', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
    const config = getGdriveBackupConfig();
    if (config.folderId === '') {
      res.apiError(409, 'GDRIVE_NO_FOLDER', 'Sign in to Google Drive first, so Nebulis can prepare the backup folder.');
      return;
    }
    const adopted = await adoptGdriveArchive(config, isRecord(req.body) ? req.body.confirmArchiveId : undefined);
    if (!adopted.ok) {
      res.apiError(adopted.status, adopted.code, adopted.message);
      return;
    }
    setGdriveBackupConfig({ archiveId: adopted.archiveId, enabled: true });
    invalidateView();
    logEvent({
      category: 'storage',
      event: 'gdrive_backup_enabled',
      level: adopted.replacedArchiveId ? 'warning' : 'info',
      message: adopted.replacedArchiveId
        ? `Turned on the Google Drive backup to ${adopted.path}, replacing marker ${adopted.replacedArchiveId}.`
        : `Turned on the Google Drive backup to ${adopted.path}.`,
      ...actor(req),
      metadata: { path: adopted.path, replacedArchiveId: adopted.replacedArchiveId, previousRecordSetAside: adopted.previousRecordSetAside },
    });
    const updated = getGdriveBackupConfig();
    res.apiSuccess({ config: updated, destination: await destinationView(updated, true) });
  });

  // POST disable — switch it off. The folder, its files and the sign-in are kept.
  router.post('/gdrive-backup/disable', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
    setGdriveBackupConfig({ enabled: false });
    logEvent({ category: 'storage', event: 'gdrive_backup_disabled', message: 'Turned off the Google Drive backup.', ...actor(req) });
    const config = getGdriveBackupConfig();
    res.apiSuccess({ config, destination: await destinationView(config) });
  });

  // ─── Sign-in (device code, see lib/archive/gdrive/driveAuth.ts) ──────────

  router.get('/gdrive-backup/sign-in', requireAdmin, (_req: Request, res: Response) => {
    res.apiSuccess(getGdriveSignInStatus());
  });

  // POST connect — save the OAuth client and ask Google for a code.
  router.post('/gdrive-backup/connect', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const patch: Record<string, unknown> = {};
    for (const key of ['clientId', 'clientSecret'] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    try {
      if (Object.keys(patch).length > 0) setGdriveBackupConfig(patch);
    } catch (err) {
      if (err instanceof ArchiveConfigError) {
        res.apiError(400, 'GDRIVE_INVALID_CONFIG', err.message);
        return;
      }
      throw err;
    }
    invalidateView();
    try {
      res.apiSuccess(await startGdriveSignIn());
    } catch (err) {
      if (err instanceof GdriveSignInError) {
        res.apiError(err.code === 'no-client' ? 400 : 502, 'GDRIVE_SIGN_IN_FAILED', err.message);
        return;
      }
      res.apiError(502, 'GDRIVE_SIGN_IN_FAILED', err instanceof Error ? err.message : 'Could not reach Google.');
    }
  });

  router.post('/gdrive-backup/sign-in/cancel', requireAdmin, (_req: Request, res: Response) => {
    cancelGdriveSignIn();
    res.apiSuccess(getGdriveSignInStatus());
  });

  // POST disconnect — sign out and revoke the token. The files in Drive stay.
  router.post('/gdrive-backup/disconnect', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
    await disconnectGdrive();
    invalidateView();
    logEvent({ category: 'storage', event: 'gdrive_backup_disconnected', message: 'Signed Nebulis out of Google Drive.', ...actor(req) });
    res.apiSuccess(getGdriveSignInStatus());
  });

  // POST folder — the backup folder, right after sign-in: the one already saved (kept
  // by id, wherever it was moved), else a Nebulis folder at the top of My Drive, made
  // if needed. Nothing is saved: the page saves the id with PUT.
  router.post('/gdrive-backup/folder', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
    try {
      const { folder, created } = await prepareGdriveArchiveFolder();
      if (created) {
        logEvent({
          category: 'storage',
          event: 'gdrive_backup_folder_created',
          message: `Created the Google Drive folder “${folder.name}”.`,
          ...actor(req),
          metadata: { folderId: folder.id },
        });
      }
      res.apiSuccess({ folder, created });
    } catch (err) {
      sendFolderError(res, err);
    }
  });

  // ─── Runs ────────────────────────────────────────────────────────────────

  // POST run — start a backup now. Answers 202 and finishes in the background; the
  // page follows it through GET.
  router.post('/gdrive-backup/run', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
    const config = getGdriveBackupConfig();
    if (!config.enabled) {
      res.apiError(409, 'GDRIVE_BACKUP_DISABLED', 'The Google Drive backup is turned off. Turn it on first.');
      return;
    }
    if (isGdriveBackupRunning()) {
      res.apiError(409, 'GDRIVE_BACKUP_ALREADY_RUNNING', 'A Google Drive backup is already in progress.');
      return;
    }
    if (gdriveBackupBlockedByLibraryWork()) {
      res.apiError(409, 'LIBRARY_BUSY', 'Library files are being moved or deleted right now. Try again when that is done.');
      return;
    }
    if (!(await isLibraryAvailable())) {
      res.apiError(503, 'LIBRARY_UNAVAILABLE', 'Your library is not connected. Reconnect it and try again.');
      return;
    }
    const ready = await ensureGdriveArchiveReady(config);
    if (!ready.ok) {
      res.apiError(409, 'GDRIVE_UNUSABLE', ready.warning);
      return;
    }

    const who = actor(req);
    void runGdriveBackup(config, new Date(), 'manual')
      .then(result => {
        if (!result.ran) return;
        logEvent({
          category: 'storage',
          event: 'gdrive_backup_run',
          level: result.failures.length > 0 ? 'warning' : 'info',
          message: `Google Drive backup: ${result.summary}.`,
          ...who,
          metadata: { copied: result.copied, skipped: result.skipped, failures: result.failures.length, cancelled: result.cancelled },
        });
      })
      .catch(err => {
        console.error('[gdrive-backup] manual run failed:', err instanceof Error ? err.message : err);
      });
    res.status(202);
    res.apiSuccess({ started: true });
  });

  router.post('/gdrive-backup/run/cancel', requireAdmin, strictRateLimiter, (_req: Request, res: Response) => {
    if (!cancelGdriveBackupRun()) {
      res.apiError(409, 'GDRIVE_BACKUP_NOT_RUNNING', 'No Google Drive backup is running.');
      return;
    }
    res.status(202);
    res.apiSuccess({ cancelling: true });
  });
}
