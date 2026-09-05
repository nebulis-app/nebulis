/**
 * Pre-upgrade database snapshots.
 *
 * Before the schema migrations in db.ts run, if the build version changed since
 * the last boot, this takes a consistent copy of nebulis.db into
 * {DATA_DIR}/backups/. It exists so a user who upgrades and then needs to move
 * back to an older release has a clean database to restore, instead of one that
 * a newer build's one-way backfills have already rewritten (objectId rekeying,
 * telescope attribution, catalog backfills, and so on).
 *
 * WHY IT LIVES HERE, CALLED FROM db.ts:
 *   The snapshot must be taken before any `CREATE TABLE` / `ALTER TABLE`, so it
 *   is a faithful copy of the old schema + data. db.ts runs its migrations
 *   inline at import time, so the only safe hook is inside that same module,
 *   right after the connection opens. This module therefore must NOT import
 *   db.ts, or anything that does (notably systemLog.ts) — it would deadlock the
 *   module graph. The structured outcome is returned to db.ts, re-exported, and
 *   server/index.ts writes it to the admin system log once logging is up.
 *
 * SNAPSHOT MECHANISM:
 *   `VACUUM INTO` on the live connection. It produces a single-file logical
 *   copy that already accounts for WAL contents and compacts free pages, so a
 *   plain `fs.copyFile` (which can miss committed pages sitting in the -wal
 *   file) is never used. The copy is written to a temp name and renamed into
 *   place so a crash mid-copy cannot leave a half-written .db in the listing.
 *
 * RETENTION:
 *   The newest MAX_RETAINED of each trigger kind ('upgrade' / 'manual') are
 *   kept; older ones are deleted. Keeping the two kinds in separate pools means
 *   a burst of manual backups can never evict the pre-upgrade snapshot, which
 *   is the valuable one. To keep a backup permanently, download it.
 *
 * KNOWN GAP:
 *   Downgrading runs the OLD build, which has none of this code and never
 *   touches .last-version. So a downgrade does not snapshot, and a later
 *   re-upgrade to the same version sees an unchanged marker and skips. The
 *   common path (upgrade to a newer build than the one that wrote the marker)
 *   is covered; the downgrade/re-upgrade dance is not. Restoring a downloaded
 *   snapshot is the answer there.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.js';

/** The slice of a better-sqlite3 connection this module touches. Declared
 *  structurally so nothing here has to import db.ts (it runs during that
 *  module's own initialisation) and so a test can pass a bare fake. */
