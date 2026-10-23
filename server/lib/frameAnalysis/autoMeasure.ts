/**
 * Background frame analysis after an import.
 *
 * Off by default (Settings → Library → "Analyze frames after import"). When on, a tick runs every couple of
 * minutes and measures the newest raw FITS frames that have no current measurement, one at a time, but only while
 * nothing else is working on the library. An import therefore finishes first and the analysis follows it, never
 * competing with it. Opening a night's frame list still measures that night on demand, whatever this setting says.
 */
import db from '../db.js';
import { getSettingsData } from '../telescopes.js';
import { currentLibraryWork } from '../libraryBusy.js';
import { FRAME_METRICS_VERSION } from './measure.js';
import { measureLibraryFile } from './service.js';
import { log } from '../logger.js';

const TICK_MS = 2 * 60_000;
const BOOT_DELAY_MS = 3 * 60_000;
const MAX_PER_TICK = 300;
const TICK_BUDGET_MS = 10 * 60_000;
/** How long a frame that could not be read is left alone before it is tried again. */
const UNREADABLE_RETRY_MS = 6 * 60 * 60_000;

const unreadable = new Map<string, number>();

const stmts = {
  pending: db.prepare<[number, string, number], { relPath: string }>(
    `SELECT f.relPath FROM libraryFiles f
     WHERE f.role = 'sub' AND f.missingSince IS NULL
       AND (lower(f.fileName) LIKE '%.fit' OR lower(f.fileName) LIKE '%.fits' OR lower(f.fileName) LIKE '%.fts')
       AND NOT EXISTS (SELECT 1 FROM frameMetrics m WHERE m.relPath = f.relPath AND m.version = ?)
       AND f.relPath NOT IN (SELECT value FROM json_each(?))
     ORDER BY f.importedAt DESC, f.id DESC LIMIT ?`,
  ),
};

export interface AutoMeasureTick {
  measured: number;
  failed: number;
  skippedBecause: 'disabled' | 'already-running' | 'library-busy' | null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function isAutoMeasureEnabled(): boolean {
  return getSettingsData().autoMeasureFrames === true;
}

/** The newest raw frames still waiting for a measurement. Exported for tests. */
export function pendingFrames(limit: number): string[] {
  const now = Date.now();
  for (const [relPath, at] of unreadable) if (now - at > UNREADABLE_RETRY_MS) unreadable.delete(relPath);
  return stmts.pending.all(FRAME_METRICS_VERSION, JSON.stringify([...unreadable.keys()]), limit).map(r => r.relPath);
}

export async function tickAutoMeasure(now: number = Date.now()): Promise<AutoMeasureTick> {
  const none = { measured: 0, failed: 0 };
  if (!isAutoMeasureEnabled()) return { ...none, skippedBecause: 'disabled' };
  if (running) return { ...none, skippedBecause: 'already-running' };
  if (currentLibraryWork() !== null) return { ...none, skippedBecause: 'library-busy' };

  running = true;
  let measured = 0;
  let failed = 0;
  try {
    for (const relPath of pendingFrames(MAX_PER_TICK)) {
      // Stop for anything that needs the library, for the switch being turned off, and for an over-long run.
      if (currentLibraryWork() !== null || !isAutoMeasureEnabled() || Date.now() - now > TICK_BUDGET_MS) break;
      try {
        await measureLibraryFile(relPath);
        measured++;
      } catch {
        unreadable.set(relPath, Date.now());
        failed++;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally {
    running = false;
  }
  if (measured || failed) log.info({ measured, failed }, '[frame-analysis] background analysis finished');
  return { measured, failed, skippedBecause: null };
}

export function startAutoMeasureScheduler(): void {
  stopAutoMeasureScheduler();
  const run = () => tickAutoMeasure().catch(err => log.warn({ err }, '[frame-analysis] background analysis failed'));
  timer = setInterval(() => void run(), TICK_MS);
  timer.unref();
  setTimeout(() => void run(), BOOT_DELAY_MS).unref();
}

export function stopAutoMeasureScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
