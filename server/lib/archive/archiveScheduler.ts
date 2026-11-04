/**
 * The archive schedule.
 *
 * Three modes, evaluated on a one-minute tick, all in the observer's local time.
 * Four details are load-bearing, and the first two are copied from
 * `plannerNightlyPrefetch` because it already paid for them.
 *
 * **Daily and interval catch up; they are not a window.** That scheduler originally
 * fired inside a `±1 minute` window and therefore silently skipped the whole batch
 * for the day whenever the process was asleep, throttled, or GC-paused across those
 * two minutes — a laptop lid, a container. "Has it run since the target time today"
 * runs as soon as the process is awake, which for a nightly job is the behaviour
 * anyone would expect. The interval mode gets the same treatment for free by
 * measuring elapsed time rather than waiting for a slot.
 *
 * The daily catch-up is bounded by the local day, which is the one case worth knowing
 * about: a run missed at 23:30 on Monday is due again at 23:30 on Tuesday rather than
 * the moment the process wakes on Tuesday morning. Catching up across midnight would
 * mean a run window that is not a day, and a schedule that can fire twice within a few
 * hours of itself. The interval mode is the one to use for "as soon as possible after
 * N hours".
 *
 * **Custom does not catch up.** A cron expression names minutes, and there is no
 * honest way to decide that a run missed at 03:00 should happen at 09:15. It fires
 * when its minute comes round, which is what a cron expression means everywhere else.
 * Saying so in the settings summary is the price of supporting the mode at all.
 *
 * **A tick during a run is skipped, not queued.** The copy yields between files so
 * the API stays responsive, which is also what makes an overlapping tick possible.
 * A queued tick would immediately copy the whole library a second time.
 *
 * **The last-run instant is read from `archiveLastRunAt` rather than held in
 * memory**, so restarting the process does not re-run a job that already happened.
 * It is stamped *after* the attempt, so a process that died mid-run retries, while a
 * run that completed and failed does not get retried every sixty seconds against a
 * disk that is already unhappy. The user still has "run now" for that.
 *
 * **A refusal backs off; it does not retry every minute.** A full disk or an unplugged
 * drive is still full or unplugged a minute later, and each attempt walks the library
 * and wakes a sleeping disk. After a refusal from a scheduled tick the next attempt
 * waits `REFUSAL_BACKOFF_MS`, and the reason is written to `archiveLastResult` so the
 * Settings page shows why nothing happened. "Run now" ignores the backoff. The due
 * check comes first, so an archive that is not due never touches the destination.
 *
 * Nothing here runs while another library job is in progress: a migration copies
 * the library, and an import writes to it, and neither should be interleaved with
 * a run that is reading it.
 */

import { localDateKey, localParts, timeZoneOrLocal } from '../timezone.js';
import { isLibraryAvailable } from '../libraryPath.js';
import { getSettingsData } from '../telescopes.js';
import { isLibraryMigrating } from '../libraryMaintenance.js';
import { acquireLibraryLock, isLibraryBusy } from '../libraryBusy.js';
import { getArchiveConfig, setArchiveConfig } from './archiveConfig.js';
import type { ArchiveConfig, ArchiveScheduleMode } from './archiveConfig.js';
import { parseCron, cronMatches } from './archiveCron.js';
import type { ParsedCron } from './archiveCron.js';
import { ensureArchiveDestinationReady } from './archiveDestination.js';
import { isArchiveRunning } from './archiveCopy.js';
import { runArchivePipeline } from './archivePipeline.js';

export type ArchiveTickSkip =
  | 'disabled'
  | 'no-destination'
  | 'destination-unusable'
  | 'library-unavailable'
  | 'not-due'
  | 'library-busy'
  | 'already-running'
  | 'insufficient-space';

export interface ArchiveTickOutcome {
  ran: boolean;
  skippedBecause: ArchiveTickSkip | null;
}

/** The scheduling fields, so the due-ness rules can be tested without a database. */
export interface ArchiveSchedule {
  mode: ArchiveScheduleMode;
  /** Hour of day for `daily`. */
  hour: number;
  /** Minute past the hour for `daily`. */
  minute: number;
  /** Hours between runs for `interval`, measured from the last run. */
  intervalHours: number;
  /** The expression for `custom`. */
  cron: string;
}

let checkInterval: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60_000;

/** The observer's timezone, so a schedule means the hour the user sees. Falls
 *  back to the process zone when no site is configured, matching every other
 *  scheduled job. */