export interface DbLike {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const VERSION_MARKER_PATH = path.join(DATA_DIR, '.last-version');
const LAST_ATTEMPT_PATH = path.join(BACKUPS_DIR, '.last-attempt.json');
const RESTORE_DOC_PATH = path.join(BACKUPS_DIR, 'RESTORE.txt');

/** Kept per trigger kind, not in total. See module header. */
export const MAX_RETAINED = 3;

export type BackupKind = 'upgrade' | 'manual';

// nebulis-db-<compact-utc-timestamp>-v<version>-<kind>.db
// e.g. nebulis-db-20260903T140512.481Z-v2.0.0-upgrade.db
// Timestamp leads so a plain lexical sort of the filenames is also chronological
// and is millisecond-resolution so two snapshots can't collide in practice.
// The version group is greedy but the trailing `-(upgrade|manual).db` anchors
// it, so a version containing a hyphen (e.g. "2.0.0-beta.1") still parses.
const BACKUP_NAME_RE = /^nebulis-db-(\d{8}T\d{6}\.\d{3}Z)-v(.+)-(upgrade|manual)\.db$/;

export interface DatabaseBackupInfo {
  name: string;
  path: string;
  kind: BackupKind;
  /** Build version this snapshot was taken under, or null if unparseable. */
  version: string | null;
  createdAt: number; // Unix ms, from file mtime
  sizeBytes: number;
}

export interface LastBackupAttempt {
  at: number;
  fromVersion: string | null;
  toVersion: string;
  status: 'created' | 'failed';
  error?: string;
  backupName?: string;
}

export type StartupBackupOutcome =
  | { status: 'skipped'; reason: string }
  | {
      status: 'created';
      backup: DatabaseBackupInfo;
      previousVersion: string | null;
      pruned: number;
    }
  | { status: 'failed'; error: string; previousVersion: string | null };

// ─── Version marker ─────────────────────────────────────────────────────────

function readLastVersion(): string | null {
  try {
    const raw = fs.readFileSync(VERSION_MARKER_PATH, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function writeLastVersion(version: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VERSION_MARKER_PATH, `${version}\n`, 'utf8');
}

// ─── Filenames ──────────────────────────────────────────────────────────────

/** Compact UTC timestamp, e.g. 20260903T140512.481Z. Filesystem-safe (the only
 *  punctuation is a dot) and millisecond-resolution so names don't collide. */
function compactTimestamp(d = new Date()): string {
  return d.toISOString().replace(/-/g, '').replace(/:/g, '');
}

/** Replace anything a filename should not carry. Versions are normally
 *  `[0-9.]` plus an optional `-beta.N`, all already safe, but a hand-edited
 *  package.json could hold anything. */
function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

function buildBackupName(version: string, kind: BackupKind, when = new Date()): string {
  return `nebulis-db-${compactTimestamp(when)}-v${safeVersion(version)}-${kind}.db`;
}

/** Parse a backup filename. Returns null for anything that is not one of ours,
 *  which is also the traversal guard for the download / delete routes. */
export function parseBackupName(name: string): { version: string; kind: BackupKind } | null {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return null;
  return { version: m[2], kind: m[3] as BackupKind };
}

// ─── Listing / pruning ──────────────────────────────────────────────────────

/** Every valid snapshot in BACKUPS_DIR, newest first. */
export function listDatabaseBackups(): DatabaseBackupInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(BACKUPS_DIR);
  } catch {
    return [];
  }
  const out: DatabaseBackupInfo[] = [];
  for (const name of names) {
    const parsed = parseBackupName(name);
    if (!parsed) continue;
    const full = path.join(BACKUPS_DIR, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      name,
      path: full,
      kind: parsed.kind,
      version: parsed.version,
      createdAt: stat.mtimeMs,
      sizeBytes: stat.size,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Look one up by exact basename, or null. Used by the download / delete
 *  routes so a caller can never reach outside BACKUPS_DIR. */
export function findDatabaseBackup(name: string): DatabaseBackupInfo | null {
  if (!parseBackupName(name)) return null;
  return listDatabaseBackups().find(b => b.name === name) ?? null;
}

/** Delete all but the newest `keep` of each trigger kind. Returns how many
 *  files were removed. */
export function pruneDatabaseBackups(keep = MAX_RETAINED): number {
  const byKind: Record<BackupKind, DatabaseBackupInfo[]> = { upgrade: [], manual: [] };
  for (const b of listDatabaseBackups()) byKind[b.kind].push(b);

  let removed = 0;
  for (const kind of Object.keys(byKind) as BackupKind[]) {
    const stale = byKind[kind].slice(keep); // already newest-first
    for (const b of stale) {
      try {
        fs.unlinkSync(b.path);
        removed++;
      } catch (err) {
        console.warn(`[dbBackup] could not prune ${b.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return removed;
}

export function deleteDatabaseBackup(name: string): boolean {
  const found = findDatabaseBackup(name);
  if (!found) return false;
  try {
    fs.unlinkSync(found.path);
    return true;
  } catch {
    return false;
  }
}

// ─── Taking a snapshot ──────────────────────────────────────────────────────

/** Take a snapshot now. Does NOT prune and does NOT touch the version marker —
 *  callers decide. Throws on any I/O failure. */
export function backupDatabaseNow(
  db: DbLike,
  opts: { version: string; kind: BackupKind },
): DatabaseBackupInfo {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  writeRestoreDoc();

  // VACUUM INTO refuses to overwrite. A same-millisecond collision is
  // effectively impossible, but step the timestamp forward rather than recurse
  // if it ever happens.
  let name = buildBackupName(opts.version, opts.kind);
  for (let bump = 1; fs.existsSync(path.join(BACKUPS_DIR, name)) && bump < 1000; bump++) {
    name = buildBackupName(opts.version, opts.kind, new Date(Date.now() + bump));
  }
  const finalPath = path.join(BACKUPS_DIR, name);

  const tmpPath = path.join(BACKUPS_DIR, `.tmp-${process.pid}-${Date.now()}.db`);
  try {
    // Path is server-controlled (DATA_DIR + generated name); double any quote
    // anyway since VACUUM INTO takes a string literal, not a bound parameter.
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }

  const stat = fs.statSync(finalPath);
  return {
    name,
    path: finalPath,
    kind: opts.kind,
    version: opts.version,
    createdAt: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

// ─── Startup hook ───────────────────────────────────────────────────────────

/** True once the schema exists, i.e. this is not a just-created empty file. */
function databaseHasSchema(db: DbLike): boolean {
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function recordAttempt(attempt: LastBackupAttempt): void {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.writeFileSync(LAST_ATTEMPT_PATH, JSON.stringify(attempt, null, 2), 'utf8');
  } catch {
    /* best effort — the system log entry is the real record */
  }
}

export function readLastAttempt(): LastBackupAttempt | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LAST_ATTEMPT_PATH, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && 'status' in raw) return raw as LastBackupAttempt;
    return null;
  } catch {
    return null;
  }
}

/**
 * Called from db.ts right after the connection opens and before any migration.
 *
 * Snapshots the database when the running build version differs from the one
 * recorded at the last boot. On a genuinely fresh install (no schema yet) it
 * just records the version and skips. Never throws.
 */
export function maybeBackupBeforeMigrations(
  db: DbLike,
  current: { version: string; known: boolean },
): StartupBackupOutcome {
  // package.json unreadable → version is the "0.0.0" placeholder. Acting on it
  // would take a bogus snapshot and, worse, write "0.0.0" into the marker,
  // masking the real version change on the next clean boot. Same call the
  // updater's minUpgradableFrom gate makes.
  if (!current.known) {
    return { status: 'skipped', reason: 'running version is unknown (package.json unreadable)' };
  }

  const last = readLastVersion();

  if (last === null && !databaseHasSchema(db)) {
    // Fresh install. Nothing worth snapshotting; just start tracking.
    writeLastVersion(current.version);
    return { status: 'skipped', reason: 'fresh install' };
  }

  if (last === current.version) {
    return { status: 'skipped', reason: 'version unchanged since last boot' };
  }

  // Either last === null with an existing schema (first boot after this feature
  // landed on an already-populated install) or last !== current (a real
  // upgrade or downgrade). Both get a snapshot.
  try {
    const backup = backupDatabaseNow(db, { version: current.version, kind: 'upgrade' });
    const pruned = pruneDatabaseBackups();
    writeLastVersion(current.version);
    recordAttempt({
      at: Date.now(),
      fromVersion: last,
      toVersion: current.version,
      status: 'created',
      backupName: backup.name,
    });
    console.log(
      `[dbBackup] version ${last ?? '(unknown)'} -> ${current.version}: saved ${backup.name} ` +
        `(${(backup.sizeBytes / 1_048_576).toFixed(1)} MB)${pruned > 0 ? `, pruned ${pruned} old` : ''}`,
    );
    return { status: 'created', backup, previousVersion: last, pruned };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Deliberately NOT writing the version marker: the next boot retries the
    // snapshot, and the error keeps surfacing until the operator fixes it
    // (usually free disk space).
    recordAttempt({
      at: Date.now(),
      fromVersion: last,
      toVersion: current.version,
      status: 'failed',
      error,
    });
    console.error(`[dbBackup] FAILED to snapshot before migrating to ${current.version}: ${error}`);
    return { status: 'failed', error, previousVersion: last };
  }
}

// ─── Restore instructions dropped next to the backups ───────────────────────

function writeRestoreDoc(): void {
  const body = `Nebulis database backups
========================

Each nebulis-db-*.db file in this folder is a complete copy of the Nebulis
database (nebulis.db), taken automatically just before the server applied the
schema changes for a new version. They are here so you can go back to an older
Nebulis release without carrying forward data that the newer version has
already rewritten.

Filename:  nebulis-db-<timestamp>-v<version>-<kind>.db
           <version> is the Nebulis build the snapshot was taken for.
           <kind> is "upgrade" (automatic, pre-migration) or "manual".

The ${MAX_RETAINED} newest of each kind are kept. To keep one permanently,
copy it somewhere else or download it from Settings > Storage > Backups.

This is a database-only backup. It does NOT include your imported images or the
library folder. Those files are never rewritten by an upgrade, but if the
library folder layout changed you may also need your own copy of it. For a full
safety net, back up the whole data directory below before a major upgrade.

Data directory: ${DATA_DIR}


HOW TO RESTORE
--------------

1. Stop Nebulis.
     - Docker:   docker compose down
     - Windows:  stop the "Nebulis" service (services.msc, or
                 net stop Nebulis)
     - macOS:    quit Nebulis from the menu bar

2. In the data directory above, replace the live database with the backup:
     - Delete or rename:  nebulis.db
     - Also delete if present:  nebulis.db-wal   nebulis.db-shm
     - Copy your chosen  nebulis-db-*.db  to  nebulis.db

3. Install the older Nebulis version (download the installer from nebulis.app,
   or pin the older image tag for Docker) and start it again.

4. If telescope connections show a credential error afterwards, the data key
   changed at some point: re-enter the SMB/FTP password in
   Settings > Telescopes. Nothing else needs attention.
`;
  try {
    fs.writeFileSync(RESTORE_DOC_PATH, body, 'utf8');
  } catch {
    /* best effort */
  }
}
