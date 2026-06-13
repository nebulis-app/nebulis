import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { restartPlannerNightlyScheduler, triggerNightlyMaintenance } from '../lib/plannerNightlyPrefetch.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getSettingsData, updateSettingsData, getApiKey, setApiKey } from '../lib/telescopes.js';
import db from '../lib/db.js';
import { DATA_DIR } from '../lib/paths.js';
import { getLibraryDir, isDefaultLocation, getLibraryId, writeMarker } from '../lib/libraryPath.js';
import { startPrefetch, cancelPrefetch } from '../lib/catalogPrefetch.js';
import { runUpdateCheck, stopAppUpdateChecker } from '../lib/appUpdate/updater.js';
import {
  enableDebugLogging,
  disableDebugLogging,
  getDebugLogStatus,
  getDebugLogPath,
} from '../lib/debugLogger.js';
import { getCurrentVersion } from '../lib/appUpdate/platform.js';

const router = Router();

const SettingsUpdateBodySchema = z.object({
  apiKey: z.string().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  locationName: z.string().optional(),
  timezone: z.string().optional(),
  minAlt: z.number().optional(),
  horizonProfile: z.array(z.number()).length(36).optional(),
  // Empty = "no visible-sky map set" (the planner's default). Otherwise it must
  // be exactly 144 (36 azimuth slices × 4 elevation bands). The storage layer
  // (saveSettingsRow) already normalizes non-144 to empty, so accept both here
  // rather than rejecting a whole settings save just because the map is unset.
  visibleSkyMap: z.array(z.boolean())
    .refine(a => a.length === 0 || a.length === 144, 'visibleSkyMap must be empty or have exactly 144 entries')
    .optional(),
  syncEnabled: z.boolean().optional(),
  syncJpg: z.boolean().optional(),
  syncFits: z.boolean().optional(),
  syncThumbnails: z.boolean().optional(),
  syncSubFrames: z.boolean().optional(),
  syncVideos: z.boolean().optional(),
  autoImportInterval: z.number().int().min(0).optional(),
  importJpg: z.boolean().optional(),
  importFits: z.boolean().optional(),
  importThumbnails: z.boolean().optional(),
  importSubFrames: z.boolean().optional(),
  importVideos: z.boolean().optional(),
  onboardingCompleted: z.boolean().optional(),
  prefetchCatalogAssets: z.boolean().optional(),
  prefetchUseCatalogPacks: z.boolean().optional(),
  planetariumShowInfo: z.boolean().optional(),
  galleryImageSource: z.enum(['sky-survey', 'telescope']).optional(),
  slideshowRotateCCW: z.boolean().optional(),
  temperatureUnit: z.enum(['celsius', 'fahrenheit']).optional(),
  updateChannel: z.enum(['stable', 'beta']).optional(),
  autoUpdateEnabled: z.boolean().optional(),
  plannerPrefetchEnabled: z.boolean().optional(),
  plannerPrefetchTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  nightlyCatalogPackCheckEnabled: z.boolean().optional(),
  nightlyHousekeepingEnabled: z.boolean().optional(),
  nightlyForecastPrefetchEnabled: z.boolean().optional(),
});

const ResetDatabaseBodySchema = z.object({
  confirmation: z.literal('delete'),
});

interface Settings {
  apiKey: string;
  // Observer location
  latitude: number | null;
  longitude: number | null;
  locationName: string;
  timezone: string;
  // Planner visibility
  minAlt: number;
  horizonProfile: number[]; // 36 values, one per 10° azimuth bucket (0°–350°)
  visibleSkyMap: boolean[]; // 144 values (36 az × 4 elevation bands); [] = not set
  syncEnabled: boolean;
  syncJpg: boolean;
  syncFits: boolean;
  syncThumbnails: boolean;
  syncSubFrames: boolean;
  syncVideos: boolean;
  // Local library import
  autoImportInterval: number;  // minutes
  importJpg: boolean;
  importFits: boolean;
  importThumbnails: boolean;
  importSubFrames: boolean;
  importVideos: boolean;
  // Onboarding
  onboardingCompleted: boolean;
  // Offline catalog imagery + Wikipedia descriptions — toggles the bulk
  // prefetch job on the backend so everything renders instantly from cache.
  prefetchCatalogAssets: boolean;
  // When true (default), download phase uses Nebulis catalog packs only.
  // When false, scrape DSS2 / Wikipedia / NASA directly.
  prefetchUseCatalogPacks: boolean;
  // Gallery
  planetariumShowInfo: boolean;
  galleryImageSource: 'sky-survey' | 'telescope';
  slideshowRotateCCW: boolean;
  temperatureUnit: 'celsius' | 'fahrenheit';
  // Desktop auto-update channel.
  updateChannel: 'stable' | 'beta';
  // Whether the updater checks + pre-downloads automatically. Off by default.
  autoUpdateEnabled: boolean;
  // Nightly maintenance
  plannerPrefetchEnabled: boolean;
  plannerPrefetchTime: string; // HH:MM in observer's local timezone
  plannerPrefetchLastRun: number | null; // Unix ms, read-only
  nightlyCatalogPackCheckEnabled: boolean;
  nightlyHousekeepingEnabled: boolean;
  nightlyForecastPrefetchEnabled: boolean;
  nightlyHousekeepingLastRun: number | null; // Unix ms, read-only
  nightlyForecastLastRun: number | null; // Unix ms, read-only
}

