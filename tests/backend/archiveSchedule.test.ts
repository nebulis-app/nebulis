import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { setLibraryMigrating } from '../../server/lib/libraryMaintenance';
import { claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import {
  DEFAULT_ARCHIVE_CONFIG,
  setArchiveConfig,
  getArchiveConfig,
  type ArchiveConfig,
  type ArchiveScheduleMode,
} from '../../server/lib/archive/archiveConfig';
import { writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { readArchiveManifest, writeArchiveManifest } from '../../server/lib/archive/archiveManifest';
import { runArchive, isArchiveRunning } from '../../server/lib/archive/archiveCopy';
import {
  isArchiveDue,
  nextArchiveRun,
  tickArchiveScheduler,
  resetArchiveBackoff,
  REFUSAL_BACKOFF_MS,
  type ArchiveSchedule,
} from '../../server/lib/archive/archiveScheduler';
import { ensureArchiveDestinationReady } from '../../server/lib/archive/archiveDestination';
import { isLibraryAvailable } from '../../server/lib/libraryPath';
import { availableBytes } from '../../server/lib/archive/archiveSpace';

// Pass-through wrappers, so a test can count how often the destination is probed and
// can make the disk look full without filling one.
vi.mock('../../server/lib/archive/archiveDestination', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/lib/archive/archiveDestination')>();
  return { ...actual, ensureArchiveDestinationReady: vi.fn(actual.ensureArchiveDestinationReady) };
});
vi.mock('../../server/lib/libraryPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/lib/libraryPath')>();
  return { ...actual, isLibraryAvailable: vi.fn(actual.isLibraryAvailable) };
});
vi.mock('../../server/lib/archive/archiveSpace', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/lib/archive/archiveSpace')>();
  return { ...actual, availableBytes: vi.fn(actual.availableBytes) };
});

/**
 * The archive schedule.
 *
 * Three things are being protected.
 *
 * **The due test catches up rather than firing inside a window.**
 * `plannerNightlyPrefetch` already learned this the hard way: a `±1 minute`
 * window silently skipped the whole batch for the day if the process was asleep
 * or GC-paused across those two minutes. "Has it run since the target time today"
 * catches up whenever the process wakes, and the same shape is used here.
 *
 * **The interval mode measures from the last run, and never inside the same local
 * minute twice.** A cron expression names a minute, so it does not catch up: it
 * fires when its minute comes round, and a second tick in that same minute is a
 * restart or a clock jump rather than a second run.
 *
 * **A tick during a run is skipped, not queued.** The copy yields between files so
 * the API stays responsive, which is also what makes an overlapping tick possible.
 * A queued second run would copy the whole library again the moment the first
 * finished.
 *
 * The policy is exercised through `tickArchiveScheduler`, one decision per call, so
 * nothing here depends on a real 60-second timer or on the machine's clock.
 */

const created: string[] = [];
const seededObjectIds: string[] = [];
const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const M31_FOLDER = 'M 31';
const ARCHIVE_ID = 'archive-under-test';

/** 12:00 UTC is 05:00 in Los Angeles and 02:00 the next day in Kiritimati, which
 *  is enough to prove the timezone argument is honoured. */
const NOON_UTC = new Date('2026-03-10T12:00:00Z');

/** A schedule for the due tests, so each one says only what it is about. */
function schedule(
  mode: ArchiveScheduleMode,
  fields: Partial<Omit<ArchiveSchedule, 'mode'>> = {},
): ArchiveSchedule {
  return { mode, hour: 2, minute: 0, intervalHours: 24, cron: '', ...fields };
}

function scratchDest(prefix = 'nebulis-archive-test-sched-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

function seedLibrary(): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run('M31', M31_FOLDER, new Date().toISOString());
  seededObjectIds.push('M31');
  const abs = path.join(getLibraryDir(), M31_FOLDER, STACKED_JPG);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'stacked');
}

