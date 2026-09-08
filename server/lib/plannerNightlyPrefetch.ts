/**
 * Nightly Planner Pre-cache
 *
 * Fires once per night at a user-configured local time (default 03:00) to
 * warm the server-side resize cache for every DSO that will be visible from
 * the observer's location that night. After this job runs, any client that
 * opens the Planner tab gets instant image responses with no live DSS2 fetches.
 *
 * Scheduler strategy: check every 60 seconds whether the current local time
 * matches the configured HH:MM. A `lastRanDate` guard (local YYYY-MM-DD)
 * prevents the job from firing more than once per calendar day.
 */

import { getCatalog } from './dsoCatalog.js';
import { getNightWindow, visibilityWindow } from './astroCalc.js';
import { getSettingsData, updateSettingsData } from './telescopes.js';
import { getActiveSite } from './observingSites.js';
import { findCachedMaster, prewarmThumbnails } from './catalogPrefetch.js';
import { prefetchSkyImage } from './skyImage.js';
import { purgeJunkFiles, purgeStaleImportTmp, pruneImportLog } from './library/housekeeping.js';
import { pruneSystemLog } from './systemLog.js';
import { refreshForecastCache } from './forecastCache.js';
import { checkAndUpdatePacks } from './catalogPack/updater.js';
import { localDateKey, localParts } from './timezone.js';
import { observingNightAnchor } from './telescopeFiles.js';

// ─── Scheduler state ──────────────────────────────────────────────────────────

let checkInterval: ReturnType<typeof setInterval> | null = null;
let lastRanDate: string | null = null; // YYYY-MM-DD in observer's local timezone
let isRunning = false; // Guards against overlapping scheduled + manual runs

// ─── Public API ───────────────────────────────────────────────────────────────

export function startPlannerNightlyScheduler(): void {
  stopPlannerNightlyScheduler();
  checkInterval = setInterval(tick, 60_000);
  console.log('[planner-prefetch] Nightly scheduler started');
}

