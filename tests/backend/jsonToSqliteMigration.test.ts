/**
 * runMigration(): the one-time import of the pre-SQLite JSON files
 * (users.json, nebulis-settings.json, notes.json, wishlist.json,
 * library-index.json, favorites.json) into nebulis.db.
 *
 * Each test writes legacy files into DATA_DIR, runs the migration against the
 * real db.ts schema, then checks the rows, the `.bak` renames, and the cases
 * where nothing may be touched (already migrated, no files, a corrupt file).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-json-migrate-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { runMigration } from '../../server/lib/migrate';

const FILES = ['users.json', 'nebulis-settings.json', 'notes.json', 'wishlist.json', 'library-index.json', 'favorites.json'];

function writeJson(name: string, value: unknown): void {
  fs.writeFileSync(path.join(TEST_DATA_DIR, name), typeof value === 'string' ? value : JSON.stringify(value));
}

function count(table: string): number {
  return db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c;
}

beforeEach(() => {
  for (const f of FILES) {
    for (const suffix of ['', '.bak']) fs.rmSync(path.join(TEST_DATA_DIR, f + suffix), { force: true });
  }
  for (const t of ['users', 'telescopeTransports', 'telescopeProfiles', 'notes', 'wishlist', 'librarySessions', 'libraryDeletedSessions', 'libraryObjects', 'favorites']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("UPDATE settings SET data = '{}' WHERE id = 1").run();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const goodUser = { id: 'u1', username: 'astro', email: 'a@example.com', passwordHash: 'h', displayName: 'Astro', createdAt: '2024-01-01T00:00:00.000Z' };

describe('runMigration', () => {
  it('does nothing and creates no files on a fresh install', () => {
    runMigration();
    expect(count('users')).toBe(0);
    expect(fs.readdirSync(TEST_DATA_DIR).filter(f => f.endsWith('.bak'))).toEqual([]);
  });

  it('imports every legacy file and renames each to .bak', () => {
    writeJson('users.json', [goodUser]);
    writeJson('nebulis-settings.json', {
      timezone: 'Europe/Berlin',
      hostname: 'ignored-legacy-field',
      telescopes: [{ id: 't1', name: 'My S50', model: 'SeeStar S50', hostname: 'seestar.local', isActive: true, createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    writeJson('notes.json', [{ id: 'n1', objectId: 'M31', date: '2024-10-01', rating: 4, notes: 'clear', createdAt: '2024-10-01T00:00:00.000Z', updatedAt: '2024-10-01T00:00:00.000Z' }]);
    writeJson('wishlist.json', [{ id: 'w1', objectId: 'M42', name: 'Orion Nebula', addedAt: '2024-02-01T00:00:00.000Z' }]);
    writeJson('library-index.json', {
      version: 3,
      lastImport: '2024-10-02T00:00:00.000Z',
      objects: {
        M31: { folderName: 'M 31', fileCount: 12, lastImport: '2024-10-02T00:00:00.000Z', sessions: ['2024-10-01', '2024-10-02'], deletedSessions: ['2024-09-01'] },
        M42: { deleted: true, deletedAt: '2024-05-01T00:00:00.000Z' },
      },
    });
    writeJson('favorites.json', ['M31', 'NGC7000']);

    runMigration();

    expect(db.prepare('SELECT username, email, displayName FROM users WHERE id = ?').get('u1'))
      .toEqual({ username: 'astro', email: 'a@example.com', displayName: 'Astro' });

    const profile = db.prepare<[string], { name: string; hostname: string; isActive: number }>(
      'SELECT name, hostname, isActive FROM telescopeProfiles WHERE id = ?',
    ).get('t1');
    expect(profile).toEqual({ name: 'My S50', hostname: 'seestar.local', isActive: 1 });

    const blob = JSON.parse(db.prepare<[], { data: string }>('SELECT data FROM settings WHERE id = 1').get()!.data);
    expect(blob.timezone).toBe('Europe/Berlin');
    expect(blob).not.toHaveProperty('telescopes');
    expect(blob).not.toHaveProperty('hostname');

    expect(db.prepare('SELECT rating, notes FROM notes WHERE id = ?').get('n1')).toEqual({ rating: 4, notes: 'clear' });
    expect(db.prepare('SELECT name FROM wishlist WHERE objectId = ?').get('M42')).toEqual({ name: 'Orion Nebula' });

    const m31 = db.prepare<[string], { folderName: string; fileCount: number; deleted: number }>(
      'SELECT folderName, fileCount, deleted FROM libraryObjects WHERE objectId = ?',
    ).get('M31');
    expect(m31).toEqual({ folderName: 'M 31', fileCount: 12, deleted: 0 });
    const m42 = db.prepare<[string], { folderName: string; deleted: number; deletedAt: string }>(
      'SELECT folderName, deleted, deletedAt FROM libraryObjects WHERE objectId = ?',
    ).get('M42');
    // A missing folderName falls back to the object id.
    expect(m42).toEqual({ folderName: 'M42', deleted: 1, deletedAt: '2024-05-01T00:00:00.000Z' });
    expect(db.prepare<[string], { date: string }>('SELECT date FROM librarySessions WHERE objectId = ? ORDER BY date').all('M31').map(r => r.date))
      .toEqual(['2024-10-01', '2024-10-02']);
    expect(db.prepare<[string], { date: string }>('SELECT date FROM libraryDeletedSessions WHERE objectId = ?').all('M31').map(r => r.date))
      .toEqual(['2024-09-01']);
    expect(db.prepare<[], { version: number; lastImport: string }>('SELECT version, lastImport FROM libraryMeta WHERE id = 1').get())
      .toEqual({ version: 3, lastImport: '2024-10-02T00:00:00.000Z' });

    // Legacy favorites belong to the anonymous user.
    expect(db.prepare<[], { objectId: string; userId: string }>('SELECT objectId, userId FROM favorites ORDER BY objectId').all())
      .toEqual([{ objectId: 'M31', userId: '' }, { objectId: 'NGC7000', userId: '' }]);

    for (const f of FILES) {
      expect(fs.existsSync(path.join(TEST_DATA_DIR, f)), `${f} should be renamed`).toBe(false);
      expect(fs.existsSync(path.join(TEST_DATA_DIR, f + '.bak')), `${f}.bak should exist`).toBe(true);
    }
  });

  it('skips malformed rows and keeps the good ones', () => {
    writeJson('users.json', [
      goodUser,
      { id: 'u2', username: 'no-hash', displayName: 'x', createdAt: 'y' },
      'not an object',
      null,
    ]);
    writeJson('favorites.json', ['M31', 42, null, 'M42']);
    writeJson('notes.json', [{ id: 'n1', objectId: 'M31' }]);

    runMigration();

    expect(count('users')).toBe(1);
    expect(count('favorites')).toBe(2);
    expect(count('notes')).toBe(0);
  });

  it('applies the documented defaults for missing optional fields', () => {
    writeJson('nebulis-settings.json', { telescopes: [{ id: 't1', name: 'Bare' }] });
    runMigration();
    const row = db.prepare<[string], { model: string; shareName: string; username: string; password: string; isActive: number }>(
      'SELECT model, shareName, username, password, isActive FROM telescopeProfiles WHERE id = ?',
    ).get('t1');
    expect(row).toEqual({ model: 'SeeStar S50', shareName: 'EMMC Images', username: 'guest', password: '', isActive: 0 });
  });

  it('does not run again once the database already has users, and leaves the JSON files alone', () => {
    db.prepare('INSERT INTO users (id, username, email, passwordHash, displayName, createdAt) VALUES (?,?,?,?,?,?)')
      .run('existing', 'someone', '', 'h', 'Someone', '2024-01-01T00:00:00.000Z');
    writeJson('users.json', [goodUser]);
    writeJson('favorites.json', ['M31']);

    runMigration();

    expect(count('users')).toBe(1);
    expect(count('favorites')).toBe(0);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'users.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'users.json.bak'))).toBe(false);
  });

  it('does not run again once settings were already migrated', () => {
    db.prepare("UPDATE settings SET data = ? WHERE id = 1").run(JSON.stringify({ timezone: 'UTC' }));
    writeJson('favorites.json', ['M31']);
    runMigration();
    expect(count('favorites')).toBe(0);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'favorites.json'))).toBe(true);
  });

  it('is atomic: a corrupt file rolls back everything and renames nothing', () => {
    writeJson('users.json', [goodUser]);
    writeJson('notes.json', '{ this is not json');

    expect(() => runMigration()).toThrow();

    expect(count('users')).toBe(0);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'users.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'users.json.bak'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'notes.json'))).toBe(true);
  });

  it('a retry after the corrupt file is fixed completes the migration', () => {
    writeJson('users.json', [goodUser]);
    writeJson('notes.json', '{ broken');
    expect(() => runMigration()).toThrow();

    writeJson('notes.json', []);
    runMigration();

    expect(count('users')).toBe(1);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'users.json.bak'))).toBe(true);
  });

  it('a second call after success changes nothing', () => {
    writeJson('users.json', [goodUser]);
    runMigration();
    expect(count('users')).toBe(1);
    runMigration();
    expect(count('users')).toBe(1);
  });
});