/** Configure the schedule with a matching marker already on the disk. */
function configure(dest: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  const config: ArchiveConfig = {
    ...getArchiveConfig(),
    path: dest,
    archiveId: ARCHIVE_ID,
    enabled: true,
    scheduleEnabled: true,
    scheduleMode: 'daily',
    scheduleHour: 2,
    scheduleMinute: 0,
    includeSubframes: true,
    ...overrides,
  };
  setArchiveConfig(config);
  return config;
}

beforeEach(() => {
  seededObjectIds.length = 0;
  setLibraryMigrating(false);
  releaseImportLock();
  resetArchiveBackoff();
  vi.mocked(ensureArchiveDestinationReady).mockClear();
});

afterEach(() => {
  setLibraryMigrating(false);
  releaseImportLock();
  // Leave the shared `appSettings` row as it was found. These tests set a
  // destination and a last-run stamp, and a file that runs later must not inherit
  // either: the config suite asserts what a fresh install reports.
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('isArchiveDue — at a time each day', () => {
  it('is not due before the scheduled time', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 14 }), '', 'UTC')).toBe(false);
  });

  it('is due at the scheduled time', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 12 }), '', 'UTC')).toBe(true);
  });

  it('is due after the scheduled time, so a slept-through window still runs', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 3 }), '', 'UTC')).toBe(true);
  });

  it('is not due at all in the minute before the scheduled minute', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 12, minute: 1 }), '', 'UTC')).toBe(false);
  });

  it('is due in the scheduled minute', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 12, minute: 0 }), '', 'UTC')).toBe(true);
  });

  it('is not due again once it has run today', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 3 }), '2026-03-10T03:00:00Z', 'UTC')).toBe(false);
  });

  it('is due again the following day', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 3 }), '2026-03-09T03:00:00Z', 'UTC')).toBe(true);
  });

  it('treats a time of 00:00 as "any time today"', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 0, minute: 0 }), '', 'UTC')).toBe(true);
  });

  it('uses the supplied timezone rather than the machine clock', () => {
    // The same instant is due under one zone and not the other, which is the
    // whole reason the zone is a parameter.
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 8 }), '', 'UTC')).toBe(true);
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 8 }), '', 'America/Los_Angeles')).toBe(false);
  });

  it('treats an unusable last-run stamp as never having run', () => {
    expect(isArchiveDue(NOON_UTC, schedule('daily', { hour: 3 }), 'not a date', 'UTC')).toBe(true);
  });
});

describe('isArchiveDue — every N hours', () => {
  it('is due immediately when it has never run', () => {
    expect(isArchiveDue(NOON_UTC, schedule('interval', { intervalHours: 6 }), '', 'UTC')).toBe(true);
  });

  it('is not due before the interval has elapsed', () => {
    // Five hours after a six-hour interval.
    expect(
      isArchiveDue(NOON_UTC, schedule('interval', { intervalHours: 6 }), '2026-03-10T07:00:00Z', 'UTC'),
    ).toBe(false);
  });

  it('is due once the interval has elapsed', () => {
    expect(
      isArchiveDue(NOON_UTC, schedule('interval', { intervalHours: 6 }), '2026-03-10T06:00:00Z', 'UTC'),
    ).toBe(true);
  });

  it('is due again after an interval that spans midnight', () => {
    expect(
      isArchiveDue(NOON_UTC, schedule('interval', { intervalHours: 24 }), '2026-03-09T12:00:00Z', 'UTC'),
    ).toBe(true);
  });

  it('ignores the time of day, which is what makes it an interval', () => {
    // Two runs inside one local day is the point of this mode: the daily rule would
    // say no, and this must not.
    const morning = new Date('2026-03-10T08:00:00Z');
    expect(isArchiveDue(morning, schedule('interval', { intervalHours: 4 }), '2026-03-10T03:00:00Z', 'UTC')).toBe(true);
  });
});