const defaultSettings: Settings = {
  apiKey: '',
  latitude: null,
  longitude: null,
  locationName: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  minAlt: 20,
  horizonProfile: Array(36).fill(0),
  visibleSkyMap: [],
  syncEnabled: true,
  syncJpg: true,
  syncFits: true,
  syncThumbnails: false,
  syncSubFrames: false,
  syncVideos: false,
  autoImportInterval: 60,
  importJpg: true,
  importFits: false,
  importThumbnails: false,
  importSubFrames: false,
  importVideos: false,
  onboardingCompleted: false,
  prefetchCatalogAssets: true,
  prefetchUseCatalogPacks: true,
  planetariumShowInfo: true,
  galleryImageSource: 'sky-survey',
  slideshowRotateCCW: false,
  temperatureUnit: 'fahrenheit',
  updateChannel: 'stable',
  autoUpdateEnabled: false,
  plannerPrefetchEnabled: true,
  plannerPrefetchTime: '03:00',
  plannerPrefetchLastRun: null,
  nightlyCatalogPackCheckEnabled: true,
  nightlyHousekeepingEnabled: true,
  nightlyForecastPrefetchEnabled: true,
  nightlyHousekeepingLastRun: null,
  nightlyForecastLastRun: null,
};

const appFields = ['apiKey', 'latitude', 'longitude', 'locationName', 'timezone', 'minAlt', 'horizonProfile', 'visibleSkyMap', 'syncEnabled', 'syncJpg', 'syncFits', 'syncThumbnails', 'syncSubFrames', 'syncVideos', 'autoImportInterval', 'importJpg', 'importFits', 'importThumbnails', 'importSubFrames', 'importVideos', 'onboardingCompleted', 'prefetchCatalogAssets', 'prefetchUseCatalogPacks', 'planetariumShowInfo', 'galleryImageSource', 'slideshowRotateCCW', 'temperatureUnit', 'updateChannel', 'autoUpdateEnabled', 'plannerPrefetchEnabled', 'plannerPrefetchTime', 'nightlyCatalogPackCheckEnabled', 'nightlyHousekeepingEnabled', 'nightlyForecastPrefetchEnabled'] as const;

function loadSettings(): Settings {
  const appData = getSettingsData();
  const merged = { ...defaultSettings, ...appData };
  return merged as Settings;
}

router.get('/', (_req: Request, res: Response) => {
  const settings = loadSettings();
  res.apiSuccess({
    ...settings,
    apiKey: settings.apiKey ? `${settings.apiKey.slice(0, 8)}...` : '',
    hasApiKey: !!settings.apiKey,
    plannerPrefetchLastRun: (settings.plannerPrefetchLastRun as number | null) ?? null,
    nightlyHousekeepingLastRun: (settings.nightlyHousekeepingLastRun as number | null) ?? null,
    nightlyForecastLastRun: (settings.nightlyForecastLastRun as number | null) ?? null,
  });
});

