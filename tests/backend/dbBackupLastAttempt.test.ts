import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// paths.ts reads DATA_DIR at module load. dbBackup.ts never imports db.ts, so a
// hoisted env redirect + dynamic import is enough (same idea as dbBackup.test.ts).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-dblastattempt-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

let mod: typeof import('../../server/lib/dbBackup');
const ATTEMPT_FILE = path.join(TEST_DATA_DIR, 'backups', '.last-attempt.json');

function writeAttempt(body: unknown): void {
  fs.mkdirSync(path.dirname(ATTEMPT_FILE), { recursive: true });
  fs.writeFileSync(ATTEMPT_FILE, typeof body === 'string' ? body : JSON.stringify(body));
}

const VALID = { at: 1_760_000_000_000, fromVersion: '2.1.0', toVersion: '2.2.0', status: 'created', backupName: 'x.db' };

beforeAll(async () => {
  mod = await import('../../server/lib/dbBackup');
});

beforeEach(() => {
  for (const name of fs.readdirSync(TEST_DATA_DIR)) {
    fs.rmSync(path.join(TEST_DATA_DIR, name), { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('readLastAttempt', () => {
  it('returns null when no attempt file exists', () => {
    expect(mod.readLastAttempt()).toBeNull();
  });

  it('round-trips a valid "created" record', () => {
    writeAttempt(VALID);
    expect(mod.readLastAttempt()).toEqual(VALID);
  });

  it('accepts a null fromVersion and a "failed" status with an error string', () => {
    const failed = { at: 5, fromVersion: null, toVersion: '2.2.0', status: 'failed', error: 'ENOSPC' };
    writeAttempt(failed);
    expect(mod.readLastAttempt()).toEqual(failed);
  });

  it('drops unknown extra fields', () => {
    writeAttempt({ ...VALID, injected: '<script>' });
    expect(mod.readLastAttempt()).toEqual(VALID);
  });

  it('returns null for truncated / invalid JSON', () => {
    writeAttempt('{"at": 17600');
    expect(mod.readLastAttempt()).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    writeAttempt('[1,2,3]');
    expect(mod.readLastAttempt()).toBeNull();
    writeAttempt('"created"');
    expect(mod.readLastAttempt()).toBeNull();
  });

  it.each([
    ['at as string', { ...VALID, at: '1760000000000' }],
    ['fromVersion as number', { ...VALID, fromVersion: 2 }],
    ['missing toVersion', { at: 1, fromVersion: null, status: 'created' }],
    ['unknown status', { ...VALID, status: 'pending' }],
    ['error as object', { ...VALID, error: { message: 'x' } }],
    ['backupName as number', { ...VALID, backupName: 7 }],
  ])('returns null when %s', (_label, body) => {
    writeAttempt(body);
    expect(mod.readLastAttempt()).toBeNull();
  });
});

describe('maybeBackupBeforeMigrations writes a record readLastAttempt can read', () => {
  it('records a created attempt with from/to versions and backup name', () => {
    const db = new Database(path.join(TEST_DATA_DIR, 'nebulis.db'));
    db.exec('CREATE TABLE t (id INTEGER)');
    fs.writeFileSync(path.join(TEST_DATA_DIR, '.last-version'), '2.1.0\n');

    const outcome = mod.maybeBackupBeforeMigrations(db, { version: '2.2.0', known: true });
    db.close();

    const attempt = mod.readLastAttempt();
    expect(outcome.status).toBe('created');
    expect(attempt?.status).toBe('created');
    expect(attempt?.fromVersion).toBe('2.1.0');
    expect(attempt?.toVersion).toBe('2.2.0');
    expect(attempt?.backupName).toBe(outcome.status === 'created' ? outcome.backup.name : 'n/a');
  });

  it('records a failed attempt with the error message', () => {
    const failingDb = {
      exec: () => { throw new Error('disk full'); },
      prepare: () => ({ get: () => ({ n: 3 }) }),
    };

    mod.maybeBackupBeforeMigrations(failingDb, { version: '2.2.0', known: true });

    expect(mod.readLastAttempt()).toMatchObject({ status: 'failed', error: 'disk full', fromVersion: null, toVersion: '2.2.0' });
  });
});
