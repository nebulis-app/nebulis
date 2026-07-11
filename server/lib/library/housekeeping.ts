/**
 * Library — housekeeping domain.
 *
 * Background jobs that keep the library tidy: junk-file purge and the
 * auto-import scheduler that fires runImport() per telescope on its own
 * interval.
 */
import fs from 'fs';
import path from 'path';
import { getLibraryDir, isLibraryAvailable, withTimeout, LIBRARY_IO_TIMEOUT_MS } from '../libraryPath.js';
import { isLibraryMigrating } from '../libraryMaintenance.js';
import { DATA_DIR } from '../paths.js';
import { isRealFile } from '../telescopeFiles.js';
import {
  getAutoImportProfiles,
  type TelescopeProfile,
} from '../telescopes.js';
import { log } from '../logger.js';
import { runImport, claimImportLock, getImportStatus } from './import.js';

// ─── Junk-file purge ────────────────────────────────────────────────────────

/**
 * Scan the library and delete any files that are not real image/data files
 * (e.g. macOS ._* resource forks, .DS_Store, etc.).
 *
 * Async and timeout-bounded (fs.promises + withTimeout, same as
 * isLibraryAvailable()'s network check) rather than the old fs.*Sync walk:
 * this runs unconditionally at server boot and once nightly with no user
 * waiting on it, so a stale network-mounted library previously froze the
 * entire event loop for as long as the OS's SMB client took to give up. Gated
 * on isLibraryAvailable() up front so a disconnected/migrating library skips
 * the scan entirely instead of attempting it.
 */
export async function purgeJunkFiles(): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;
  if (isLibraryMigrating() || !(await isLibraryAvailable())) return { deleted, errors };

  const LIBRARY_DIR = getLibraryDir();
  let objectDirs: string[];
  try {
    objectDirs = await withTimeout(fs.promises.readdir(LIBRARY_DIR), LIBRARY_IO_TIMEOUT_MS);
  } catch {
    return { deleted, errors };
  }

  for (const objectDir of objectDirs) {
    const objPath = path.join(LIBRARY_DIR, objectDir);
    try {
      const stat = await withTimeout(fs.promises.stat(objPath), LIBRARY_IO_TIMEOUT_MS);
      if (!stat.isDirectory()) continue;
      const files = await withTimeout(fs.promises.readdir(objPath), LIBRARY_IO_TIMEOUT_MS);
      for (const fname of files) {
        if (!isRealFile(fname)) {
          try {
            await withTimeout(fs.promises.unlink(path.join(objPath, fname)), LIBRARY_IO_TIMEOUT_MS);
            deleted++;
          } catch {
            errors++;
          }
        }
      }
    } catch { /* skip unreadable/unresponsive dirs */ }
  }
  if (deleted > 0) {
    console.log(`[library] Purged ${deleted} junk file(s) from library${errors > 0 ? ` (${errors} errors)` : ''}`);
  }
  return { deleted, errors };
}

// ─── Import-tmp cleanup ──────────────────────────────────────────────────────

const IMPORT_TMP_BASE = path.join(DATA_DIR, 'import-tmp');
const IMPORT_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete UUID subdirectories under DATA_DIR/import-tmp that are older than
 * 24 hours. These are created by the folder-import wizard upload step and
 * cleaned up automatically when the commit phase completes. If the user
 * abandons the wizard before committing, the dirs accumulate indefinitely
 * without this sweep.
 */
export function purgeStaleImportTmp(): { deleted: number; errors: number } {
  let deleted = 0;
  let errors = 0;
  if (!fs.existsSync(IMPORT_TMP_BASE)) return { deleted, errors };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(IMPORT_TMP_BASE, { withFileTypes: true });
  } catch {
    return { deleted, errors };
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(IMPORT_TMP_BASE, entry.name);
    try {
      const { mtimeMs } = fs.statSync(dirPath);
      if (now - mtimeMs >= IMPORT_TMP_MAX_AGE_MS) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        deleted++;
      }
    } catch {
      errors++;
    }
  }

  if (deleted > 0) {
    console.log(`[library] Purged ${deleted} stale import-tmp dir(s)${errors > 0 ? ` (${errors} errors)` : ''}`);
  }
  return { deleted, errors };
}

export function scheduleImportTmpCleanup(): void {
  setInterval(() => { purgeStaleImportTmp(); }, 24 * 60 * 60 * 1000);
}

// ─── Auto-import scheduler ──────────────────────────────────────────────────

// Per-telescope last-run timestamps (in-memory; reset on server restart, which
// is fine — a missed import on startup is harmless and avoids storing mutable
// state in SQLite for something this ephemeral).
const telescopeLastRun = new Map<string, number>();

/**
 * Polls every minute. For each auto-import-enabled telescope, triggers an
 * import when that telescope's own interval has elapsed since its last run.
 */
export function scheduleAutoImport(): void {
  setInterval(() => {
    void tick();
  }, 60 * 1000);
}

async function tick(): Promise<void> {
  // Don't import while the library is being moved, or when its drive/network
  // share is not reachable: a write would either fight the migration or
  // recreate the path on the wrong volume. For a network library, this call
  // also opportunistically retries the connection, so a share that comes
  // back online is picked up within about a minute with no user action.
  if (isLibraryMigrating()) {
    log.debug('[auto-import] tick skipped: library is migrating');
    return;
  }
  if (!(await isLibraryAvailable())) {
    log.debug('[auto-import] tick skipped: library unavailable (drive/share not reachable)');
    return;
  }

  const profiles = getAutoImportProfiles();
  if (profiles.length === 0) {
    log.debug('[auto-import] tick skipped: no auto-import-enabled telescopes');
    return;
  }

  const now = Date.now();
  const due = profiles.filter(p => {
    const intervalMs = Math.max(5, p.autoImportInterval ?? 60) * 60 * 1000;
    return now - (telescopeLastRun.get(p.id) ?? 0) >= intervalMs;
  });

  if (due.length === 0) {
    log.debug(
      { telescopes: profiles.map(p => ({ id: p.id, name: p.name, intervalMin: p.autoImportInterval })) },
      '[auto-import] tick skipped: no telescope due yet',
    );
    return;
  }
  if (!claimImportLock()) {
    log.debug('[auto-import] tick skipped: import lock already held');
    return;
  }

  const runStart = now;
  // Mark these telescopes' last-run BEFORE awaiting so a transient failure
  // doesn't cause the same scopes to be re-fired every 60 seconds forever.
  // The next scheduled tick is gated by their normal interval.
  for (const p of due) telescopeLastRun.set(p.id, runStart);
  log.info(
    { telescopes: due.map(p => ({ id: p.id, name: p.name, kind: p.kind })) },
    '[auto-import] Scheduled import triggered for %d telescope(s)',
    due.length,
  );
  runDueTelescopesImport(due)
    .catch(err => { console.error('[auto-import] failed:', err instanceof Error ? err.message : err); });
}

async function runDueTelescopesImport(profiles: TelescopeProfile[]): Promise<void> {
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    if (i > 0 && !claimImportLock()) return;
    try {
      await runImport(undefined, undefined, { telescopeId: profile.id });
      const status = getImportStatus();
      log.info(
        { telescope: profile.name, filesDone: status.filesDone, skipped: status.skippedFiles, objects: status.objectsDone, error: status.error ?? null },
        '[auto-import] completed',
      );
    } catch (err) {
      console.error(`[import] runImport failed for ${profile.name}:`, err instanceof Error ? err.message : err);
    }
  }
}
