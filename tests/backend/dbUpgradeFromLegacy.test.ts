/**
 * Boots the real db.ts against a nebulis.db written in an OLD shape, so the
 * module-load migrations run for real (librarySourcesSchema.test.ts replays a
 * copy of the SQL against a scratch table, which cannot catch a broken
 * statement order or a migration that quietly drops rows).
 *
 * Covers: users role/tokenVersion backfill, the favorites / imageFavorites
 * table rebuild (add userId to the primary key), the legacy transport and
 * profile column backfill, plaintext password sealing, plaintext admin API key
 * sealing, and that a second boot changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-legacy-upgrade-'));
  process.env.DATA_DIR = dir;
  return dir;
});

type Db = import('better-sqlite3').Database;

const DB_FILE = path.join(TEST_DATA_DIR, 'nebulis.db');

function cols(db: Db, table: string): string[] {
  return db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function pkCols(db: Db, table: string): string[] {
  return db.prepare<[], { name: string; pk: number }>(`PRAGMA table_info(${table})`)
    .all().filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

function isSealed(value: string): boolean {
  return value.split('.').length === 3;
}

/** The shapes these tables had before userId / role / multi-transport existed. */
function seedLegacyDatabase(): void {
  const legacy = new Database(DB_FILE);
  legacy.pragma('journal_mode = WAL');
  legacy.exec(`
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      displayName  TEXT NOT NULL,
      createdAt    TEXT NOT NULL
    );
    CREATE TABLE favorites (objectId TEXT PRIMARY KEY);
    CREATE TABLE imageFavorites (imagePath TEXT PRIMARY KEY);
    CREATE TABLE telescopeProfiles (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      model     TEXT NOT NULL DEFAULT 'SeeStar S50',
      hostname  TEXT NOT NULL DEFAULT '',
      shareName TEXT NOT NULL DEFAULT 'EMMC Images',
      username  TEXT NOT NULL DEFAULT 'guest',
      password  TEXT NOT NULL DEFAULT '',
      isActive  INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );
  `);
  legacy.prepare('INSERT INTO users (id, username, email, passwordHash, displayName, createdAt) VALUES (?,?,?,?,?,?)')
    .run('u1', 'astro', 'a@example.com', '$2b$12$hash', 'Astro', '2025-01-01T00:00:00.000Z');
  for (const id of ['M31', 'M42', 'NGC7000']) legacy.prepare('INSERT INTO favorites (objectId) VALUES (?)').run(id);
  for (const p of ['M31/a.jpg', 'M42/b.jpg']) legacy.prepare('INSERT INTO imageFavorites (imagePath) VALUES (?)').run(p);
  legacy.prepare('INSERT INTO telescopeProfiles (id, name, model, hostname, shareName, username, password, isActive, createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('t1', 'My S50', 'SeeStar S50', 'seestar.local', 'EMMC Images', 'guest', 'plaintext-pw', 1, '2025-01-01T00:00:00.000Z');
  legacy.close();
}

let db: Db;

beforeAll(async () => {
  seedLegacyDatabase();
  db = (await import('../../server/lib/db')).default;
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('first boot of an old database', () => {
  it('snapshots the old schema before migrating', async () => {
    const { startupBackupOutcome } = await import('../../server/lib/db');
    // A pre-existing install with no .last-version marker is backed up first.
    expect(['created', 'skipped']).toContain(startupBackupOutcome.status);
    if (startupBackupOutcome.status === 'created') {
      const snap = new Database(startupBackupOutcome.backup.path, { readonly: true });
      try {
        expect(cols(snap, 'users')).not.toContain('role');
        expect(pkCols(snap, 'favorites')).toEqual(['objectId']);
      } finally { snap.close(); }
    }
  });

  it('adds role and tokenVersion to users and keeps the existing account as admin', () => {
    expect(cols(db, 'users')).toEqual(expect.arrayContaining(['role', 'tokenVersion']));
    const row = db.prepare<[string], { username: string; role: string; tokenVersion: number; passwordHash: string }>(
      'SELECT username, role, tokenVersion, passwordHash FROM users WHERE id = ?',
    ).get('u1');
    expect(row).toEqual({ username: 'astro', role: 'admin', tokenVersion: 0, passwordHash: '$2b$12$hash' });
  });

  it('rebuilds favorites with userId in the key and keeps every row under the anonymous user', () => {
    expect(pkCols(db, 'favorites')).toEqual(['objectId', 'userId']);
    const rows = db.prepare<[], { objectId: string; userId: string }>('SELECT objectId, userId FROM favorites ORDER BY objectId').all();
    expect(rows).toEqual([
      { objectId: 'M31', userId: '' },
      { objectId: 'M42', userId: '' },
      { objectId: 'NGC7000', userId: '' },
    ]);
  });

  it('rebuilds imageFavorites with userId in the key and keeps every row', () => {
    expect(pkCols(db, 'imageFavorites')).toEqual(['imagePath', 'userId']);
    const rows = db.prepare<[], { imagePath: string; userId: string }>('SELECT imagePath, userId FROM imageFavorites ORDER BY imagePath').all();
    expect(rows).toEqual([
      { imagePath: 'M31/a.jpg', userId: '' },
      { imagePath: 'M42/b.jpg', userId: '' },
    ]);
  });

  it('leaves no scratch tables from the rebuild behind', () => {
    const names = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    expect(names).not.toContain('favorites_new');
    expect(names).not.toContain('imageFavorites_new');
  });

  it('allows the same object to be favourited by two users after the rebuild', () => {
    db.prepare('INSERT INTO favorites (objectId, userId) VALUES (?, ?)').run('M31', 'u1');
    const n = db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM favorites WHERE objectId = ?').get('M31');
    expect(n?.c).toBe(2);
    db.prepare('DELETE FROM favorites WHERE userId = ?').run('u1');
  });

  it('adds the multi-telescope columns to the old profile and keeps its data', () => {
    expect(cols(db, 'telescopeProfiles')).toEqual(
      expect.arrayContaining(['kind', 'color', 'autoImportEnabled', 'archivedAt', 'connectionType', 'localPath', 'deviceId']),
    );
    const row = db.prepare<[string], { name: string; hostname: string; isActive: number; kind: string }>(
      'SELECT name, hostname, isActive, kind FROM telescopeProfiles WHERE id = ?',
    ).get('t1');
    expect(row?.name).toBe('My S50');
    expect(row?.hostname).toBe('seestar.local');
    expect(row?.isActive).toBe(1);
    expect(row?.kind).toBeTruthy();
  });

  it('seals the old plaintext profile password', async () => {
    const { decrypt } = await import('../../server/lib/crypto/secretBox');
    const row = db.prepare<[string], { password: string }>('SELECT password FROM telescopeProfiles WHERE id = ?').get('t1');
    expect(row).toBeDefined();
    expect(isSealed(row!.password)).toBe(true);
    expect(decrypt(row!.password)).toBe('plaintext-pw');
  });

  it('backfills one transport from the old profile, with the password sealed and readable', async () => {
    const { decrypt } = await import('../../server/lib/crypto/secretBox');
    const rows = db.prepare<[string], { hostname: string; shareName: string; username: string; password: string }>(
      'SELECT hostname, shareName, username, password FROM telescopeTransports WHERE profileId = ?',
    ).all('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0].hostname).toBe('seestar.local');
    expect(rows[0].shareName).toBe('EMMC Images');
    expect(rows[0].username).toBe('guest');
    expect(isSealed(rows[0].password)).toBe(true);
    expect(decrypt(rows[0].password)).toBe('plaintext-pw');
  });

  it('creates the tables introduced since, empty', () => {
    for (const t of ['librarySources', 'appSettings', 'libraryFiles', 'connectedDevices']) {
      const names = db.prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(t);
      expect(names, `table ${t}`).toHaveLength(1);
    }
  });
});

describe('a second boot of the upgraded database', () => {
  it('changes no data, adds no rows and does not double-seal secrets', async () => {
    const tables = db.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map(r => r.name);

    // Put the admin API key back to plaintext, as an old install would have it.
    db.prepare("UPDATE appSettings SET apiKey = 'plain-admin-key' WHERE id = 1").run();
    db.prepare("INSERT OR IGNORE INTO appSettings (id, apiKey) VALUES (1, 'plain-admin-key')").run();

    const dump = (): Record<string, unknown[]> => {
      const out: Record<string, unknown[]> = {};
      for (const t of ['users', 'favorites', 'imageFavorites', 'telescopeProfiles', 'telescopeTransports']) {
        out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all();
      }
      return out;
    };
    const before = dump();
    const schemaBefore = tables.map(t => cols(db, t).join(','));

    // The in-memory handle is the boot-1 connection. Close it and load db.ts
    // again from disk, which is what a restart does.
    db.close();
    vi.resetModules();
    const reopened = (await import('../../server/lib/db')).default as Db;
    db = reopened;

    const after = dump();
    expect(after.users).toEqual(before.users);
    expect(after.favorites).toEqual(before.favorites);
    expect(after.imageFavorites).toEqual(before.imageFavorites);
    expect(after.telescopeProfiles).toEqual(before.telescopeProfiles);
    expect(after.telescopeTransports).toEqual(before.telescopeTransports);

    const tablesAfter = db.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map(r => r.name);
    expect(tablesAfter).toEqual(tables);
    expect(tablesAfter.map(t => cols(db, t).join(','))).toEqual(schemaBefore);

    // The plaintext admin key put back above is sealed on this boot, once.
    const { decrypt } = await import('../../server/lib/crypto/secretBox');
    const key = db.prepare<[], { apiKey: string }>('SELECT apiKey FROM appSettings WHERE id = 1').get();
    expect(isSealed(key!.apiKey)).toBe(true);
    expect(decrypt(key!.apiKey)).toBe('plain-admin-key');
  });
});
