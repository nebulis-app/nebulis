/**
 * Brings the database in line with a library that was just adopted in place.
 *
 * Adopting repoints the library at a folder that already exists, so the rows
 * written for the previous location no longer match what is on disk. This
 * re-registers the files the new location holds, then drops what it does not:
 * objects whose folder is gone go to the trash (restorable, notes and sessions
 * kept) and file rows that point at nothing are deleted.
 *
 * Objects are retired before stale rows are dropped. Dropping rows first zeroes
 * the file count that identifies an object as one that once held files.
 */
import db from '../db.js';
import { log } from '../logger.js';
import { acquireLibraryLock } from '../libraryBusy.js';
import { rebuildFromManifests, backfillLibraryFiles } from './libraryFiles.js';
import { refreshObjectFileCount } from './observations.js';
import { fixMissingObjects, fixStaleRecords, LibraryUnreadableError } from './analyze.js';
import { invalidateAllImagesCache } from './gallery.js';
import { runPostImport } from './postImport.js';

export interface AdoptReconcileResult {
  /** Objects that gained file rows from what the new location holds. */
  registeredObjects: number;
  /** Objects whose folder is not in the new location, moved to the trash. */
  retiredObjects: number;
  /** File rows removed because their file is not in the new location. */
  staleRecordsRemoved: number;
  /** Why the cleanup did not run, or null when it did. */
  skipped: string | null;
}

function objectsWithFiles(): Set<string> {
  return new Set(
    db.prepare<[], { objectId: string }>('SELECT DISTINCT objectId FROM libraryFiles WHERE sourceId IS NULL')
      .all()
      .map(r => r.objectId),
  );
}

export async function reconcileAdoptedLibrary(): Promise<AdoptReconcileResult> {
  const result: AdoptReconcileResult = { registeredObjects: 0, retiredObjects: 0, staleRecordsRemoved: 0, skipped: null };
  const release = acquireLibraryLock('repair');
  if (release === null) {
    result.skipped = 'An import is running. Run the library health repairs once it finishes.';
    return result;
  }
  try {
    const before = objectsWithFiles();
    rebuildFromManifests();
    backfillLibraryFiles();
    const registered = [...objectsWithFiles()].filter(id => !before.has(id));
    for (const id of registered) refreshObjectFileCount(id);
    result.registeredObjects = registered.length;

    try {
      result.retiredObjects = (await fixMissingObjects()).retired;
      result.staleRecordsRemoved = (await fixStaleRecords()).removed;
    } catch (err) {
      // Some paths could not be checked, so "missing" cannot be told from
      // "unreadable" and the repair refuses rather than risk dropping good rows.
      if (!(err instanceof LibraryUnreadableError)) throw err;
      result.skipped = err.message;
    }
    invalidateAllImagesCache();
    if (registered.length > 0) runPostImport({ reason: 'adopt-library', touched: registered });
    log.info({ ...result }, 'adopted library reconciled');
    return result;
  } finally {
    release();
  }
}
