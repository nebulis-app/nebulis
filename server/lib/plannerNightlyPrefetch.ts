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
import { findCachedMaster, prewarmThumbnails } from './catalogPrefetch.js';
import { prefetchSkyImage } from './skyImage.js';
import { purgeJunkFiles, purgeStaleImportTmp } from './library/housekeeping.js';
import { refreshForecastCache } from './forecastCache.js';
import { checkAndUpdatePacks } from './catalogPack/updater.js';
import { addDaysToDateKey, localDateKey, localParts, zonedDateTimeToUtc } from './timezone.js';

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

// Called by the settings route when plannerPrefetchEnabled or
// plannerPrefetchTime changes so the next tick picks up the new config.
export function restartPlannerNightlyScheduler(): void {
  startPlannerNightlyScheduler();
}

export function isNightlyMaintenanceRunning(): boolean {
  return isRunning;
}

// Run the nightly batch immediately (the "Run now" button). Respects each
// task's enabled toggle, just like the scheduled run. Returns false if a run
// is already in progress. Runs in the background; last-run timestamps update
// as each task finishes.
export function triggerNightlyMaintenance(): boolean {
  if (isRunning) return false;
  runNightlyMaintenance().catch(err =>
    console.error('[nightly] Manual run failed:', err));
  return true;
}

// ─── Scheduler tick ───────────────────────────────────────────────────────────

function tick(): void {
  const settings = getSettingsData();
  const anyEnabled =
    settings.plannerPrefetchEnabled ||
    settings.nightlyCatalogPackCheckEnabled ||
    settings.nightlyHousekeepingEnabled ||
    settings.nightlyForecastPrefetchEnabled;
  if (!anyEnabled) return;

  const timeStr = (settings.plannerPrefetchTime as string | undefined) ?? '03:00';
  const tz = (settings.timezone as string | undefined) || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const { hh: targetHH, mm: targetMM } = parseHHMM(timeStr);
  const { hh, mm, dateStr } = localTime(new Date(), tz);

  // Fire if we're within ±1 minute of the target and haven't already run today
  const deltaMin = Math.abs(hh * 60 + mm - (targetHH * 60 + targetMM));
  if (deltaMin <= 1 && lastRanDate !== dateStr) {
    lastRanDate = dateStr;
    triggerNightlyMaintenance();
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
  const settings = getSettingsData();

  if (settings.nightlyCatalogPackCheckEnabled) {
    try {
      await checkAndUpdatePacks(prewarmThumbnails);
      console.log('[nightly] Catalog pack check complete');
    } catch (err) {
      console.error('[nightly] Catalog pack check failed:', err instanceof Error ? err.message : err);
    }
  }

  if (settings.plannerPrefetchEnabled) {
    await runPlannerNightlyPrefetch();
  }

  if (settings.nightlyHousekeepingEnabled) {
    try {
      await purgeJunkFiles();
      purgeStaleImportTmp();
      updateSettingsData({ nightlyHousekeepingLastRun: Date.now() });
      console.log('[nightly] Library housekeeping complete');
    } catch (err) {
      console.error('[nightly] Housekeeping failed:', err instanceof Error ? err.message : err);
    }
  }

  if (settings.nightlyForecastPrefetchEnabled) {
    try {
      await refreshForecastCache();
      updateSettingsData({ nightlyForecastLastRun: Date.now() });
      console.log('[nightly] Forecast pre-warm complete');
    } catch (err) {
      console.error('[nightly] Forecast pre-warm failed:', err instanceof Error ? err.message : err);
    }
  }
}

// ─── Planner job ──────────────────────────────────────────────────────────────

export async function runPlannerNightlyPrefetch(): Promise<void> {
  const settings = getSettingsData();
  const lat = settings.latitude as number | null | undefined;
  const lon = settings.longitude as number | null | undefined;

  if (typeof lat !== 'number' || typeof lon !== 'number') {
    console.log('[planner-prefetch] Skipping — no observer location configured');
    return;
  }

  const minAlt = (settings.minAlt as number | undefined) ?? 20;
  const horizonProfile = (settings.horizonProfile as number[] | undefined) ?? Array(36).fill(0);
  const tz = (settings.timezone as string | undefined) || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const now = new Date();
  const anchor = defaultNightAnchor(now, tz);
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

function defaultNightAnchor(now: Date, timeZone: string): Date {
  const parts = localParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  const nightDate = parts.hour >= 7 ? today : addDaysToDateKey(today, -1);
  return zonedDateTimeToUtc(nightDate, { hour: 12 }, timeZone);
}
