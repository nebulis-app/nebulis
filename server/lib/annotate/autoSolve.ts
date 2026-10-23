/**
 * Background plate solving.
 *
 * A plate solution is what makes Annotate exact and instant, and it is a few seconds of work per picture, so rather
 * than make someone wait the first time they tap Annotate, stacked pictures are solved in the background and the
 * result is kept in the `fileWcs` table. A frame that cannot be solved (too few stars) is remembered in
 * `fileSolveFailures` against its mtime, so it is not retried until the file changes.
 *
 * Every tick, when the setting is on and nothing else is working on the library, the newest unsolved pictures are
 * solved one at a time. A fresh install drains its backlog within a few ticks; after that each sync's new stacks
 * are picked up on the next one. The plate solver itself is downloaded here too when it is missing.
 */
import path from 'path';
import db from '../db.js';
import { getSettingsData } from '../telescopes.js';
import { currentLibraryWork } from '../libraryBusy.js';
import { getSolverStatus, installSolver } from './astap.js';
import { solveAndStore, AnnotateInputError } from './annotateService.js';
import { UNSOLVABLE_OBJECT_IDS } from './unsolvable.js';
import { log } from '../logger.js';

const TICK_MS = 10 * 60_000;
const BOOT_DELAY_MS = 90_000;
const MAX_PER_TICK = 40;
const TICK_BUDGET_MS = 20 * 60_000;
const INSTALL_RETRY_MS = 30 * 60_000;
/** How long a picture whose file is gone from disk is left alone before it is looked for again. */
const MISSING_RETRY_MS = 6 * 60 * 60_000;

const UNSOLVABLE_OBJECTS = JSON.stringify(UNSOLVABLE_OBJECT_IDS);

/** Pictures whose file was not on disk when tried, so a missing file is not retried (and logged) every tick. */
const notFound = new Map<string, number>();

const stmts = {
  pending: db.prepare<[string, string, number], { relPath: string }>(
    `SELECT f.relPath FROM libraryFiles f
     WHERE f.role IN ('stacked', 'preview') AND f.missingSince IS NULL
       -- Pictures only, filtered here rather than after the LIMIT: a stacked FITS is never solved or marked failed,
       -- so filtering later let the newest FITS rows fill every batch and the queue never moved.
       AND (lower(f.fileName) LIKE '%.jpg' OR lower(f.fileName) LIKE '%.jpeg' OR lower(f.fileName) LIKE '%.png'
            OR lower(f.fileName) LIKE '%.tif' OR lower(f.fileName) LIKE '%.tiff')
       AND NOT EXISTS (SELECT 1 FROM fileWcs w WHERE w.relPath = f.relPath)
       AND NOT EXISTS (SELECT 1 FROM fileSolveFailures x WHERE x.relPath = f.relPath)
       AND lower(f.objectId) NOT IN (SELECT value FROM json_each(?))
       AND f.relPath NOT IN (SELECT value FROM json_each(?))
     ORDER BY f.importedAt DESC, f.id DESC LIMIT ?`,
  ),
  counts: db.prepare<[], { solved: number; failed: number }>(
    `SELECT (SELECT COUNT(*) FROM fileWcs) AS solved, (SELECT COUNT(*) FROM fileSolveFailures) AS failed`,
  ),
};

export interface AutoSolveStatus {
  enabled: boolean;
  running: boolean;
  /** Pictures still waiting for a solution. */
  pending: number;
  solved: number;
  failed: number;
}

export interface AutoSolveTick {
  solved: number;
  failed: number;
  skippedBecause: 'disabled' | 'already-running' | 'library-busy' | 'solver-unavailable' | null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastInstallAttempt = 0;

export function isAutoSolveEnabled(): boolean {
  return getSettingsData().annotateAutoSolve !== false;
}

/** The newest pictures still waiting for a solve, oldest-imported last. Exported for tests. */
export function pendingFiles(limit: number): string[] {
  const now = Date.now();
  for (const [relPath, at] of notFound) if (now - at > MISSING_RETRY_MS) notFound.delete(relPath);
  return stmts.pending.all(UNSOLVABLE_OBJECTS, JSON.stringify([...notFound.keys()]), limit).map(r => r.relPath);
}

export function getAutoSolveStatus(): AutoSolveStatus {
  const counts = stmts.counts.get() ?? { solved: 0, failed: 0 };
  return { enabled: isAutoSolveEnabled(), running, pending: pendingFiles(100_000).length, ...counts };
}

export async function tickAutoSolve(now: number = Date.now()): Promise<AutoSolveTick> {
  const none = { solved: 0, failed: 0 };
  if (!isAutoSolveEnabled()) return { ...none, skippedBecause: 'disabled' };
  if (running) return { ...none, skippedBecause: 'already-running' };
  if (currentLibraryWork() !== null) return { ...none, skippedBecause: 'library-busy' };

  let solver = getSolverStatus();
  if (solver.supported && !solver.ready && solver.state !== 'downloading' && solver.state !== 'extracting'
      && now - lastInstallAttempt > INSTALL_RETRY_MS) {
    lastInstallAttempt = now;
    log.info('[annotate] downloading the plate solver for background solving');
    await installSolver().catch(err => log.warn({ err }, '[annotate] plate solver install failed'));
    solver = getSolverStatus();
  }
  if (!solver.ready) return { ...none, skippedBecause: 'solver-unavailable' };

  running = true;
  let solved = 0;
  let failed = 0;
  let missing = 0;
  try {
    for (const relPath of pendingFiles(MAX_PER_TICK)) {
      // Stop for anything that needs the library, and for a disabled switch or an over-long run.
      if (currentLibraryWork() !== null || !isAutoSolveEnabled() || Date.now() - now > TICK_BUDGET_MS) break;
      try {
        const outcome = await solveAndStore(relPath);
        if (outcome === 'solved') solved++;
        else if (outcome === 'failed') failed++;
      } catch (err) {
        // A file that vanished or cannot be read must not stall the rest of the queue. A missing file is set aside
        // quietly (one summary line below); anything else is worth its own line.
        if (err instanceof AnnotateInputError && err.status === 404) {
          notFound.set(relPath, Date.now());
          missing++;
          continue;
        }
        log.warn({ relPath: path.basename(relPath), err: err instanceof Error ? err.message : String(err) }, '[annotate] auto-solve skipped a file');
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally {
    running = false;
  }
  if (missing) log.warn({ missing }, '[annotate] auto-solve found pictures whose files are not on disk; they are skipped for a few hours');
  if (solved || failed) log.info({ solved, failed }, '[annotate] background solve finished');
  return { solved, failed, skippedBecause: null };
}

export function startAutoSolveScheduler(): void {
  stopAutoSolveScheduler();
  const run = (what: string) => tickAutoSolve().catch(err =>
    console.error(`[annotate] ${what} auto-solve failed:`, err instanceof Error ? err.message : err));
  timer = setInterval(() => void run('scheduled'), TICK_MS);
  timer.unref();
  // A server that was off while pictures arrived catches up shortly after boot, once the rest of startup has settled.
  setTimeout(() => void run('boot'), BOOT_DELAY_MS).unref();
  console.log('[annotate] Auto-solve scheduler started');
}

export function stopAutoSolveScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
