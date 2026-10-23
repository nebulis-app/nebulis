/**
 * The `appSettings` columns behind the archive feature, and the guarded
 * migration that adds them to an existing database.
 *
 * This lives in its own module, with no imports beyond a type, for two reasons.
 *
 * **No import cycle.** `db.ts` calls `ensureArchiveColumns` during its own boot,
 * and `archiveConfig.ts` reads the settings table through `db.ts`. If the column
 * definitions lived in `archiveConfig.ts`, `db.ts` would import a module that
 * imports `db.ts`. `libraryMaintenance.ts` exists in the same shape for the same
 * reason.
 *
 * **Testable migration.** The other `appSettings` columns are migrated by inline
 * statements in `db.ts`, which run once at import and cannot be exercised.
 * `archiveMarker`-style tests need to run the migration against a database that
 * genuinely lacks the columns, so it is a function over a database handle here.
 * `db.ts` calls it at the point the inline statements would have been.
 *
 * Adding a column here is a two-place change: this list, and the
 * `CREATE TABLE appSettings` block in `db.ts`. The test asserts that every column
 * in this list is NOT NULL with a default, so no read can ever yield `undefined`.
 */

import type { Database } from 'better-sqlite3';
import { isRecord } from '../typeGuards.js';

export interface ArchiveSettingsColumn {
  name: string;
  /** The column definition as it appears after `ADD COLUMN`. */
  ddl: string;
}

/**
 * Every archive setting, with its default.
 *
 * The defaults are the safe ones, deliberately. `archiveScheduleEnabled` and
 * `archiveRemoveLocalAfter` are 0, so a fresh install archives nothing and
 * deletes nothing until a human turns it on, and `archiveRetentionDays` of 0
 * means "keep forever" rather than "prune immediately".
 */
