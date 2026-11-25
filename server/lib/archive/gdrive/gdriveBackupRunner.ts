/**
 * Running the Google Drive backup: the progress slot, a manual or scheduled run, and
 * the schedule tick.
 *
 * It is the Drive counterpart of `archivePipeline.ts` plus `archiveScheduler.ts`,
 * with its own state, so a disk archive run and a Drive backup run can be in
 * progress at the same time. The due-ness rules are the disk archive's own
 * (`isArchiveDue`), so "every day at 03:00" means the same thing for both.
 *
 * **It does not take the library lock.** The lock exists because an archive run may
 * delete local subframes and prune, and those must not overlap an import. The Drive
 * backup only reads the library and only adds to Drive, so holding the lock would
 * just block imports, and the disk archive, for the hours a first upload can take.
 * It does refuse to *start* while something is moving or deleting library files (a
 * migration, a purge, a repair, a reorganize), since files would vanish under it.
 */

import { isLibraryAvailable } from '../../libraryPath.js';
import { isLibraryMigrating } from '../../libraryMaintenance.js';
import { currentLibraryWork, type LibraryWork } from '../../libraryBusy.js';
import { createCloudDatabaseBackup } from '../../db.js';
import { parseCron } from '../archiveCron.js';
import { archiveScheduleTimeZone, isArchiveDue, type ArchiveSchedule } from '../archiveScheduler.js';
import type { ArchiveRunProgress, ArchiveRunResult } from '../archiveCopy.js';
import { getGdriveBackupConfig, setGdriveBackupConfig, type GdriveBackupConfig } from './gdriveBackupConfig.js';
import { runGdriveArchive } from './driveArchive.js';

export type GdriveBackupTrigger = 'scheduled' | 'manual';

export interface GdriveBackupResult extends ArchiveRunResult {
  /** The one-line account stored in `lastResult` and shown in Settings. */
  summary: string;
}

export interface GdriveBackupLastRun {
  trigger: GdriveBackupTrigger;
  /** ISO, like `finishedAt`, so one object gives the run's duration. */
  startedAt: string;
  finishedAt: string;
  result: GdriveBackupResult;
}

const IDLE: ArchiveRunProgress = {
  running: false,
  phase: 'idle',
  filesTotal: 0,
  filesDone: 0,
  bytesTotal: 0,
  bytesDone: 0,
  copied: 0,
  skipped: 0,
  startedAt: null,
  finishedAt: null,
  warnings: [],
};

let progress: ArchiveRunProgress = { ...IDLE };
let lastRun: GdriveBackupLastRun | null = null;
let activeAbort: AbortController | null = null;

export function getGdriveBackupProgress(): ArchiveRunProgress {
  return { ...progress, warnings: [...progress.warnings] };
}

export function isGdriveBackupRunning(): boolean {
  return progress.running;
}

/** The most recent run finished by this process, or null when none has. */
export function getLastGdriveBackupRun(): GdriveBackupLastRun | null {
  return lastRun;
}

/** Ask the run in progress to stop at the next file. False when none is running. */
export function cancelGdriveBackupRun(): boolean {
  if (activeAbort === null) return false;
  activeAbort.abort();
  return true;
}

/** Test seam: forget the in-memory state. */
export function resetGdriveBackupStateForTests(): void {
  progress = { ...IDLE };
  lastRun = null;
  activeAbort = null;
  backoff = null;
}

/** Library work that moves or deletes files, during which a backup must not start. */
const MOVING_WORK: ReadonlySet<LibraryWork> = new Set<LibraryWork>(['purge', 'repair', 'reorganize']);

/** Whether a backup must not start now because library files are being moved or deleted. */
export function gdriveBackupBlockedByLibraryWork(): boolean {
  if (isLibraryMigrating()) return true;
  const work = currentLibraryWork();
  return work !== null && MOVING_WORK.has(work);
}

function summarise(result: ArchiveRunResult): string {
  const attempted = result.copied + result.skipped + result.failures.length;
  if (result.diskLost) return 'failed: Google Drive access was lost during the run';
  if (result.cancelled) return `cancelled: ${result.copied} uploaded, ${result.skipped} already in Drive`;
  if (result.failures.length > 0) return `failed: ${result.failures.length} of ${attempted} files`;
  let text = `${result.copied} uploaded, ${result.skipped} already in Drive`;
  if (result.linkedSkipped > 0) text += `; ${result.linkedSkipped} linked file(s) not included`;
  return text;
}

/**
 * One backup run, start to finish: copy, then the database, then stamp the result.
 *
 * A refusal (`ran: false`) writes nothing to the config and is not an attempt. A
 * cancelled run, or one that lost its sign-in, records its result but not `lastRunAt`,
 * so the schedule still considers itself due.
 */
