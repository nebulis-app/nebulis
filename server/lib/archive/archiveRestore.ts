/**
 * Bringing archived files back into the library.
 *
 * The mirror of `archiveLocalRemoval`, and the second of the two write paths the
 * contract ranked as risks. Restore writes *into* `getLibraryDir()`, so it inherits
 * the containment discipline the four audit criticals were about, plus two of its
 * own:
 *
 *   - **It never overwrites differing local content silently.** A file that is
 *     already there and matches is left alone, which is what makes restore
 *     idempotent. A file that is already there and *differs* is reported as a
 *     conflict and skipped unless the caller confirmed overwriting for the whole
 *     call. The user's local edit is never the thing that loses by default.
 *   - **It never writes through something that is not a regular file.** A symlink
 *     in the target's place would send the write wherever it points, outside the
 *     library. That is refused outright, with or without confirmation.
 *
 * Writes go through `copyFileVerified`, the same function the copy engine uses, so a
 * restore is written to a `.part` name and verified before it takes its final one:
 * an interrupted restore cannot leave a half-written file wearing a real name.
 *
 * Restore never modifies the archive. There is no code path here that unlinks or
 * writes anything under the archive root.
 */

import fsp from 'fs/promises';
import path from 'path';

import db from '../db.js';
import { getLibraryObjectNames, resolveContainedObjectDir, stmts as objectStmts } from '../library/objects.js';
import { isReservedObjectDir } from '../library/libraryLayout.js';
import { rootFolderPathFor } from './archiveLocalCopy.js';
import { observingNightDate, parseFilename } from '../telescopeFiles.js';
import { recordLibraryFile, resolverFor } from '../library/libraryFiles.js';
import { refreshObjectFileCount } from '../library/observations.js';
import { resolveContainedArchivePath } from './archivePath.js';
import { ensureArchiveDestinationReady } from './archiveDestination.js';
import { readArchiveManifest } from './archiveManifest.js';
import { ensureObjectForArchivedFolder } from './archiveRestoreObjects.js';
import { copyFileVerified, sweepStaleParts, verifyArchivedCopy } from './archiveCopy.js';
import type { ArchiveConfig } from './archiveConfig.js';

export interface RestoreRequest {
  folderName: string;
  /** Path relative to the object folder, as recorded in the manifest. */
  relPath: string;
}

export interface RestoreOptions {
  /** Explicit confirmation to replace local files whose contents differ. Off by
   *  default, because the alternative failure is destroying an edit. */
  overwrite?: boolean;
}

export interface RestoreResult {
  ran: boolean;
  restored: number;
  /** Already present locally with matching contents. */
  skipped: number;
  bytesRestored: number;
  /** Files left alone because they differ locally and overwriting was not confirmed. */
  conflicts: string[];
  failures: string[];
  /** Objects the library did not have, created from the archive's record of them. */
  createdObjects: number;
  /** Objects brought back from the trash. */
  revivedObjects: number;
  /** Objects that received at least one file: what the post-import pipeline should visit. */
  writtenObjects: string[];
}

const siblingTelescopeStmt = db.prepare<[string, number, string], { telescopeId: string }>(
  'SELECT telescopeId FROM libraryFiles WHERE objectId = ? AND substr(relPath, 1, ?) = ? AND telescopeId IS NOT NULL LIMIT 1',
);

/**
 * The row fields a restored file can be given so it reads like an imported one.
 *
 * The archive holds bytes and a path, not the import's bookkeeping, so this rebuilds
 * what can be known:
 *   - `bytes`, from the archived file (the upsert used to zero it),
 *   - the capture date and time from the filename, falling back to the session
 *     folder's date for a name that carries none,
 *   - the telescope, from another file of the same night, which came from the same
 *     rig.
 * What cannot be recovered is a night the user pinned by hand (`sessionDateOverride`);
 * the restore dialog says so.
 */
function restoredRowFields(
  objectId: string,
  folderName: string,
  sessionFolder: string | null,
  fileName: string,
  bytes: number,
): { bytes: number; captureDate: string | null; captureTime: string | null; telescopeId: string | null } {
  const parsed = parseFilename(fileName);
  let captureDate: string | null = parsed.date ?? null;
  let captureTime: string | null = parsed.timestamp ? parsed.timestamp.slice(-6) : null;
  if (captureDate === null && sessionFolder !== null && /^\d{4}-\d{2}-\d{2}/.test(sessionFolder)) {
    captureDate = sessionFolder.slice(0, 10);
    captureTime = null;
  }

  let telescopeId: string | null = null;
  if (sessionFolder !== null) {
    const prefix = `${folderName}/${sessionFolder}/`;
    telescopeId = siblingTelescopeStmt.get(objectId, prefix.length, prefix)?.telescopeId ?? null;
  }
  return { bytes, captureDate, captureTime, telescopeId };
}