// Update settings
router.put('/', requireAdmin, async (req: Request, res: Response) => {
  const parsed = SettingsUpdateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const current = loadSettings();
  const updates = parsed.data;

  // Don't overwrite apiKey with masked value
  const masked = current.apiKey ? `${(current.apiKey as string).slice(0, 8)}...` : null;
  if (updates.apiKey && updates.apiKey === masked) delete updates.apiKey;

  // Only allow known fields
  const filtered: Record<string, unknown> = {};
  for (const key of appFields) {
    if (key in updates) filtered[key] = (updates as Record<string, unknown>)[key];
  }

  // Reverse geolocation: if latitude/longitude are being set, look up city/state
  if (('latitude' in filtered || 'longitude' in filtered) && filtered.latitude != null && filtered.longitude != null) {
    const lat = filtered.latitude as number;
    const lon = filtered.longitude as number;
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`, {
        headers: { 'User-Agent': 'nebulis-nebulis' }
      });
      if (response.ok) {
        const data = await response.json() as { address?: { city?: string; town?: string; county?: string; state?: string; country?: string } };
        const address = data.address || {};
        const city = address.city || address.town || address.county || 'Unknown';
        const state = address.state || '';
        filtered.locationName = state ? `${city}, ${state}` : city;
      }
    } catch (err) {
      console.error('[settings] Reverse geolocation failed:', err);
      // Fall through — locationName stays unchanged
    }
  }

  // Detect prefetch toggle transition BEFORE the write so we can compare
  // the old value to the new one and act only on actual flips.
  const prefetchFlippedOn =
    'prefetchCatalogAssets' in filtered
    && filtered.prefetchCatalogAssets === true
    && current.prefetchCatalogAssets !== true;
  const prefetchFlippedOff =
    'prefetchCatalogAssets' in filtered
    && filtered.prefetchCatalogAssets === false
    && current.prefetchCatalogAssets === true;

  // When onboarding transitions to completed with prefetch enabled, kick off
  // the download. Without this, the DB default of prefetchCatalogAssets=true
  // means the onboarding save is never detected as a "flip on".
  const onboardingJustFinishedWithPrefetch =
    'onboardingCompleted' in filtered
    && filtered.onboardingCompleted === true
    && current.onboardingCompleted !== true
    && (filtered.prefetchCatalogAssets === true
        || (!('prefetchCatalogAssets' in filtered) && current.prefetchCatalogAssets === true));

  if (Object.keys(filtered).length > 0) {
    updateSettingsData(filtered);
  }

  if (prefetchFlippedOn || onboardingJustFinishedWithPrefetch) {
    const after = loadSettings();
    startPrefetch({ packsOnly: after.prefetchUseCatalogPacks });
  } else if (prefetchFlippedOff) {
    cancelPrefetch();
  }

  // Turning auto-update on kicks an immediate check (which also re-arms the
  // periodic poll); turning it off stops the poll. Manual checks are unaffected.
  if ('autoUpdateEnabled' in filtered && filtered.autoUpdateEnabled !== current.autoUpdateEnabled) {
    if (filtered.autoUpdateEnabled) void runUpdateCheck();
    else stopAppUpdateChecker();
  } else if (
    // Switching channels while auto-update is on re-polls the new channel's
    // manifest right away so the banner reflects the choice.
    'updateChannel' in filtered
    && filtered.updateChannel !== current.updateChannel
    && current.autoUpdateEnabled
  ) {
    void runUpdateCheck();
  }

  // Restart nightly scheduler when its config changes
  if ('plannerPrefetchEnabled' in filtered || 'plannerPrefetchTime' in filtered ||
      'nightlyCatalogPackCheckEnabled' in filtered ||
      'nightlyHousekeepingEnabled' in filtered || 'nightlyForecastPrefetchEnabled' in filtered) {
    restartPlannerNightlyScheduler();
  }

  const settings = loadSettings();
  res.apiSuccess({
    ...settings,
    apiKey: settings.apiKey ? `${settings.apiKey.slice(0, 8)}...` : '',
    hasApiKey: !!settings.apiKey,
    plannerPrefetchLastRun: (settings.plannerPrefetchLastRun as number | null) ?? null,
    nightlyHousekeepingLastRun: (settings.nightlyHousekeepingLastRun as number | null) ?? null,
    nightlyForecastLastRun: (settings.nightlyForecastLastRun as number | null) ?? null,
  });
});

// Run the nightly maintenance batch now, on demand. Respects each task's
// enabled toggle. The work runs in the background; the client refetches
// settings to see updated last-run times.
router.post('/nightly/run', requireAdmin, (_req: Request, res: Response) => {
  const started = triggerNightlyMaintenance();
  if (!started) {
    res.apiError(409, 'ALREADY_RUNNING', 'Nightly maintenance is already running.');
    return;
  }
  res.apiSuccess({ started: true });
});

// Generate a new API key
router.post('/generate-api-key', requireAdmin, (_req: Request, res: Response) => {
  const newKey = `shub_${crypto.randomBytes(24).toString('hex')}`;
  setApiKey(newKey);

  // Return the full key once — it won't be shown again
  res.apiSuccess({
    apiKey: newKey,
    message: 'Save this key — it will not be shown again. Use it in X-API-Key header or Authorization: Bearer header.',
  });
});

// Revoke API key
router.delete('/api-key', requireAdmin, (_req: Request, res: Response) => {
  setApiKey('');
  res.apiSuccess({ revoked: true });
});

// Reset database — purge all data except settings
router.delete('/reset-database', requireAdmin, (req: Request, res: Response) => {
  const LIBRARY_DIR = getLibraryDir();
  const parsed = ResetDatabaseBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(400, 'CONFIRMATION_REQUIRED', 'You must send { "confirmation": "delete" } to confirm');
    return;
  }

  try {
    // 1. Purge database tables (keep settings, users, telescope profiles)
    const tablesToClear = [
      'libraryDeletedSessions',
      'librarySessions',
      'libraryObjects',
      'libraryMeta',
      'notes',
      'wishlist',
      'favorites',
    ];
    for (const table of tablesToClear) {
      db.exec(`DELETE FROM ${table}`);
    }
    // Re-insert the singleton libraryMeta row
    db.exec(`INSERT OR IGNORE INTO libraryMeta (id, version) VALUES (1, 1)`);

    // 2. Remove local data directories
    const dirsToRemove = [
      LIBRARY_DIR,
      path.join(DATA_DIR, 'thumbnails'),
      path.join(DATA_DIR, 'sky-cache'),
      path.join(DATA_DIR, 'tle-archive'),
      path.join(DATA_DIR, 'cache'),
    ];
    for (const dir of dirsToRemove) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* directory may not exist */ }
    }

    // 3. Remove the TLE catalog cache file
    try {
      fs.unlinkSync(path.join(DATA_DIR, 'tle-catalog.json'));
    } catch { /* may not exist */ }

    // 4. Recreate the thumbnails cache directory so image generation works
    //    immediately without a server restart. The server initialises
    //    THUMBNAILS_DIR with mkdirSync at startup; rmSync above deletes it,
    //    leaving requests broken until the directory is restored.
    try {
      fs.mkdirSync(path.join(DATA_DIR, 'thumbnails'), { recursive: true });
    } catch { /* best effort */ }

    // 5. If the library lives on a non-default (external) drive, recreate the
    //    directory and marker so the app knows the drive is still connected.
    //    Without this, isLibraryAvailable() returns false and the "reconnect
    //    your drive" banner appears even though the drive was never disconnected.
    if (!isDefaultLocation()) {
      try {
        fs.mkdirSync(LIBRARY_DIR, { recursive: true });
        writeMarker(LIBRARY_DIR, getLibraryId());
      } catch { /* best effort — drive may have been removed between purge and here */ }
    }

    console.log('[settings] Database reset completed — all data purged, settings preserved');
    res.apiSuccess({ reset: true });
  } catch (err) {
    console.error('[settings] Database reset failed:', err);
    res.apiError(500, 'RESET_FAILED', 'Failed to reset database');
  }
});

// ─── Debug logging ──────────────────────────────────────────────────────────

router.get('/debug-logging/status', requireAdmin, (_req: Request, res: Response) => {
  res.apiSuccess(getDebugLogStatus());
});

router.post('/debug-logging/enable', requireAdmin, (_req: Request, res: Response) => {
  const { version, build } = getCurrentVersion();
  const appVersion = build > 0 ? `${version} (${build})` : version;

  let settings: Record<string, unknown> | undefined;
  try {
    const s = getSettingsData();
    settings = {
      importJpg: s.importJpg,
      importFits: s.importFits,
      importSubFrames: s.importSubFrames,
      importThumbnails: s.importThumbnails,
      importVideos: s.importVideos,
      syncEnabled: s.syncEnabled,
      autoImportInterval: s.autoImportInterval,
    };
  } catch { /* best-effort */ }

  let dbStats: { objects: number; sessions: number; files: number } | undefined;
  try {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    dbStats = {
      objects: n('SELECT COUNT(*) AS n FROM libraryObjects'),
      sessions: n('SELECT COUNT(*) AS n FROM librarySessions'),
      files: n('SELECT COUNT(*) AS n FROM libraryFiles'),
    };
  } catch { /* best-effort */ }

  res.apiSuccess(enableDebugLogging({
    appVersion,
    libraryDir: getLibraryDir(),
    dataDir: DATA_DIR,
    settings,
    dbStats,
  }));
});

router.post('/debug-logging/disable', requireAdmin, (_req: Request, res: Response) => {
  res.apiSuccess(disableDebugLogging());
});

router.get('/debug-logging/download', requireAdmin, (_req: Request, res: Response) => {
  const logPath = getDebugLogPath();
  if (!logPath) {
    res.apiError(404, 'NOT_FOUND', 'No debug log file is available. Enable debug logging and run an import first.');
    return;
  }
  const filename = `${path.basename(logPath)}.gz`;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const readStream = fs.createReadStream(logPath);
  const gzip = zlib.createGzip();
  readStream.on('error', (err) => {
    console.error('[settings] Debug log download error:', err.message);
    if (!res.headersSent) {
      res.apiError(500, 'STREAM_ERROR', 'Failed to read debug log file');
    }
  });
  readStream.pipe(gzip).pipe(res);
});

export { router as settingsRouter };