export async function runGdriveBackup(
  config: GdriveBackupConfig,
  now: Date,
  trigger: GdriveBackupTrigger,
): Promise<GdriveBackupResult> {
  if (progress.running) {
    return {
      ran: false,
      reason: 'already-running',
      copied: 0,
      skipped: 0,
      tooYoungSkipped: 0,
      linkedSkipped: 0,
      cancelled: false,
      bytesCopied: 0,
      failures: [],
      warnings: [],
      summary: '',
    };
  }
  lastRun = null;
  const startedAt = new Date();
  progress = { ...IDLE, running: true, phase: 'scanning', startedAt: startedAt.getTime() };
  const controller = new AbortController();
  activeAbort = controller;

  let copy: ArchiveRunResult;
  try {
    copy = await runGdriveArchive(config, {
      signal: controller.signal,
      report: patch => {
        progress = { ...progress, ...patch };
      },
      takeDatabaseSnapshot: () => {
        createCloudDatabaseBackup();
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    copy = {
      ran: true,
      copied: progress.copied,
      skipped: progress.skipped,
      tooYoungSkipped: 0,
      linkedSkipped: 0,
      cancelled: false,
      bytesCopied: 0,
      failures: [{ archiveRelPath: '(run)', error }],
      warnings: [error],
    };
  } finally {
    if (activeAbort === controller) activeAbort = null;
  }

  if (!copy.ran) {
    progress = { ...IDLE, phase: 'failed', finishedAt: Date.now(), warnings: [...copy.warnings] };
    const result = { ...copy, summary: '' };
    lastRun = { trigger, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), result };
    return result;
  }

  progress = {
    ...progress,
    running: false,
    phase: copy.failures.length > 0 || copy.diskLost ? 'failed' : 'done',
    finishedAt: Date.now(),
    warnings: [...copy.warnings],
  };
  const summary = summarise(copy);
  const complete = !copy.cancelled && !copy.diskLost;
  setGdriveBackupConfig(
    complete
      ? { lastRunAt: now.toISOString(), lastAttemptAt: now.toISOString(), lastResult: summary }
      : { lastAttemptAt: now.toISOString(), lastResult: summary },
  );
  const result = { ...copy, summary };
  lastRun = { trigger, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), result };
  return result;
}

// ─── The schedule ───────────────────────────────────────────────────────────

export type GdriveTickSkip = 'disabled' | 'not-due' | 'already-running' | 'library-busy' | 'library-unavailable' | 'refused';

export interface GdriveTickOutcome {
  ran: boolean;
  skippedBecause: GdriveTickSkip | null;
}

/** How long a scheduled tick waits after a refusal before it tries Drive again. */
export const GDRIVE_REFUSAL_BACKOFF_MS = 60 * 60_000;

let backoff: { until: number; key: string } | null = null;

/** What identifies "the same backup", so a backoff earned by one folder or sign-in
 *  does not hold back the one the user has just set up instead. */
function backupKey(config: GdriveBackupConfig): string {
  return `${config.clientId}:${config.folderId}:${config.archiveId}:${config.account}`;
}

export function gdriveScheduleOf(config: GdriveBackupConfig): ArchiveSchedule {
  return {
    mode: config.scheduleMode,
    hour: config.scheduleHour,
    minute: config.scheduleMinute,
    intervalHours: config.scheduleIntervalHours,
    cron: config.scheduleCron,
  };
}

const skip = (reason: GdriveTickSkip): GdriveTickOutcome => ({ ran: false, skippedBecause: reason });

/** One scheduler decision. `now` and the timezone are parameters so it can be tested. */
export async function tickGdriveBackupScheduler(
  now: Date = new Date(),
  timeZone: string = archiveScheduleTimeZone(),
): Promise<GdriveTickOutcome> {
  const config = getGdriveBackupConfig();
  if (!config.enabled || !config.scheduleEnabled || config.archiveId === '') return skip('disabled');

  // Pure arithmetic first: nothing below touches the network unless a run is due.
  const schedule = gdriveScheduleOf(config);
  const parsed = schedule.mode === 'custom' ? parseCron(schedule.cron) : null;
  if (!isArchiveDue(now, schedule, config.lastRunAt, timeZone, parsed?.ok ? parsed.cron : null)) return skip('not-due');

  if (progress.running) return skip('already-running');
  if (gdriveBackupBlockedByLibraryWork()) return skip('library-busy');
  if (backoff !== null && backoff.key === backupKey(config) && now.getTime() < backoff.until) return skip('refused');
  // An unmounted library selects nothing, and a run over zero files would be stamped
  // as a success and write off the day.
  if (!(await isLibraryAvailable())) return skip('library-unavailable');

  const result = await runGdriveBackup(config, now, 'scheduled');
  if (!result.ran) {
    if (result.reason === 'already-running') return skip('already-running');
    backoff = { until: now.getTime() + GDRIVE_REFUSAL_BACKOFF_MS, key: backupKey(config) };
    const text = `skipped: ${result.failures[0]?.error ?? result.warnings[0] ?? 'Google Drive could not be used'}`;
    if (config.lastResult !== text) setGdriveBackupConfig({ lastResult: text });
    return skip('refused');
  }
  backoff = null;
  return { ran: true, skippedBecause: null };
}

let checkInterval: ReturnType<typeof setInterval> | null = null;

export function startGdriveBackupScheduler(): void {
  if (checkInterval !== null) clearInterval(checkInterval);
  checkInterval = setInterval(() => {
    tickGdriveBackupScheduler().catch(err =>
      console.error('[gdrive-backup] scheduled tick failed:', err instanceof Error ? err.message : err),
    );
  }, 60_000);
  console.log('[gdrive-backup] Scheduler started');
}