export function stopPlannerNightlyScheduler(): void {
  if (checkInterval !== null) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

// Called by the settings route when the maintenance config (master toggle or
// run time) changes so the next tick picks up the new config.
export function restartPlannerNightlyScheduler(): void {
  startPlannerNightlyScheduler();
}

export function isNightlyMaintenanceRunning(): boolean {
  return isRunning;
}

// Run the nightly batch immediately (the "Run now" button). Runs every task,
// just like the scheduled run. Returns false if a run is already in progress.
// Runs in the background; last-run timestamps update as each task finishes.
export function triggerNightlyMaintenance(): boolean {
  if (isRunning) return false;
  runNightlyMaintenance().catch(err =>
    console.error('[nightly] Manual run failed:', err));
  return true;
}

// ─── Scheduler tick ───────────────────────────────────────────────────────────

/**
 * Whether the nightly batch is due: it has not run on today's local date and
 * the local clock has reached the configured target time.
 *
 * This replaced a `±1 minute` window that silently skipped the whole batch for
 * the day if the process was asleep or GC-paused across the two minutes it was
 * open (laptop lid, container throttle). "Have we run since the target time
 * today" catches up whenever the process wakes.
 *
 * `lastRanDate` is stamped only after every task has at least been attempted
 * (not before the run starts): stamping it eagerly meant a run that threw
 * partway through was never retried until the next calendar day.
 */
export function isNightlyBatchDue(
  now: Date,
  targetTime: string,
  timeZone: string,
  lastRanDate: string | null,
): boolean {
  const { hh: targetHH, mm: targetMM } = parseHHMM(targetTime);
  const { hh, mm, dateStr } = localTime(now, timeZone);
  return lastRanDate !== dateStr && (hh * 60 + mm) >= (targetHH * 60 + targetMM);
}

function tick(): void {
  const settings = getSettingsData();
  // Single master switch gates the whole nightly batch. The per-task flags
  // (plannerPrefetchEnabled, nightlyCatalogPackCheckEnabled, etc.) are kept in
  // the schema for backward compatibility but no longer consulted — when the
  // master is on, every task runs.
  if (!settings.nightlyMaintenanceEnabled) return;

  const timeStr = (settings.plannerPrefetchTime as string | undefined) ?? '03:00';
  const tz = (settings.timezone as string | undefined) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();

  // `!isRunning` guards against this tick firing twice while an attempt is
  // still in flight and lastRanDate isn't stamped yet — runNightlyMaintenance()
  // also no-ops on isRunning, so this just avoids the redundant call.
  if (isNightlyBatchDue(now, timeStr, tz, lastRanDate) && !isRunning) {
    const { dateStr } = localTime(now, tz);
    runNightlyMaintenance()
      .catch(err => console.error('[nightly] Scheduled run failed:', err))
      .finally(() => { lastRanDate = dateStr; });
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runNightlyMaintenance(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await runNightlyTasks();
  } finally {
    isRunning = false;
  }
}

async function runNightlyTasks(): Promise<void> {
  // Every task runs when the batch fires — the per-task flags are no longer
  // consulted. Each is wrapped so one failure can't stop the rest.

  try {
    await checkAndUpdatePacks(prewarmThumbnails);
    console.log('[nightly] Catalog pack check complete');
  } catch (err) {
    console.error('[nightly] Catalog pack check failed:', err instanceof Error ? err.message : err);
  }

  try {
    await runPlannerNightlyPrefetch();
  } catch (err) {
    console.error('[nightly] Planner prefetch failed:', err instanceof Error ? err.message : err);
  }

  try {
    await purgeJunkFiles();
    purgeStaleImportTmp();
    pruneSystemLog();
    pruneImportLog();
    updateSettingsData({ nightlyHousekeepingLastRun: Date.now() });
    console.log('[nightly] Library housekeeping complete');
  } catch (err) {
    console.error('[nightly] Housekeeping failed:', err instanceof Error ? err.message : err);
  }

  try {
    await refreshForecastCache();
    updateSettingsData({ nightlyForecastLastRun: Date.now() });
    console.log('[nightly] Forecast pre-warm complete');
  } catch (err) {
    console.error('[nightly] Forecast pre-warm failed:', err instanceof Error ? err.message : err);
  }
}

// ─── Planner job ──────────────────────────────────────────────────────────────

export async function runPlannerNightlyPrefetch(): Promise<void> {
  // Warms the cache for whichever site the planner is currently pointed at.
  // A multi-site user who switches sites during the day gets that night's
  // targets pre-warmed for the site they'll actually observe from tonight;
  // other sites' thumbnails are computed on demand instead of pre-warmed.
  const site = getActiveSite();
  const lat = site.latitude;
  const lon = site.longitude;

  if (typeof lat !== 'number' || typeof lon !== 'number') {
    console.log('[planner-prefetch] Skipping — no observer location configured');
    return;
  }

  const minAlt = site.minAlt;
  const horizonProfile = site.horizonProfile;
  const tz = site.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const now = new Date();
  const anchor = observingNightAnchor(now, tz);
  const night = getNightWindow(anchor, lat, lon);
  const nightStart = night.nightStart ?? night.nauticalDusk;
  const nightEnd = night.nightEnd ?? night.nauticalDawn;
  if (!nightStart || !nightEnd || nightEnd.getTime() <= nightStart.getTime()) {
    console.log('[planner-prefetch] Skipping, no astronomical or nautical dark window tonight');
    updateSettingsData({ plannerPrefetchLastRun: Date.now() });
    return;
  }

  // Identify all catalog objects visible tonight from this location
  const catalog = getCatalog();
  const visibleIds: string[] = [];

  for (let i = 0; i < catalog.length; i++) {
    if (i > 0 && i % 100 === 0) await new Promise<void>(r => setImmediate(r));
    const entry = catalog[i]!;
    const w = visibilityWindow(entry.ra, entry.dec, lat, lon, nightStart, nightEnd, minAlt, horizonProfile);
    if (w.maxAlt >= minAlt && w.rises) visibleIds.push(entry.id);
  }

  console.log(`[planner-prefetch] ${visibleIds.length} objects visible tonight — warming thumbnails`);
  updateSettingsData({ plannerPrefetchLastRun: Date.now() });

  let warmed = 0, skipped = 0, errors = 0;
  const CONCURRENCY = 3;

  for (let i = 0; i < visibleIds.length; i += CONCURRENCY) {
    await Promise.all(visibleIds.slice(i, i + CONCURRENCY).map(async id => {
      try {
        let master = findCachedMaster(id);
        if (!master) {
          const fetched = await prefetchSkyImage(id);
          if (fetched) master = findCachedMaster(id);
        }
        if (master) {
          await prewarmThumbnails(id, master.path, master.source);
          warmed++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors++;
        console.warn(`[planner-prefetch] ${id}:`, err instanceof Error ? err.message : err);
      }
    }));
  }

  console.log(`[planner-prefetch] Done — ${warmed} warmed, ${skipped} no image, ${errors} errors`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseHHMM(timeStr: string): { hh: number; mm: number } {
  const [hPart, mPart] = timeStr.split(':');
  return { hh: parseInt(hPart ?? '3', 10), mm: parseInt(mPart ?? '0', 10) };
}

function localTime(date: Date, tz: string): { hh: number; mm: number; dateStr: string } {
  const parts = localParts(date, tz);
  return {
    hh: parts.hour,
    mm: parts.minute,
    dateStr: localDateKey(date, tz),
  };
}

