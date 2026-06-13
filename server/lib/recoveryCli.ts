/**
 * Account recovery CLI, baked into the server binary.
 *
 * Someone with OS access to the machine runs the Nebulis server executable with
 * a flag; there is deliberately no web path for this (a forgotten-password reset
 * over the web would be a way in for anyone who can reach the server). Editing
 * the local SQLite database directly requires being on the box.
 *
 *   nebulis --list-users
 *   nebulis --reset-password <username> [newPassword]
 *
 * This module is imported FIRST in index.ts so it runs and exits before normal
 * boot, and before paths.ts/db.ts create or open the database. For that reason
 * it must not import paths.ts, db.ts, or logger.ts (paths.ts would mkdir a stray
 * data dir; db.ts would open the DB at a path we haven't resolved yet). It
 * resolves the data directory the same way paths.ts does for an installed app.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

interface UserRow {
  id: string;
  username: string;
  role: string;
  displayName: string;
}

const argv = process.argv.slice(2);
const isRecovery = argv.some(a =>
  a === '--reset-password' || a === 'reset-password' || a === '--list-users' || a === 'list-users',
);

if (isRecovery) {
  try {
    runRecovery();
    process.exit(0);
  } catch (err) {
    console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

/** Mirror of paths.ts for an installed app, plus the macOS install location. */
function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (fs.existsSync('/app/data')) return '/app/data';
  if (process.platform === 'win32') {
    return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Nebulis', 'data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Nebulis');
  }
  return path.join(process.cwd(), 'data');
}

function runRecovery(): void {
  const dbPath = path.join(resolveDataDir(), 'nebulis.db');
  console.log('\n  Nebulis account recovery');
  console.log(`  Database: ${dbPath}\n`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(
      'No database found there. If your data lives elsewhere, set DATA_DIR, e.g.\n'
      + '    DATA_DIR=/path/to/data nebulis --list-users',
    );
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000'); // tolerate a running service briefly holding the DB
  try {
    if (argv.includes('--list-users') || argv.includes('list-users')) {
      printUsers(db);
      return;
    }

    const flagIdx = argv.findIndex(a => a === '--reset-password' || a === 'reset-password');
    const username = argv[flagIdx + 1];
    const provided = argv[flagIdx + 2];

    if (!username || username.startsWith('--')) {
      printUsers(db);
      throw new Error('Usage: nebulis --reset-password <username> [newPassword]');
    }

    const user = db
      .prepare<[string], UserRow>('SELECT id, username, role, displayName FROM users WHERE username = ? COLLATE NOCASE')
      .get(username);
    if (!user) {
      printUsers(db);
      throw new Error(`No account named "${username}".`);
    }

    const newPassword = provided && !provided.startsWith('--')
      ? provided
      : crypto.randomBytes(9).toString('base64url'); // ~12 readable chars
    const passwordHash = bcrypt.hashSync(newPassword, 12); // matches server/lib/auth.ts
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(passwordHash, user.id);

    console.log(`  Password reset for "${user.username}" (${user.role}).`);
    if (provided) {
      console.log('  The password you supplied is now active.\n');
    } else {
      console.log(`\n    New password:  ${newPassword}\n`);
      console.log('  Log in with that, then change it under Settings.\n');
    }
  } finally {
    db.close();
  }
}

function printUsers(db: Database.Database): void {
  const rows = db
    .prepare<[], UserRow>('SELECT id, username, role, displayName FROM users ORDER BY role, username')
    .all();
  if (rows.length === 0) {
    console.log('  No accounts exist yet. Open the web UI to create the first one.\n');
    return;
  }
  console.log('  Accounts:');
  for (const r of rows) {
    const display = r.displayName && r.displayName !== r.username ? `  "${r.displayName}"` : '';
    console.log(`    - ${r.username}  (${r.role})${display}`);
  }
  console.log('');
}
