// Global test setup — runs in every test file's worker before the file loads.
import { afterAll, afterEach, beforeAll, inject } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import Database from 'better-sqlite3';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Per-run shared SQLite data dir, chosen by tests/globalSetup.ts. */
    sharedDataDir: string;
  }
}

// ─── Per-run shared DATA_DIR ────────────────────────────────────────────────
// vitest.config.ts points DATA_DIR at `<repo>/.test-data`. That path used to be
// shared by every vitest process on the machine, so two runs at once (a watch
// session plus a one-off run, or two agents) deleted each other's `users` rows
// mid-test, and each run's globalSetup `rm -rf`'d the other's database. That was
// the cause of the "historically flaky" auth / rbac / devicePairing failures:
// their bcrypt-cost-12 tests hold a 200-400 ms window between writing a user and
// reading it back. globalSetup now hands each run its own subdirectory. The
// fallback keeps a run whose globalSetup predates `provide` working as before.
// Reassigning here (rather than only when unset) also stops a file that set its
// own DATA_DIR without restoring it from leaking that into a reused worker.
const SHARED_DATA_DIR = inject('sharedDataDir') ?? path.join(process.cwd(), '.test-data');
process.env.DATA_DIR = SHARED_DATA_DIR;
const SHARED_DB_PATH = path.join(SHARED_DATA_DIR, 'nebulis.db');

// Files that redirect DATA_DIR to their own `mkdtemp` dir (via `vi.hoisted`,
// before any server module loads) own an isolated SQLite file and clean it up
// themselves in `afterAll` — skip those. Frontend (jsdom) tests never touch
// the DB — skip those too.
function usesSharedDb(): boolean {
  return typeof window === 'undefined' && process.env.DATA_DIR === SHARED_DATA_DIR;
}

// A plain connection to the shared DB file. Deliberately NOT `server/lib/db`:
// importing that from here forced a SQLite open + full migration run into
// every pure-logic test file and coupled all of them to db.ts. Opened lazily
// only once the file exists, i.e. once some code under test has created it.
let conn: Database.Database | null = null;
function sharedConn(): Database.Database | null {
  if (conn) return conn;
  if (!fs.existsSync(SHARED_DB_PATH)) return null;
  conn = new Database(SHARED_DB_PATH, { fileMustExist: true });
  conn.pragma('busy_timeout = 5000');
  return conn;
}

// ─── Per-test reset (unchanged contract) ────────────────────────────────────
// These tables are wiped after every test. Files that use them still reset
// them in their own `beforeEach` (that documents intent); this is the net.
// foreign_keys is ON to match the app connection, so the same cascades fire.
const PER_TEST_TABLES = ['users', 'notes', 'wishlist', 'connectedDevices', 'devicePairings', 'telescopeProfiles'];

afterEach(() => {
  if (!usesSharedDb()) return;
  const c = sharedConn();
  if (!c) return;
  c.pragma('foreign_keys = ON');
  for (const table of PER_TEST_TABLES) {
    c.prepare(`DELETE FROM "${table}"`).run();
  }
});

// ─── Per-file restore (every table) ─────────────────────────────────────────
// The per-test list above covered 6 tables; files also write appSettings,
// observingSites, plannedSessions, the library tables, userApiKeys, systemLog,
// catalogWallOverrides, catalogPrefetchStatus, ... and nothing cleaned those at
// the file boundary, so whichever file ran next inherited them (Vitest has no
// deterministic file order, so that was a latent order-dependent flake).
//
// Wiping isn't right for every table: appSettings / settings / libraryMeta /
// catalogPrefetchStatus are singleton rows code assumes exist, and the boot
// migrations stamp one-shot marker columns into them that a re-inserted
// default row would get wrong. So instead each file snapshots the whole DB
// when it starts and puts back any table it changed when it ends. Since the
// first file starts from the fresh-boot DB, every file then starts from the
// fresh-boot DB.
type TableSnapshot = { columns: string[]; rows: unknown[][] };
let snapshot: Map<string, TableSnapshot> | null = null;

function listTables(c: Database.Database): string[] {
  const rows = c.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')",
  ).all();
  return rows.map(r => r.name);
}

