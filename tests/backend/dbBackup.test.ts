import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// paths.ts reads DATA_DIR at module load, so redirect it BEFORE importing
// dbBackup. One dir for the file; each test resets the state under it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-dbbackup-'));
process.env.DATA_DIR = tmpDir;

let mod: typeof import('../../server/lib/dbBackup');
const DB_FILE = path.join(tmpDir, 'nebulis.db');

beforeAll(async () => {
  mod = await import('../../server/lib/dbBackup');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true });
  }
});

/** A minimal populated SQLite DB standing in for nebulis.db. */
function makeDb(file = DB_FILE): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT INTO widgets (name) VALUES (?)');
  for (let i = 0; i < 50; i++) insert.run(`widget-${i}`);
  return db;
}

describe('maybeBackupBeforeMigrations', () => {
  it('skips a fresh install (no schema yet) and records the version', () => {
    const empty = new Database(DB_FILE);
    const outcome = mod.maybeBackupBeforeMigrations(empty, { version: '2.0.0', known: true });
    expect(outcome.status).toBe('skipped');
    expect(fs.readFileSync(path.join(tmpDir, '.last-version'), 'utf8').trim()).toBe('2.0.0');
    expect(mod.listDatabaseBackups()).toHaveLength(0);
  });

  it('skips when package.json version is unknown, without writing the marker', () => {
    const db = makeDb();
    const outcome = mod.maybeBackupBeforeMigrations(db, { version: '0.0.0', known: false });
    expect(outcome.status).toBe('skipped');
    expect(fs.existsSync(path.join(tmpDir, '.last-version'))).toBe(false);
  });

  it('snapshots an existing install on the first boot after the feature lands', () => {
    const db = makeDb();
    const outcome = mod.maybeBackupBeforeMigrations(db, { version: '2.0.0', known: true });
    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(outcome.previousVersion).toBeNull();
    expect(outcome.backup.kind).toBe('upgrade');
    expect(outcome.backup.version).toBe('2.0.0');
    expect(fs.existsSync(outcome.backup.path)).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, '.last-version'), 'utf8').trim()).toBe('2.0.0');
  });

  it('skips when the version has not changed', () => {
    const db = makeDb();
    fs.writeFileSync(path.join(tmpDir, '.last-version'), '2.0.0\n');
    const outcome = mod.maybeBackupBeforeMigrations(db, { version: '2.0.0', known: true });
    expect(outcome.status).toBe('skipped');
    expect(mod.listDatabaseBackups()).toHaveLength(0);
  });

  it('snapshots on a version change and the copy holds the same rows', () => {
    const db = makeDb();
    fs.writeFileSync(path.join(tmpDir, '.last-version'), '1.5.2\n');
    const outcome = mod.maybeBackupBeforeMigrations(db, { version: '2.0.0', known: true });
    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(outcome.previousVersion).toBe('1.5.2');

    const copy = new Database(outcome.backup.path, { readonly: true });
    const n = copy.prepare('SELECT count(*) AS n FROM widgets').get() as { n: number };
    expect(n.n).toBe(50);
    copy.close();
  });

  it('also snapshots on a downgrade (version simply differs)', () => {
    const db = makeDb();
    fs.writeFileSync(path.join(tmpDir, '.last-version'), '2.0.0\n');
    const outcome = mod.maybeBackupBeforeMigrations(db, { version: '1.5.2', known: true });
    expect(outcome.status).toBe('created');
  });

  it('does not write the marker when the snapshot fails', () => {
    const db = makeDb();
    fs.writeFileSync(path.join(tmpDir, '.last-version'), '1.5.2\n');
    // Make the backups path un-creatable: a file where the dir must go.
    fs.writeFileSync(path.join(tmpDir, 'backups'), 'not a directory');

    const outcome = mod.maybeBackupBeforeMigrations(db, { version: '2.0.0', known: true });
    expect(outcome.status).toBe('failed');
    expect(fs.readFileSync(path.join(tmpDir, '.last-version'), 'utf8').trim()).toBe('1.5.2');
  });
});

describe('retention', () => {
  it('keeps the newest N of each kind independently', () => {
    const db = makeDb();

    for (let i = 0; i < 5; i++) {
      const up = mod.backupDatabaseNow(db, { version: `2.0.${i}`, kind: 'upgrade' });
      const man = mod.backupDatabaseNow(db, { version: `2.0.${i}`, kind: 'manual' });
      const t = Date.now() - (10 - i) * 60_000;
      fs.utimesSync(up.path, new Date(t), new Date(t));
      fs.utimesSync(man.path, new Date(t + 1000), new Date(t + 1000));
    }

    const removed = mod.pruneDatabaseBackups(3);
    expect(removed).toBe(4); // 2 stale of each kind

    const left = mod.listDatabaseBackups();
    expect(left.filter(b => b.kind === 'upgrade')).toHaveLength(3);
    expect(left.filter(b => b.kind === 'manual')).toHaveLength(3);
  });
});

describe('name parsing / traversal guard', () => {
  it('round-trips a snapshot filename including a hyphenated version', () => {
    const db = makeDb();
    const b = mod.backupDatabaseNow(db, { version: '2.0.0-beta.1', kind: 'upgrade' });
    expect(mod.parseBackupName(b.name)).toEqual({ version: '2.0.0-beta.1', kind: 'upgrade' });
  });

  it('rejects anything that is not one of ours', () => {
    expect(mod.parseBackupName('../../etc/passwd')).toBeNull();
    expect(mod.parseBackupName('nebulis.db')).toBeNull();
    expect(mod.parseBackupName('nebulis-db-bad-vX-upgrade.db')).toBeNull();
    expect(mod.findDatabaseBackup('../nebulis.db')).toBeNull();
  });

  it('writes a RESTORE.txt alongside the backups', () => {
    const db = makeDb();
    mod.backupDatabaseNow(db, { version: '2.0.0', kind: 'manual' });
    expect(fs.existsSync(path.join(tmpDir, 'backups', 'RESTORE.txt'))).toBe(true);
  });
});