describe('isArchiveDue — a custom expression', () => {
  it('is due when the expression names this minute', () => {
    expect(isArchiveDue(NOON_UTC, schedule('custom', { cron: '0 12 * * *' }), '', 'UTC')).toBe(true);
  });

  it('is not due in another minute', () => {
    expect(isArchiveDue(NOON_UTC, schedule('custom', { cron: '30 12 * * *' }), '', 'UTC')).toBe(false);
  });

  it('does not catch up the way the daily mode does', () => {
    // The expression names 03:00 and the clock says 12:00. A cron expression is a
    // set of minutes, not a deadline, so this is not a missed run to make up.
    expect(isArchiveDue(NOON_UTC, schedule('custom', { cron: '0 3 * * *' }), '', 'UTC')).toBe(false);
  });

  it('is not due twice in the same local minute', () => {
    expect(
      isArchiveDue(NOON_UTC, schedule('custom', { cron: '0 12 * * *' }), '2026-03-10T12:00:30Z', 'UTC'),
    ).toBe(false);
  });

  it('is due again in the next minute the expression names', () => {
    // Every five minutes, last run at 12:00, so 12:05 is the next one.
    const later = new Date('2026-03-10T12:05:00Z');
    expect(isArchiveDue(later, schedule('custom', { cron: '*/5 * * * *' }), '2026-03-10T12:00:00Z', 'UTC')).toBe(true);
  });

  it('never fires on an expression it cannot parse', () => {
    // The settings page refuses to store one, so this is a hand-edited database.
    // Doing nothing is the only safe reading.
    expect(isArchiveDue(NOON_UTC, schedule('custom', { cron: '@daily' }), '', 'UTC')).toBe(false);
    expect(isArchiveDue(NOON_UTC, schedule('custom', { cron: '' }), '', 'UTC')).toBe(false);
  });

  it('reads the expression in the schedule timezone', () => {
    // 12:00 UTC is 05:00 in Los Angeles on this date (daylight time began on the
    // 8th), so an expression naming 05:00 matches there and one naming 12:00 does not.
    expect(
      isArchiveDue(NOON_UTC, schedule('custom', { cron: '0 5 * * *' }), '', 'America/Los_Angeles'),
    ).toBe(true);
    expect(
      isArchiveDue(NOON_UTC, schedule('custom', { cron: '0 12 * * *' }), '', 'America/Los_Angeles'),
    ).toBe(false);
  });
});

describe('tickArchiveScheduler — when it declines', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
    writeArchiveMarker(dest, ARCHIVE_ID);
    seedLibrary();
  });

  it('declines when the schedule is switched off', async () => {
    configure(dest, { scheduleEnabled: false, scheduleHour: 0 });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedBecause).toBe('disabled');
  });

  it('declines when the whole feature is switched off', async () => {
    // The schedule is still on from an earlier session, and the master switch is
    // off. Nothing may run: that is the promise the switch makes.
    configure(dest, { enabled: false, scheduleHour: 0 });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedBecause).toBe('disabled');
  });

  it('declines, without stamping a run, when the library is not connected', async () => {
    configure(dest, { scheduleHour: 0 });
    vi.mocked(isLibraryAvailable).mockResolvedValueOnce(false);
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedBecause).toBe('library-unavailable');
    expect(vi.mocked(ensureArchiveDestinationReady)).not.toHaveBeenCalled();
  });

  it('declines when no destination is configured', async () => {
    configure('', { scheduleHour: 0 });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.skippedBecause).toBe('no-destination');
  });

  it('declines when the destination holds no marker', async () => {
    const empty = scratchDest();
    configure(empty, { scheduleHour: 0 });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.skippedBecause).toBe('destination-unusable');
  });

  it('declines when the disk belongs to another archive', async () => {
    const foreign = scratchDest();
    writeArchiveMarker(foreign, 'someone-elses');
    configure(foreign, { scheduleHour: 0 });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.skippedBecause).toBe('destination-unusable');
  });

  it('declines before the scheduled hour', async () => {
    configure(dest, { scheduleHour: 14 });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.skippedBecause).toBe('not-due');
  });

  it('declines while a library migration is in progress', async () => {
    configure(dest, { scheduleHour: 0 });
    setLibraryMigrating(true);
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.skippedBecause).toBe('library-busy');
  });

  it('declines while an import holds the library lock', async () => {
    configure(dest, { scheduleHour: 0 });
    claimImportLock();
    try {
      const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
      expect(outcome.skippedBecause).toBe('library-busy');
    } finally {
      releaseImportLock();
    }
  });

  it('skips a tick that lands during a run instead of queueing it', async () => {
    configure(dest, { scheduleHour: 0 });

    // Started without awaiting. An async function body runs synchronously up to
    // its first await, so the in-progress guard is set before the tick is
    // evaluated. Without that, this test would pass for the wrong reason.
    const inFlight = runArchive(getArchiveConfig());
    expect(isArchiveRunning()).toBe(true);

    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedBecause).toBe('already-running');

    await inFlight;
  });
});

