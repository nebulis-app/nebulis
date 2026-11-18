/**
 * One archive run, start to finish.
 *
 * The scheduled tick and the "Run now" route used to assemble this differently:
 * the tick copied, then removed verified local subframes, then pruned, then stamped
 * `lastRunAt` and `lastResult`; the route only copied. A manual run therefore never
 * applied the user's removal or retention settings and left the Settings page
 * showing a stale "last run". Both callers now go through here, so a run means the
 * same thing however it started.
 *
 * The caller holds the library lock (`acquireLibraryLock('archive')`) for the whole
 * call. Removal and pruning delete files, and doing that while an import or a linked
 * scan writes to the same library is exactly the overlap the lock exists to stop.
 *
 * The outcome of the latest run is also kept in memory. A manual run answers 202
 * straight away and finishes in the background, so the status route needs somewhere
 * to read the final result, including a refusal such as a full disk that only shows
 * itself after selection.
 */

import { setArchiveConfig } from './archiveConfig.js';
import type { ArchiveConfig } from './archiveConfig.js';
import { runArchive } from './archiveCopy.js';
import type { ArchiveRunResult } from './archiveCopy.js';
import { removeVerifiedLocalSubframes } from './archiveLocalRemoval.js';
import { applyArchiveRetention, planArchiveRetention } from './archiveRetention.js';

export type ArchiveTrigger = 'scheduled' | 'manual';

export interface ArchivePipelineResult extends ArchiveRunResult {
  /** The one-line account stored in `archiveLastResult` and shown in Settings. */
  summary: string;
  localRemoved: number;
  retentionRemoved: number;
}

export interface ArchiveLastRun {
  trigger: ArchiveTrigger;
  finishedAt: string;
  result: ArchivePipelineResult;
}

let lastRun: ArchiveLastRun | null = null;

/** The most recent run finished by this process, or null when none has. */
export function getLastArchiveRun(): ArchiveLastRun | null {
  return lastRun;
}

let activeAbort: AbortController | null = null;

/**
 * Ask the run in progress to stop, whichever way it was started. Takes effect at the
 * next file boundary. False when no run is in progress, so a cancel that arrives after
 * the run ended is a no-op rather than an error the user has to interpret.
 */
export function cancelArchiveRun(): boolean {
  if (activeAbort === null) return false;
  activeAbort.abort();
  return true;
}

/** Cleared when a new run starts, so the status route never shows a previous
 *  run's result next to a run that is in progress. */
export function clearLastArchiveRun(): void {
  lastRun = null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Wording for a run that copied files, shared by the stored result and the tests. */
function summarise(result: ArchiveRunResult, localRemoved: number, localRemovalSkipped: boolean, retentionRemoved: number): string {
  const attempted = result.copied + result.skipped + result.failures.length;
  if (result.cancelled) return `cancelled: ${result.copied} archived, ${result.skipped} already present`;
  if (result.failures.length > 0) return `failed: ${result.failures.length} of ${attempted} files`;

  let text = `${result.copied} archived, ${result.skipped} already present`;
  if (localRemoved > 0) text += `; ${localRemoved} local subframes removed`;
  else if (localRemovalSkipped) text += '; local subframe removal was skipped';
  if (retentionRemoved > 0) text += `; ${retentionRemoved} pruned from the archive`;
  if (result.linkedSkipped > 0) {
    text += `; ${plural(result.linkedSkipped, 'linked file is', 'linked files are')} not included`;
  }
  return text;
}

/**
 * Copy, then the opt-in local removal, then the opt-in pruning, then stamp the run.
 *
 * `now` is the instant the caller decided against, so the recorded run instant
 * agrees with the schedule decision instead of drifting to the wall clock.
 *
 * A refusal (`ran: false`) writes nothing to the config: it is not an attempt, and
 * the scheduler decides separately how soon to try again. A cancelled run keeps
 * its copied files but skips removal and pruning, because deleting anything on the
 * strength of a run that did not finish is the one thing it must not do, and it does
 * not stamp `lastRunAt`, so the schedule still considers itself due.
 */
export async function runArchivePipeline(
  config: ArchiveConfig,
  now: Date,
  trigger: ArchiveTrigger,
): Promise<ArchivePipelineResult> {
  const controller = new AbortController();
  activeAbort = controller;
  let copy: ArchiveRunResult;
  try {
    copy = await runArchive(config, { signal: controller.signal });
  } finally {
    // A cancel that lands after the copy loop has nothing left to stop, and must not
    // be able to reach a later run through a stale handle.
    if (activeAbort === controller) activeAbort = null;
  }

  const finish = (result: ArchivePipelineResult): ArchivePipelineResult => {
    lastRun = { trigger, finishedAt: new Date().toISOString(), result };
    return result;
  };

  if (!copy.ran) {
    return finish({ ...copy, summary: '', localRemoved: 0, retentionRemoved: 0 });
  }

  // The disk went away mid-run. Files copied before that are safe, but nothing may be deleted or pruned on the
  // strength of a run that ended this way, and it is not an attempt that satisfies the schedule.
  if (copy.diskLost) {
    const summary = 'failed: the archive disk was disconnected during the run';
    setArchiveConfig({ lastResult: summary });
    return finish({ ...copy, summary, localRemoved: 0, retentionRemoved: 0 });
  }

  if (copy.cancelled) {
    const summary = summarise(copy, 0, false, 0);
    setArchiveConfig({ lastResult: summary });
    return finish({ ...copy, summary, localRemoved: 0, retentionRemoved: 0 });
  }

  // Opt-in, and deliberately after the copy rather than inside it: the engine that
  // writes to the archive never deletes from the library, so a failure here cannot
  // leave a run that has deleted something it did not finish backing up.
  let localRemoved = 0;
  let localRemovalSkipped = false;
  if (config.removeLocalAfter) {
    const removal = await removeVerifiedLocalSubframes(config);
    localRemoved = removal.removed;
    localRemovalSkipped = removal.removed === 0 && removal.failures.length > 0;
  }

  // The retention pass runs only with the switch on, so a schedule whose pruning is
  // off copies files without deleting any. It runs after the copy for the same
  // reason local removal does: the thing being pruned was just backed up.
  let retentionRemoved = 0;
  if (config.retentionEnabled) {
    const plan = await planArchiveRetention(config, now);
    if (plan.items.length > 0) {
      retentionRemoved = (await applyArchiveRetention(config, plan)).removed;
    }
  }

  const summary = summarise(copy, localRemoved, localRemovalSkipped, retentionRemoved);
  setArchiveConfig({ lastRunAt: now.toISOString(), lastResult: summary });
  return finish({ ...copy, summary, localRemoved, retentionRemoved });
}