export const ARCHIVE_SETTINGS_COLUMNS: ReadonlyArray<ArchiveSettingsColumn> = [
  /** The master switch for the whole feature. OFF by default, and off on an
   *  install that upgrades into this column, so nobody discovers archiving
   *  running because it defaulted on. */
  { name: 'archiveEnabled', ddl: 'archiveEnabled INTEGER NOT NULL DEFAULT 0' },
  /** Destination root. Empty means archiving is unconfigured. */
  { name: 'archivePath', ddl: "archivePath TEXT NOT NULL DEFAULT ''" },
  /** The id in the destination's `.nebulisarchive` marker. Empty means this
   *  install has not adopted an archive yet, and nothing may be written to a
   *  marker that does not match. See archiveMarker.ts. */
  { name: 'archiveId', ddl: "archiveId TEXT NOT NULL DEFAULT ''" },
  /** 'all' or 'selected'. Anything else reads back as 'all'. */
  { name: 'archiveScope', ddl: "archiveScope TEXT NOT NULL DEFAULT 'all'" },
  /** JSON array of object ids, only meaningful when scope is 'selected'. Text
   *  rather than a join table because it is a preference, not a relation: it is
   *  read and written whole, and nothing queries across it. Validated on read. */
  { name: 'archiveSelectedObjects', ddl: "archiveSelectedObjects TEXT NOT NULL DEFAULT '[]'" },
  /** Whether subframes are included in the copy. */
  { name: 'archiveIncludeSubframes', ddl: 'archiveIncludeSubframes INTEGER NOT NULL DEFAULT 0' },
  /** Skip copying anything captured less than this many days ago. 0 has no
   *  special meaning here (unlike retentionDays' "keep forever"): the filter is
   *  only consulted at all when archiveCopyMinAgeEnabled is on. */
  { name: 'archiveCopyMinAgeDays', ddl: 'archiveCopyMinAgeDays INTEGER NOT NULL DEFAULT 0' },
  /** Whether the age filter above is armed. OFF by default: a fresh install, and
   *  one upgrading into this column, copies everything as soon as it is selected,
   *  which is the behaviour this feature did not have before. No backfill is
   *  needed the way archiveRetentionEnabled needed one: there is no prior
   *  "already configured" period for an upgrading install to have set. */
  { name: 'archiveCopyMinAgeEnabled', ddl: 'archiveCopyMinAgeEnabled INTEGER NOT NULL DEFAULT 0' },
  /** OFF by default: a schedule writes to an external disk unattended. */
  { name: 'archiveScheduleEnabled', ddl: 'archiveScheduleEnabled INTEGER NOT NULL DEFAULT 0' },
  /** 'daily', 'interval' or 'custom'. Anything else reads back as 'daily'. */
  { name: 'archiveScheduleMode', ddl: "archiveScheduleMode TEXT NOT NULL DEFAULT 'daily'" },
  /** Minutes past the hour, 0-59, in the server's local time. Read by the 'daily'
   *  mode only: the interval mode is measured from the last run, so it has no minute
   *  of its own. */
  { name: 'archiveScheduleMinute', ddl: 'archiveScheduleMinute INTEGER NOT NULL DEFAULT 0' },
  /** Hours between runs for the 'interval' mode. */
  { name: 'archiveScheduleIntervalHours', ddl: 'archiveScheduleIntervalHours INTEGER NOT NULL DEFAULT 24' },
  /** A five-field cron expression for the 'custom' mode. Empty means unset. */
  { name: 'archiveScheduleCron', ddl: "archiveScheduleCron TEXT NOT NULL DEFAULT ''" },
  /** The hour the 'daily' mode fires at, 0-23 in the server's local time. Paired with
   *  `archiveScheduleMinute`, and read by `isArchiveDue` at the moment the tick runs;
   *  no next-run instant is stored anywhere, because a stored copy could only drift
   *  from the schedule it was computed from. */
  { name: 'archiveScheduleHour', ddl: 'archiveScheduleHour INTEGER NOT NULL DEFAULT 2' },
  /** Days after which the archive prunes itself. 0 means keep everything. */
  { name: 'archiveRetentionDays', ddl: 'archiveRetentionDays INTEGER NOT NULL DEFAULT 0' },
  /** Whether pruning is armed at all. See the backfill in `ensureArchiveColumns`:
   *  an install that already had a retention period keeps pruning. */
  { name: 'archiveRetentionEnabled', ddl: 'archiveRetentionEnabled INTEGER NOT NULL DEFAULT 0' },
  /** Prune only subframes, keeping the processed result. */
  { name: 'archiveRetentionSubframesOnly', ddl: 'archiveRetentionSubframesOnly INTEGER NOT NULL DEFAULT 0' },
  /** Destructive: remove subframes from the local library once their archived
   *  copy is verified. OFF by default, and requires explicit confirmation. */
  { name: 'archiveRemoveLocalAfter', ddl: 'archiveRemoveLocalAfter INTEGER NOT NULL DEFAULT 0' },
  { name: 'archiveLastRunAt', ddl: "archiveLastRunAt TEXT NOT NULL DEFAULT ''" },
  { name: 'archiveLastResult', ddl: "archiveLastResult TEXT NOT NULL DEFAULT ''" },
  /** 'local' or 'network'. A local destination is a path on a filesystem the
   *  operating system already mounted; a network destination is a share Nebulis
   *  connects to itself, described by the `archiveNetwork*` columns below. The two
   *  are mutually exclusive rather than merged: one source of truth per
   *  destination, so a stale path cannot be used after a credential change. */
  { name: 'archiveLocationType', ddl: "archiveLocationType TEXT NOT NULL DEFAULT 'local'" },
  /** Server name or IP for a network destination. */
  { name: 'archiveNetworkHost', ddl: "archiveNetworkHost TEXT NOT NULL DEFAULT ''" },
  { name: 'archiveNetworkShare', ddl: "archiveNetworkShare TEXT NOT NULL DEFAULT ''" },
  { name: 'archiveNetworkDomain', ddl: "archiveNetworkDomain TEXT NOT NULL DEFAULT ''" },
  /** Empty means a guest connection, which is what many NAS shares want. */
  { name: 'archiveNetworkUsername', ddl: "archiveNetworkUsername TEXT NOT NULL DEFAULT ''" },
  /** Sealed with secretBox, never returned by a route. Mirrors
   *  `libraryNetworkPasswordSealed` (server/lib/db.ts) so the two are recognisable
   *  as the same kind of thing. */
  { name: 'archiveNetworkPasswordSealed', ddl: "archiveNetworkPasswordSealed TEXT NOT NULL DEFAULT ''" },
  /** Folder inside the share. Empty means the share root, which has to be chosen
   *  deliberately rather than arriving as a default. */
  { name: 'archiveNetworkSubpath', ddl: "archiveNetworkSubpath TEXT NOT NULL DEFAULT ''" },
];

/**
 * Add any missing archive columns to `appSettings`.
 *
 * Guarded per column rather than as a group, so a database that already has some
 * of them (an interrupted upgrade, or a build that shipped a subset) converges
 * instead of throwing on the first duplicate.
 *
 * One column needs more than a default. `archiveRetentionEnabled` defaults to 0,
 * which is right for a fresh install, but an install that upgrades into it may
 * already have a retention period set: turning pruning off underneath it would be
 * a silent behaviour change. So the hour the column is created, it is backfilled
 * from the period that was already configured. A period of 0 stays off, because
 * that already meant "keep everything".
 */
export function ensureArchiveColumns(db: Database): void {
  const existing: unknown[] = db.prepare('PRAGMA table_info(appSettings)').all();
  const present = new Set(existing.map(c => (isRecord(c) ? String(c.name) : '')));
  const added = new Set<string>();
  for (const column of ARCHIVE_SETTINGS_COLUMNS) {
    if (present.has(column.name)) continue;
    db.prepare(`ALTER TABLE appSettings ADD COLUMN ${column.ddl}`).run();
    added.add(column.name);
  }

  if (added.has('archiveRetentionEnabled')) {
    db.prepare('UPDATE appSettings SET archiveRetentionEnabled = 1 WHERE archiveRetentionDays > 0').run();
  }
}