describe('tickArchiveScheduler — when it runs', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
    writeArchiveMarker(dest, ARCHIVE_ID);
    seedLibrary();
    configure(dest, { scheduleHour: 2 });
  });

  it('archives when due, and records the outcome', async () => {
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.ran).toBe(true);
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, STACKED_JPG), 'utf8')).toBe('stacked');

    const config = getArchiveConfig();
    expect(config.lastRunAt).not.toBe('');
    expect(config.lastResult).toContain('archived');
  });

  it('stamps the run date, so a later tick the same day declines', async () => {
    await tickArchiveScheduler(NOON_UTC, 'UTC');
    const second = await tickArchiveScheduler(new Date('2026-03-10T13:00:00Z'), 'UTC');
    expect(second.skippedBecause).toBe('not-due');
  });

  it('runs again the following day', async () => {
    await tickArchiveScheduler(NOON_UTC, 'UTC');
    const next = await tickArchiveScheduler(new Date('2026-03-11T12:00:00Z'), 'UTC');
    expect(next.ran).toBe(true);
  });

  it('records a failed run rather than reporting a clean archive', async () => {
    // A directory sitting where the archived file belongs makes the final rename
    // fail, which is the closest deterministic stand-in for a write error. The
    // run must surface it instead of reporting success, because the next step
    // offers to delete local files on the strength of this result.
    const blocked = path.join(dest, M31_FOLDER, STACKED_JPG);
    fs.mkdirSync(blocked, { recursive: true });

    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.ran).toBe(true);
    expect(getArchiveConfig().lastResult).toContain('failed');
  });

  it('runs on an interval rather than at a time of day', async () => {
    configure(dest, { scheduleMode: 'interval', scheduleIntervalHours: 6 });
    const first = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(first.ran).toBe(true);

    // Four hours later, still inside the interval.
    const early = await tickArchiveScheduler(new Date('2026-03-10T16:00:00Z'), 'UTC');
    expect(early.skippedBecause).toBe('not-due');

    // Seven hours after the recorded run, which is past the six-hour interval.
    const due = await tickArchiveScheduler(new Date('2026-03-10T19:00:00Z'), 'UTC');
    expect(due.ran).toBe(true);
  });

  it('runs on a matching cron minute', async () => {
    configure(dest, { scheduleMode: 'custom', scheduleCron: '0 12 * * *' });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.ran).toBe(true);
  });

  it('does not run on a cron minute that does not match', async () => {
    configure(dest, { scheduleMode: 'custom', scheduleCron: '30 12 * * *' });
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome.skippedBecause).toBe('not-due');
  });
});

/**
 * The retention pass at the end of a run.
 *
 * Retention ages an archived object from the last run that archived it, so an object
 * still in scope is touched again on every run and never ages. Pruning therefore
 * happens to objects that left the archive's scope, and it may only remove an
 * archived file that a local file duplicates. An object deleted from the library
 * leaves the archive holding the only copy, and that is never pruned.
 */