/** Where a recorded file would live locally, or null unless it is a strict
 *  descendant of its own object folder. */
function localPathFor(objectId: string, objDir: string, relPath: string): string | null {
  const segments = relPath.split('/');
  if (segments.length === 0 || segments.some(s => s === '' || s === '.' || s === '..')) return null;
  const abs = resolveContainedObjectDir(objectId, ...segments);
  if (!abs || !abs.startsWith(objDir + path.sep)) return null;
  return abs;
}

export async function restoreArchivedFiles(
  config: ArchiveConfig,
  requests: RestoreRequest[],
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const didNotRun: RestoreResult = {
    ran: false,
    restored: 0,
    skipped: 0,
    bytesRestored: 0,
    conflicts: [],
    failures: [],
    createdObjects: 0,
    revivedObjects: 0,
    writtenObjects: [],
  };

  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) return { ...didNotRun, failures: [readiness.warning] };
  const root = readiness.root;

  const manifest = readArchiveManifest(root, config.archiveId);
  const objectIdByFolder = new Map<string, string>();
  for (const object of getLibraryObjectNames()) objectIdByFolder.set(object.folderName, object.objectId);

  // An object the library no longer has is brought back (from the trash) or created,
  // once per folder, so the loop below finds somewhere to put its files.
  const failures: string[] = [];
  let createdObjects = 0;
  let revivedObjects = 0;
  const refusedFolders = new Map<string, string>();
  for (const folderName of new Set(requests.map(r => r.folderName))) {
    if (objectIdByFolder.has(folderName)) continue;
    const outcome = ensureObjectForArchivedFolder(folderName, manifest.objects[folderName]);
    if (outcome.kind === 'created' || outcome.kind === 'revived') {
      objectIdByFolder.set(folderName, outcome.objectId);
      if (outcome.kind === 'created') createdObjects++;
      else revivedObjects++;
    } else if (outcome.kind === 'refused') {
      refusedFolders.set(folderName, outcome.reason);
    }
  }

  // Abandoned `.part` files from an earlier interrupted restore, next to the files this
  // call is about to write. Resolved the same way the loop below resolves them.
  const targets: string[] = [];
  for (const request of requests) {
    const objectId = objectIdByFolder.get(request.folderName);
    const objDir = objectId ? resolveContainedObjectDir(objectId) : null;
    const target = objectId
      ? (objDir ? localPathFor(objectId, objDir, request.relPath) : null)
      : manifest.objects[request.folderName]?.objectId === '' ? rootFolderPathFor(request.folderName, request.relPath) : null;
    if (target !== null) targets.push(target);
  }
  await sweepStaleParts(targets);

  const conflicts: string[] = [];
  const writtenObjects = new Set<string>();
  const touchedObjects = new Set<string>();
  let restored = 0;
  let skipped = 0;
  let bytesRestored = 0;

  const objects = new Map<string, ReturnType<typeof resolverFor>>();
  const identityFor = (objectId: string): ReturnType<typeof resolverFor> => {
    const existing = objects.get(objectId);
    if (existing) return existing;
    const created = resolverFor(objectId);
    objects.set(objectId, created);
    return created;
  };
  /** Recorded during this call, since the resolver's snapshot predates it. */
  const recordedThisCall = new Set<string>();

  for (const request of requests) {
    const label = `${request.folderName}/${request.relPath}`;

    const objectId = objectIdByFolder.get(request.folderName);
    // A top-level library folder that is not an object (`_archive/` calibration frames, `RESTACKED/`) is recorded
    // with an empty object id. It restores to the same place in the library, but has no rows to keep in step.
    const isRootFolder = objectId === undefined && manifest.objects[request.folderName]?.objectId === '';
    if (objectId === undefined && !isRootFolder) {
        const reason = refusedFolders.get(request.folderName);
      failures.push(`${label}: ${reason ?? 'that object is not in the local library.'}`);
      continue;
    }

    const objDir = objectId === undefined ? null : resolveContainedObjectDir(objectId);
    if (objectId !== undefined && !objDir) {
      failures.push(`${label}: its folder does not resolve inside the library.`);
      continue;
    }

    const recordedFile = manifest.objects[request.folderName]?.files.find(f => f.relPath === request.relPath);
    if (!recordedFile) {
      failures.push(`${label}: not in the archive record.`);
      continue;
    }

    const localAbs = objectId !== undefined && objDir
      ? localPathFor(objectId, objDir, request.relPath)
      : rootFolderPathFor(request.folderName, request.relPath);
    if (localAbs === null) {
      // A manifest is a file on a removable disk, so its paths are untrusted
      // input. `..` must not steer a write at a sibling object or anywhere else.
      failures.push(`${label}: would land outside the object folder.`);
      continue;
    }

    const archivedAbs = resolveContainedArchivePath(root, request.folderName, ...request.relPath.split('/'));
    if (archivedAbs === null) {
      failures.push(`${label}: the archived path is outside the archive root.`);
      continue;
    }

    let archivedStat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      archivedStat = await fsp.lstat(archivedAbs);
    } catch {
      failures.push(`${label}: the archived copy is missing.`);
      continue;
    }
    if (!archivedStat.isFile()) {
      failures.push(`${label}: the archived copy is not a regular file.`);
      continue;
    }

    let localStat: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
    try {
      localStat = await fsp.lstat(localAbs);
    } catch {
      localStat = null;
    }

    if (localStat !== null) {
      if (!localStat.isFile()) {
        failures.push(`${label}: something that is not a regular file is already there.`);
        continue;
      }
      if ((await verifyArchivedCopy(archivedAbs, localAbs)).ok) {
        skipped++;
        continue;
      }
      if (options.overwrite !== true) {
        conflicts.push(label);
        continue;
      }
    }

    const outcome = await copyFileVerified(archivedAbs, localAbs, archivedStat.size);
    if (!outcome.ok) {
      failures.push(`${label}: ${outcome.error ?? 'could not be restored'}`);
      continue;
    }

    restored++;
    bytesRestored += archivedStat.size;
    if (objectId !== undefined) writtenObjects.add(objectId);

    // Only record a file the library does not already know about.
    //
    // `recordLibraryFile` is an upsert that carries neither this file's byte count nor
    // its capture date and time, so calling it over an existing row zeroes `bytes` and
    // replaces a recorded capture date with one reparsed from the filename. The intent
    // here is "the library should know about this file", and an existing row already
    // satisfies it. The resolver snapshot is taken before this loop, so a file recorded
    // earlier in the same call is tracked separately.
    //
    // Nothing is recorded for a folder that is not an object, nor for a file in an object's `processed/` (or other
    // reserved) folder: processed images are tracked in their own table, and a library row would make the folder
    // look like a session.
    if (objectId === undefined) continue;
    if (isReservedObjectDir(request.relPath.split('/')[0]) && request.relPath.includes('/')) {
      touchedObjects.add(objectId);
      continue;
    }
    const identity = identityFor(objectId);
    const key = `${objectId}/${request.relPath}`;
    if (!identity.has(request.relPath) && !recordedThisCall.has(key)) {
      const segments = request.relPath.split('/');
      const sessionFolder = segments.length > 1 ? segments[0] : null;
      const fileName = segments[segments.length - 1];
      const fields = restoredRowFields(objectId, request.folderName, sessionFolder, fileName, archivedStat.size);
      recordLibraryFile({
        objectId,
        folderName: request.folderName,
        sessionFolder,
        fileName,
        ...fields,
        // The role the record already holds. A non-subframe is left for the library to
        // classify from its filename rather than guessed here.
        role: recordedFile.isSubframe ? 'sub' : undefined,
      });
      recordedThisCall.add(key);
      // The Library grid and the observation lists read session rows, not file rows,
      // so a night whose row went away would show no sessions for a file that is back.
      if (fields.captureDate !== null) {
        objectStmts.addSession.run(objectId, observingNightDate(fields.captureDate, fields.captureTime));
      }
    }
    touchedObjects.add(objectId);
  }

  for (const objectId of touchedObjects) refreshObjectFileCount(objectId);

  return {
    ran: true, restored, skipped, bytesRestored, conflicts, failures,
    createdObjects, revivedObjects, writtenObjects: [...writtenObjects],
  };
}