export function archiveScheduleTimeZone(): string {
  const configured = getSettingsData().timezone;
  return typeof configured === 'string' && configured.length > 0 ? configured : timeZoneOrLocal(null);
}

/** The schedule fields of a configuration. Kept next to `isArchiveDue` so the two
 *  cannot be read from different fields by accident. */
export function scheduleOf(config: ArchiveConfig): ArchiveSchedule {
  return {
    mode: config.scheduleMode,
    hour: config.scheduleHour,
    minute: config.scheduleMinute,
    intervalHours: config.scheduleIntervalHours,
    cron: config.scheduleCron,
  };
}

/**
 * Whether another library job is in progress.
 *
 * Exported so a manual "run now" uses the identical rule instead of restating it:
 * a manual run during a migration would read a library that is being copied.
 */
export function archiveBlockedByLibraryWork(): boolean {
  return isLibraryMigrating() || isLibraryBusy();
}

/** The instant of the last run, or null when it never ran or the stored value is
 *  unusable, which must not read as "just ran". */
function lastRunInstant(lastRunAt: string): Date | null {
  if (lastRunAt === '') return null;
  const parsed = new Date(lastRunAt);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** The local date of the last run, for the daily mode's once-a-day rule. */
function lastRunDateKey(lastRunAt: string, timeZone: string): string | null {
  const parsed = lastRunInstant(lastRunAt);
  return parsed === null ? null : localDateKey(parsed, timeZone);
}

/** The minute-resolution key of an instant in the schedule timezone, so two
 *  instants can be asked whether they fall in the same local minute. */
function localMinuteKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * Whether the archive is due under `schedule`.
 *
 * `lastRunAt` is the stored ISO instant of the last attempt, empty when it has
 * never run. `parsedCron` lets the tick hand in the expression it already parsed;
 * when it is absent the expression is parsed here.
 */
export function isArchiveDue(
  now: Date,
  schedule: ArchiveSchedule,
  lastRunAt: string,
  timeZone: string,
  parsedCron?: ParsedCron | null,
): boolean {
  switch (schedule.mode) {
    case 'daily': {
      const today = localDateKey(now, timeZone);
      if (lastRunDateKey(lastRunAt, timeZone) === today) return false;
      const p = localParts(now, timeZone);
      // Due at its minute, or at any minute after it on the same local day: the
      // process may have been asleep when the minute came round.
      if (p.hour !== schedule.hour) return p.hour > schedule.hour;
      return p.minute >= schedule.minute;
    }

    case 'interval': {
      const last = lastRunInstant(lastRunAt);
      // Never run, or the stamp is unusable: due now, so a freshly configured
      // schedule does not wait a whole interval before doing anything.
      if (last === null) return true;
      // Measured from the last run rather than aligned to a slot on the clock. A
      // slot would need catch-up rules of its own, and "every 6 hours" plainly means
      // six hours after the last one.
      return now.getTime() - last.getTime() >= schedule.intervalHours * 3_600_000;
    }

    case 'custom': {
      let cron = parsedCron ?? null;
      if (cron === null) {
        const parsed = parseCron(schedule.cron);
        // An expression that cannot be parsed never fires. The settings page refuses
        // to store one, so this is a database that was edited by hand.
        if (!parsed.ok) return false;
        cron = parsed.cron;
      }
      if (!cronMatches(cron, now, timeZone)) return false;
      // The expression names this minute. If the last run was in this same local
      // minute, the tick is asking a second time: a restart, or a clock that jumped
      // back. Firing again would start a second copy of the same batch.
      const last = lastRunInstant(lastRunAt);
      if (last !== null && localMinuteKey(last, timeZone) === localMinuteKey(now, timeZone)) return false;
      return true;
    }
  }
}

function skip(reason: ArchiveTickSkip): ArchiveTickOutcome {
  return { ran: false, skippedBecause: reason };
}

/** How long a scheduled tick waits after a refusal before it tries again. */
export const REFUSAL_BACKOFF_MS = 60 * 60_000;

/** Kept in memory: a restart tries once more, which is the behaviour anyone
 *  would want after fixing whatever the refusal was about. */
let backoff: { until: number; reason: ArchiveTickSkip; key: string } | null = null;

/** Test seam: forget any remembered refusal. */
export function resetArchiveBackoff(): void {
  backoff = null;
}

/** What identifies "the same archive", so a backoff earned by one destination does
 *  not hold back a different one the user has just configured. */
function destinationKey(config: ArchiveConfig): string {
  return config.locationType === 'network'
    ? `network:${config.archiveId}:${config.network.host}:${config.network.share}:${config.network.subpath}`
    : `local:${config.archiveId}:${config.path}`;
}

const REFUSAL_TEXT: Partial<Record<ArchiveTickSkip, string>> = {
  'no-destination': 'skipped: no archive destination is set',
  'destination-unusable': 'skipped: the archive disk is not connected or is not this archive',
  'library-unavailable': 'skipped: the library is not connected',
  'insufficient-space': 'skipped: not enough free space on the archive disk',
};

/** Remember a refusal and say so where the user can see it. */
function refuse(config: ArchiveConfig, now: Date, reason: ArchiveTickSkip): ArchiveTickOutcome {
  backoff = { until: now.getTime() + REFUSAL_BACKOFF_MS, reason, key: destinationKey(config) };
  const text = REFUSAL_TEXT[reason];
  if (text !== undefined && config.lastResult !== text) setArchiveConfig({ lastResult: text });
  return skip(reason);
}

/**
 * One scheduler decision.
 *
 * Takes `now` and the timezone explicitly so the whole policy is testable without
 * a timer or a clock on the wall; the interval below is the only caller that
 * omits them.
 */
export async function tickArchiveScheduler(
  now: Date = new Date(),
  timeZone: string = archiveScheduleTimeZone(),
): Promise<ArchiveTickOutcome> {
  const config = getArchiveConfig();
  // The master switch first: with the feature off, nothing below should run even if
  // the schedule itself is still switched on from a previous session.
  if (!config.enabled || !config.scheduleEnabled) return skip('disabled');

  // Due-ness is pure arithmetic on stored values, so it goes before anything that
  // touches the destination: an archive on a spun-down disk or a mounted share must
  // not be woken every minute just to learn that it is not due.
  const schedule = scheduleOf(config);
  const parsedCron = schedule.mode === 'custom' ? parseCron(schedule.cron) : null;
  if (!isArchiveDue(now, schedule, config.lastRunAt, timeZone, parsedCron?.ok ? parsedCron.cron : null)) {
    return skip('not-due');
  }

  if (isArchiveRunning()) return skip('already-running');
  if (archiveBlockedByLibraryWork()) return skip('library-busy');

  if (backoff !== null && backoff.key === destinationKey(config) && now.getTime() < backoff.until) {
    return skip(backoff.reason);
  }

  // A library on a drive that is not mounted selects nothing, and a run over zero
  // files would be stamped as a success and write off the day. The manual route
  // refuses for the same reason.
  if (!(await isLibraryAvailable())) return refuse(config, now, 'library-unavailable');

  // The destination is re-checked when a run is actually due, not just when it was
  // saved. A disk swapped since then must not be written to, a share that is no
  // longer mounted must not be written to either, and the marker is what says
  // whether this is still our archive.
  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) {
    return refuse(config, now, readiness.kind === 'unconfigured' ? 'no-destination' : 'destination-unusable');
  }

  // Held from the copy until removal and pruning are done, not just for the copy:
  // deleting local sub-frames or archive files while an import or a linked scan is
  // writing to the same library is exactly the overlap this lock exists to stop.
  const releaseLock = acquireLibraryLock('archive');
  if (releaseLock === null) return skip('library-busy');
  try {
    const result = await runArchivePipeline(config, now, 'scheduled');
    // A refusal is not an attempt. Leaving the run instant unstamped means the next
    // eligible tick tries again rather than writing off the day.
    if (!result.ran) {
      if (result.reason === 'already-running') return skip('already-running');
      // Reported distinctly so a full disk does not read as "that disk is not ours",
      // which would send the user looking for the wrong problem.
      return refuse(config, now, result.reason === 'insufficient-space' ? 'insufficient-space' : 'destination-unusable');
    }
    backoff = null;
    return { ran: true, skippedBecause: null };
  } finally {
    releaseLock();
  }
}

export function startArchiveScheduler(): void {
  stopArchiveScheduler();
  checkInterval = setInterval(() => {
    // A rejected tick is already handled inside; this catch exists so a bug in
    // the policy cannot take the process down from a timer callback.
    tickArchiveScheduler().catch(err =>
      console.error('[archive] scheduled tick failed:', err instanceof Error ? err.message : err),
    );
  }, TICK_MS);
  console.log('[archive] Scheduler started');
}

function stopArchiveScheduler(): void {
  if (checkInterval !== null) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