describe('tickArchiveScheduler — retention after a run', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
    writeArchiveMarker(dest, ARCHIVE_ID);
    seedLibrary();
    configure(dest, { scheduleHour: 2 });
  });

  /** Age the archive's record of the object, optionally taking the object out of the library. */
  async function archiveThenAge(options: { deleteLocally: boolean }): Promise<string> {
    await tickArchiveScheduler(NOON_UTC, 'UTC');
    const archived = path.join(dest, M31_FOLDER, STACKED_JPG);
    expect(fs.existsSync(archived)).toBe(true);

    if (options.deleteLocally) {
      db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
      fs.rmSync(path.join(getLibraryDir(), M31_FOLDER), { recursive: true, force: true });
    }

    const manifest = readArchiveManifest(dest);
    writeArchiveManifest(dest, {
      ...manifest,
      objects: Object.fromEntries(
        Object.entries(manifest.objects).map(([folder, entry]) => [
          folder,
          { ...entry, lastArchivedAt: '2026-03-01T00:00:00Z' },
        ]),
      ),
    });
    return archived;
  }

  /** Out of scope, so the next run does not refresh the object's age. */
  const OUT_OF_SCOPE = { scope: 'selected', selectedObjects: [] } satisfies Partial<ArchiveConfig>;

  it('prunes an aged archive copy that a local file duplicates when retention is on', async () => {
    const archived = await archiveThenAge({ deleteLocally: false });
    configure(dest, { scheduleHour: 2, retentionEnabled: true, retentionDays: 7, ...OUT_OF_SCOPE });

    const outcome = await tickArchiveScheduler(new Date('2026-03-11T12:00:00Z'), 'UTC');
    expect(outcome.ran).toBe(true);
    expect(fs.existsSync(archived)).toBe(false);
    expect(fs.existsSync(path.join(getLibraryDir(), M31_FOLDER, STACKED_JPG))).toBe(true);
    expect(getArchiveConfig().lastResult).toContain('pruned');
  });

  it('never prunes the only copy of a file whose object left the library', async () => {
    const archived = await archiveThenAge({ deleteLocally: true });
    configure(dest, { scheduleHour: 2, retentionEnabled: true, retentionDays: 7, ...OUT_OF_SCOPE });

    const outcome = await tickArchiveScheduler(new Date('2026-03-11T12:00:00Z'), 'UTC');
    expect(outcome.ran).toBe(true);
    expect(fs.existsSync(archived)).toBe(true);
    expect(getArchiveConfig().lastResult).not.toContain('pruned');
  });

  it('leaves an aged archive copy alone when retention is off', async () => {
    const archived = await archiveThenAge({ deleteLocally: false });
    configure(dest, { scheduleHour: 2, retentionEnabled: false, retentionDays: 7, ...OUT_OF_SCOPE });

    const outcome = await tickArchiveScheduler(new Date('2026-03-11T12:00:00Z'), 'UTC');
    expect(outcome.ran).toBe(true);
    expect(fs.existsSync(archived)).toBe(true);
    expect(getArchiveConfig().lastResult).not.toContain('pruned');
  });
});