function readTable(c: Database.Database, table: string): TableSnapshot {
  const stmt = c.prepare(`SELECT * FROM "${table}"`).raw(true);
  return { columns: stmt.columns().map(col => col.name), rows: stmt.all() as unknown[][] };
}

/** Order-insensitive fingerprint of `t` projected onto `columns`. */
function digest(t: TableSnapshot, columns: string[]): string {
  const idx = columns.map(col => t.columns.indexOf(col));
  return t.rows.map(r => JSON.stringify(idx.map(i => (i < 0 ? null : r[i])))).sort().join('\n');
}

beforeAll(() => {
  snapshot = null;
  if (!usesSharedDb()) return;
  // globalSetup creates the fresh-boot DB, so this is normally always there.
  const c = sharedConn();
  if (!c) return;
  snapshot = new Map(listTables(c).map(t => [t, readTable(c, t)]));
});

afterAll(() => {
  // Restore by path, not by the current DATA_DIR: a file that swapped
  // DATA_DIR mid-run may still have written the shared DB first.
  const before = snapshot;
  snapshot = null;
  if (before) {
    const c = sharedConn();
    if (c) {
      c.pragma('foreign_keys = OFF');
      c.transaction(() => {
        for (const table of listTables(c)) {
          const now = readTable(c, table);
          const was = before.get(table);
          if (!was) {
            // Created during this file (a module's lazy CREATE TABLE): the
            // fresh-boot state for it is empty. Keep the table, drop the rows.
            if (now.rows.length > 0) c.prepare(`DELETE FROM "${table}"`).run();
            continue;
          }
          // Compare on the columns that existed at the start, so a migration
          // that only ADDs a column (with its default) isn't a "change".
          const cols = was.columns.filter(col => now.columns.includes(col));
          if (digest(was, cols) === digest(now, cols)) continue;
          c.prepare(`DELETE FROM "${table}"`).run();
          if (was.rows.length === 0) continue;
          const idx = cols.map(col => was.columns.indexOf(col));
          const insert = c.prepare(
            `INSERT INTO "${table}" (${cols.map(col => `"${col}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          );
          for (const row of was.rows) insert.run(idx.map(i => row[i]));
        }
      })();
    }
  }
  conn?.close();
  conn = null;
});

// ─── Temp-dir net ───────────────────────────────────────────────────────────
// ~30 files mkdtemp scratch trees under os.tmpdir() (some through copy-pasted
// `tmpDir()` helpers with dozens of call sites) and never remove them, and a
// cleanup written in a test body is skipped when an assertion above it fails.
// A full backend run left ~157 dirs behind. Every test file runs in its own
// worker process, so recording each mkdtemp made under os.tmpdir() or
// <repo>/.test-tmp during this file and removing them once the file is done
// (this afterAll runs after the file's own afterAll hooks) cannot touch any
// other file's or any concurrent run's dirs. Explicit per-file cleanup stays
// welcome; this only catches what it misses.
const TEMP_ROOTS = [os.tmpdir(), fs.realpathSync(os.tmpdir()), path.join(process.cwd(), '.test-tmp')];
const createdTempDirs: string[] = [];
function trackTempDir(dir: unknown): void {
  if (typeof dir !== 'string') return;
  if (TEMP_ROOTS.some(root => dir.startsWith(root + path.sep))) createdTempDirs.push(dir);
}
const realMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function mkdtempSync(...args: Parameters<typeof realMkdtempSync>) {
  const dir = realMkdtempSync.apply(fs, args);
  trackTempDir(dir);
  return dir;
} as typeof fs.mkdtempSync;
const realMkdtemp = fs.promises.mkdtemp;
fs.promises.mkdtemp = async function mkdtemp(...args: Parameters<typeof realMkdtemp>) {
  const dir = await realMkdtemp.apply(fs.promises, args);
  trackTempDir(dir);
  return dir;
} as typeof fs.promises.mkdtemp;
// Propagate to `import { mkdtempSync } from 'fs'` named bindings.
syncBuiltinESMExports();

function makeRemovable(p: string): void {
  // Some tests chmod a dir to 000 to provoke EACCES and don't always restore.
  try { fs.chmodSync(p, 0o700); } catch { return; }
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) makeRemovable(path.join(p, e.name));
}

afterAll(() => {
  for (const dir of createdTempDirs.splice(0).reverse()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      try {
        makeRemovable(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  }
});
