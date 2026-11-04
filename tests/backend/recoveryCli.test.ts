/**
 * server/lib/recoveryCli.ts runs on import and calls process.exit, so it is
 * exercised the way an admin uses it: as a separate process against a real
 * SQLite file in a scratch DATA_DIR.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const root = path.join(process.cwd(), '.test-tmp');
fs.mkdirSync(root, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(root, 'nebulis-recovery-'));
const dbFile = path.join(dataDir, 'nebulis.db');
const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
const cli = path.join(process.cwd(), 'server', 'lib', 'recoveryCli.ts');

function seed(users: Array<{ id: string; username: string; role: string; displayName: string; password: string }>): void {
  fs.rmSync(dbFile, { force: true });
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT NOT NULL DEFAULT '',
    passwordHash TEXT NOT NULL, displayName TEXT NOT NULL, createdAt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin'
  )`);
  const ins = db.prepare('INSERT INTO users (id, username, passwordHash, displayName, createdAt, role) VALUES (?,?,?,?,?,?)');
  for (const u of users) ins.run(u.id, u.username, bcrypt.hashSync(u.password, 4), u.displayName, '2024-01-01', u.role);
  db.close();
}

function run(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(tsx, [cli, ...args], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function hashOf(username: string): string {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare<[string], { passwordHash: string }>('SELECT passwordHash FROM users WHERE username = ?').get(username)!.passwordHash;
  } finally { db.close(); }
}

beforeEach(() => {
  seed([
    { id: 'u1', username: 'admin', role: 'admin', displayName: 'Admin', password: 'old-admin-pw' },
    { id: 'u2', username: 'viewer', role: 'viewer', displayName: 'Guest Viewer', password: 'old-viewer-pw' },
  ]);
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('recoveryCli', () => {
  it('--list-users prints every account and changes nothing', () => {
    const before = hashOf('admin');
    const { code, out } = run('--list-users');
    expect(code).toBe(0);
    expect(out).toContain('admin  (admin)');
    expect(out).toContain('viewer  (viewer)');
    expect(out).toContain('"Guest Viewer"');
    expect(hashOf('admin')).toBe(before);
  });

  it('--reset-password with a supplied password sets exactly that password, and only for that user', () => {
    const viewerBefore = hashOf('viewer');
    const { code, out } = run('--reset-password', 'admin', 'brand-new-pw');
    expect(code).toBe(0);
    expect(out).toContain('The password you supplied is now active');
    expect(out).not.toContain('brand-new-pw');
    expect(bcrypt.compareSync('brand-new-pw', hashOf('admin'))).toBe(true);
    expect(bcrypt.compareSync('old-admin-pw', hashOf('admin'))).toBe(false);
    expect(hashOf('viewer')).toBe(viewerBefore);
  });

  it('--reset-password without a password generates one, prints it, and it works', () => {
    const { code, out } = run('--reset-password', 'admin');
    expect(code).toBe(0);
    const m = out.match(/New password:\s+(\S+)/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBeGreaterThanOrEqual(10);
    expect(bcrypt.compareSync(m![1], hashOf('admin'))).toBe(true);
  });

  it('matches the username case-insensitively', () => {
    const { code } = run('--reset-password', 'ADMIN', 'case-pw');
    expect(code).toBe(0);
    expect(bcrypt.compareSync('case-pw', hashOf('admin'))).toBe(true);
  });

  it('fails with a clear message for an unknown account and leaves every hash alone', () => {
    const a = hashOf('admin');
    const v = hashOf('viewer');
    const { code, out } = run('--reset-password', 'ghost', 'x');
    expect(code).toBe(1);
    expect(out).toContain('No account named "ghost"');
    expect(hashOf('admin')).toBe(a);
    expect(hashOf('viewer')).toBe(v);
  });

  it('shows usage and the account list when no username is given', () => {
    const { code, out } = run('--reset-password');
    expect(code).toBe(1);
    expect(out).toContain('Usage: nebulis --reset-password');
    expect(out).toContain('admin');
  });

  it('fails clearly when there is no database, without creating one', () => {
    fs.rmSync(dbFile, { force: true });
    const { code, out } = run('--list-users');
    expect(code).toBe(1);
    expect(out).toContain('No database found');
    expect(fs.existsSync(dbFile)).toBe(false);
  });
});