describe('tickArchiveScheduler — what it costs and how it backs off', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
    writeArchiveMarker(dest, ARCHIVE_ID);
    seedLibrary();
  });

  afterEach(() => {
    vi.mocked(availableBytes).mockReset();
  });

  it('does not probe the destination on a tick that is not due', async () => {
    configure(dest, { scheduleHour: 14 });
    for (let minute = 0; minute < 5; minute++) {
      const outcome = await tickArchiveScheduler(new Date(NOON_UTC.getTime() + minute * 60_000), 'UTC');
      expect(outcome.skippedBecause).toBe('not-due');
    }
    expect(ensureArchiveDestinationReady).not.toHaveBeenCalled();
  });

  it('tries an unusable destination once per backoff window, and says why', async () => {
    const empty = scratchDest(); // no marker: not our archive
    configure(empty, { scheduleHour: 0 });

    const first = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(first.skippedBecause).toBe('destination-unusable');
    expect(ensureArchiveDestinationReady).toHaveBeenCalledTimes(1);
    expect(getArchiveConfig().lastResult).toContain('skipped');

    const during = await tickArchiveScheduler(new Date(NOON_UTC.getTime() + 60_000), 'UTC');
    expect(during.skippedBecause).toBe('destination-unusable');
    expect(ensureArchiveDestinationReady).toHaveBeenCalledTimes(1);

    await tickArchiveScheduler(new Date(NOON_UTC.getTime() + REFUSAL_BACKOFF_MS + 1), 'UTC');
    expect(ensureArchiveDestinationReady).toHaveBeenCalledTimes(2);
  });

  it('attempts a full disk once per backoff window instead of every minute', async () => {
    configure(dest, { scheduleHour: 0 });
    vi.mocked(availableBytes).mockResolvedValue(0);

    const first = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(first).toEqual({ ran: false, skippedBecause: 'insufficient-space' });
    expect(getArchiveConfig().lastResult).toContain('not enough free space');
    // A refusal is not an attempt: the run instant stays unstamped.
    expect(getArchiveConfig().lastRunAt).toBe('');
    expect(vi.mocked(availableBytes)).toHaveBeenCalledTimes(1);

    for (let minute = 1; minute <= 5; minute++) {
      const outcome = await tickArchiveScheduler(new Date(NOON_UTC.getTime() + minute * 60_000), 'UTC');
      expect(outcome.skippedBecause).toBe('insufficient-space');
    }
    expect(vi.mocked(availableBytes)).toHaveBeenCalledTimes(1);
  });

  it('runs once the backoff has passed and the disk has room again', async () => {
    configure(dest, { scheduleHour: 0 });
    vi.mocked(availableBytes).mockResolvedValueOnce(0);
    await tickArchiveScheduler(NOON_UTC, 'UTC');

    const later = await tickArchiveScheduler(new Date(NOON_UTC.getTime() + REFUSAL_BACKOFF_MS + 1), 'UTC');
    expect(later.ran).toBe(true);
    expect(getArchiveConfig().lastResult).toContain('archived');
  });

  it('does not let one destination\'s backoff hold back another', async () => {
    const empty = scratchDest();
    configure(empty, { scheduleHour: 0 });
    await tickArchiveScheduler(NOON_UTC, 'UTC');

    configure(dest, { scheduleHour: 0 });
    const outcome = await tickArchiveScheduler(new Date(NOON_UTC.getTime() + 60_000), 'UTC');
    expect(outcome.ran).toBe(true);
  });
});

