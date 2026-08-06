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
import { purgeImportTmp, type PurgeResult } from './importStaging.js';
import { isRealFile, isSidecarFile } from '../telescopeFiles.js';
import { MANIFEST_NAME } from './libraryFiles.js';
import {
  getAutoImportProfiles,
  type TelescopeProfile,
} from '../telescopes.js';
import { log } from '../logger.js';
import { runImport, claimImportLock, getImportStatus, forceReleaseStaleLock, appendImportStatusError, getImportLockStartedAt } from './import.js';

// Any real import (even a slow SMB pull of a large library) finishes well
// inside this window. If the lock is still held past it, something crashed
// or hung without releasing — force-release rather than 409ing every import
// forever.
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

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
 *
 * Also skipped entirely while an import is running, same reasoning as
 * purgeStaleImportTmp() below: an import writes `<dest>.tmp` files before
 * renaming them into place, and this purge would otherwise delete an
 * in-flight staging file out from under a running import.
 */
export async function purgeJunkFiles(): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;
  if (getImportStatus().running) return { deleted, errors };
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
      const entries = await withTimeout(
        fs.promises.readdir(objPath, { withFileTypes: true }), LIBRARY_IO_TIMEOUT_MS,
      );
      for (const ent of entries) {
        // Directories are never junk. A nested object's session folders (and
        // `processed/`, `.thumbs/`) have no file extension, so isRealFile says
        // false for them and this loop would try to unlink a directory on every
        // scheduled run — failing every time and inflating the error count.
        if (!ent.isFile()) continue;
        // The per-file manifest is dot-prefixed, which means isRealFile rejects
        // it exactly like a .DS_Store. Deleting it would silently destroy the
        // rebuild-from-disk guarantee (see libraryFiles.ts) on every pass, so it
        // is excluded by name rather than by the dot rule — real junk like
        // `._foo` and `.DS_Store` must still be purged.
        if (ent.name === MANIFEST_NAME) continue;
        // Sidecars (shotsInfo.json and friends) are imported on purpose but are
        // deliberately outside isRealFile's image-only allowlist, so this purge
        // would delete every one of them on the next scheduled pass.
        if (isSidecarFile(ent.name)) continue;
        if (!isRealFile(ent.name)) {
          try {
            await withTimeout(fs.promises.unlink(path.join(objPath, ent.name)), LIBRARY_IO_TIMEOUT_MS);
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

/**
 * How long an abandoned upload session is kept before the unattended sweep
 * reclaims it. This was 24 hours, which is far too generous for something that
 * holds a full second copy of the user's import: a 125 GB upload that failed
 * or was abandoned sat on the system drive for a day and filled it. Six hours
 * is still well past any legitimate "I'll finish the wizard in a minute" gap,
 * and the manual cleanup button covers anyone who wants the space back now.
 */
const IMPORT_TMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Delete UUID subdirectories under DATA_DIR/import-tmp older than the cutoff.
 * These are created by the folder-import wizard upload step and cleaned up
 * automatically when the commit phase completes. If the user abandons the
 * wizard before committing, the dirs accumulate without this sweep.
 *
 * Skipped entirely while an import is running: a commit reading from a staged
 * dir refreshes its mtime as it deletes files, so it would not normally look
 * stale, but a long stall on one huge file could age it past the cutoff and
 * this would delete the very files the running import is about to copy.
 */
export function purgeStaleImportTmp(): PurgeResult {
  if (getImportStatus().running) {
    return { deleted: 0, errors: 0, bytes: 0, skippedActive: 0 };
  }
  const result = purgeImportTmp(IMPORT_TMP_MAX_AGE_MS);
  if (result.deleted > 0) {
    console.log(
      `[library] Purged ${result.deleted} stale import-tmp dir(s)` +
      `${result.errors > 0 ? ` (${result.errors} errors)` : ''}`,
    );
  }
  return result;
}

export function scheduleImportTmpCleanup(): void {
  setInterval(() => { purgeStaleImportTmp(); }, 60 * 60 * 1000);
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

/** Exported for tests (the auto-import watchdog logic lives here); production
 *  code only reaches it via the interval in scheduleAutoImport(). */
export async function tick(): Promise<void> {
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
    const staleSince = getImportLockStartedAt();
    const staleSinceMs = staleSince ? Date.parse(staleSince) : NaN;
    if (!Number.isNaN(staleSinceMs) && Date.now() - staleSinceMs >= STALE_LOCK_MS) {
      forceReleaseStaleLock(
        `Auto-import found the import lock held since ${staleSince} (over 6 hours) with no ` +
        `sign of progress. Force-released it so scheduled imports can resume; the stuck run ` +
        `may have left partial data.`,
      );
      if (!claimImportLock()) {
        log.debug('[auto-import] tick skipped: import lock claimed by another run immediately after watchdog release');
        return;
      }
    } else {
      log.debug('[auto-import] tick skipped: import lock already held');
      return;
    }
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
    if (i > 0 && !claimImportLock()) {
      const skipped = profiles.slice(i).map(p => p.name).join(', ');
      appendImportStatusError(
        `Import lock was claimed by another run before ${skipped} could be synced. They'll be picked up on the next scheduled or manual import.`,
      );
      return;
    }
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