describe('nextArchiveRun', () => {
  const PARIS = 'Europe/Paris';
  const sched = (over: Partial<ArchiveSchedule>): ArchiveSchedule => ({
    mode: 'daily', hour: 3, minute: 0, intervalHours: 24, cron: '', ...over,
  });
  const at = (iso: string) => new Date(iso);

  it('daily: today at the time when not run yet, tomorrow once it has run, now when the time has passed', () => {
    const s = sched({ hour: 3, minute: 0 });
    // 10:00 in Paris (CET, UTC+1), already run at 03:00 today: tomorrow 03:00 Paris = 02:00 UTC.
    expect(nextArchiveRun(at('2026-11-25T09:00:00Z'), s, '2026-11-25T02:00:00Z', PARIS)?.toISOString()).toBe('2026-11-26T02:00:00.000Z');
    // 01:00 in Paris, last run yesterday: today 03:00.
    expect(nextArchiveRun(at('2026-11-25T00:00:00Z'), s, '2026-11-24T02:00:00Z', PARIS)?.toISOString()).toBe('2026-11-25T02:00:00.000Z');
    // 10:00 in Paris, not run today: due now, on the next tick.
    expect(nextArchiveRun(at('2026-11-25T09:00:30Z'), s, '2026-11-24T02:00:00Z', PARIS)?.toISOString()).toBe('2026-11-25T09:00:00.000Z');
  });

  it('interval: the last run plus the interval, or now when overdue or never run', () => {
    const s = sched({ mode: 'interval', intervalHours: 6 });
    expect(nextArchiveRun(at('2026-11-25T10:00:00Z'), s, '2026-11-25T08:00:00Z', 'UTC')?.toISOString()).toBe('2026-11-25T14:00:00.000Z');
    expect(nextArchiveRun(at('2026-11-25T20:00:00Z'), s, '2026-11-25T08:00:00Z', 'UTC')?.toISOString()).toBe('2026-11-25T20:00:00.000Z');
    expect(nextArchiveRun(at('2026-11-25T20:00:00Z'), s, '', 'UTC')?.toISOString()).toBe('2026-11-25T20:00:00.000Z');
  });

  it('custom: the next matching minute in the schedule time zone', () => {
    // 18:00 Paris is 17:00 UTC in November: the case that ran an hour late on a UTC server.
    const six = sched({ mode: 'custom', cron: '0 18 * * *' });
    expect(nextArchiveRun(at('2026-11-25T16:50:00Z'), six, '', PARIS)?.toISOString()).toBe('2026-11-25T17:00:00.000Z');
    expect(nextArchiveRun(at('2026-11-25T16:50:00Z'), six, '', 'UTC')?.toISOString()).toBe('2026-11-25T18:00:00.000Z');
    // Already run in that minute: the next day.
    expect(nextArchiveRun(at('2026-11-25T17:00:20Z'), six, '2026-11-25T17:00:05Z', PARIS)?.toISOString()).toBe('2026-11-26T17:00:00.000Z');
    // Mondays at 02:30 Paris, asked on a Wednesday: the next Monday.
    const monday = sched({ mode: 'custom', cron: '30 2 * * 1' });
    expect(nextArchiveRun(at('2026-11-25T12:00:00Z'), monday, '', PARIS)?.toISOString()).toBe('2026-11-30T01:30:00.000Z');
    // Several minutes an hour.
    const quarter = sched({ mode: 'custom', cron: '*/15 * * * *' });
    expect(nextArchiveRun(at('2026-11-25T12:07:00Z'), quarter, '', 'UTC')?.toISOString()).toBe('2026-11-25T12:15:00.000Z');
    expect(nextArchiveRun(at('2026-11-25T12:00:00Z'), sched({ mode: 'custom', cron: 'not a cron' }), '', 'UTC')).toBeNull();
  });

  it('agrees with isArchiveDue: the minute it names is due, and the minute before is not', () => {
    const cases: Array<[ArchiveSchedule, string, string, string]> = [
      [sched({ hour: 3, minute: 0 }), '2026-11-25T00:00:00Z', '2026-11-24T02:00:00Z', PARIS],
      [sched({ mode: 'custom', cron: '0 18 * * *' }), '2026-11-25T16:50:00Z', '', PARIS],
      [sched({ mode: 'custom', cron: '30 2 * * 1' }), '2026-11-25T12:00:00Z', '', PARIS],
      // Across the spring DST change in Paris (28 March 2027).
      [sched({ mode: 'custom', cron: '30 3 * * *' }), '2027-03-27T12:00:00Z', '', PARIS],
    ];
    for (const [s, now, last, tz] of cases) {
      const next = nextArchiveRun(at(now), s, last, tz)!;
      expect(isArchiveDue(next, s, last, tz), `${s.mode} ${s.cron} due at ${next.toISOString()}`).toBe(true);
      expect(isArchiveDue(new Date(next.getTime() - 60_000), s, last, tz), `${s.mode} ${s.cron} not due before`).toBe(false);
    }
  });
});
