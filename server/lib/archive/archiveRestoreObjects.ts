/**
 * Giving a restore somewhere to put files when the library no longer has the object.
 *
 * An archive keeps the folder name and the object id of everything it holds, so a
 * restore can bring an object back rather than refusing it: revive it from the
 * trash, or create it. Creating only writes the row and the layout. The files come
 * from the restore loop, and enrichment, thumbnails and weather from the post-import
 * pipeline the route hands off to, the same as any other path that adds files.
 *
 * The manifest is a file on a removable disk, so both names in it are untrusted. A
 * name that could steer a write outside the library, or that collides with another
 * object, is refused here and the restore reports it.
 */

import { stmts as objectStmts, resolveCatalogMeta } from '../library/objects.js';
import { setObjectLayout, isReservedObjectDir, type LibraryLayout } from '../library/libraryLayout.js';
import { isReservedLibraryDir } from '../library/archiveFolders.js';
import type { ArchiveManifestObject } from './archiveManifest.js';

const MAX_NAME_LENGTH = 255;

/** True for a name that is one plain path segment: no separators, no dot segments,
 *  no control characters. */
function isPlainName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (name === '.' || name === '..') return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  return !/[\\/\u0000-\u001f]/.test(name);
}

/**
 * The object an archive folder would be restored as, or null when the folder is not
 * an object (a root folder such as `RESTACKED/`, recorded with an empty id) or its
 * names cannot be trusted.
 */
export function archivedObjectIdentity(
  folderName: string,
  entry: ArchiveManifestObject | undefined,
): { objectId: string } | null {
  if (!entry || entry.objectId === '') return null;
  if (!isPlainName(folderName) || !isPlainName(entry.objectId)) return null;
  if (isReservedLibraryDir(folderName) || isReservedObjectDir(folderName)) return null;
  return { objectId: entry.objectId };
}

/** Flat unless some file sits inside a session folder, which is how every nested
 *  object is shaped. `processed/` and the other reserved folders do not count. */
function layoutFromFiles(entry: ArchiveManifestObject): LibraryLayout {
  const nested = entry.files.some(f => {
    const segments = f.relPath.split('/');
    return segments.length > 1 && !isReservedObjectDir(segments[0]);
  });
  return nested ? 'nested' : 'flat';
}

export type EnsureObjectOutcome =
  | { kind: 'present' }
  | { kind: 'revived'; objectId: string }
  | { kind: 'created'; objectId: string }
  | { kind: 'refused'; reason: string };

/**
 * Make sure the library has an object for this archive folder, bringing it back from
 * the trash or creating it. Does nothing for a folder that already has a live object.
 */
export function ensureObjectForArchivedFolder(
  folderName: string,
  entry: ArchiveManifestObject | undefined,
): EnsureObjectOutcome {
  const identity = archivedObjectIdentity(folderName, entry);
  if (identity === null || entry === undefined) {
    return { kind: 'refused', reason: 'that object is not in the local library.' };
  }
  const { objectId } = identity;

  const byId = objectStmts.getObject.get(objectId);
  if (byId) {
    if (byId.folderName !== folderName) {
      return { kind: 'refused', reason: `the library already stores ${objectId} in a different folder (${byId.folderName}).` };
    }
    if (!byId.deleted) return { kind: 'present' };
    objectStmts.restoreObject.run(objectId);
    return { kind: 'revived', objectId };
  }

  // Another object may already use this folder name.
  const byFolder = objectStmts.getObjectByFolderName.get(folderName);
  if (byFolder) {
    return { kind: 'refused', reason: `the folder is already used by ${byFolder.objectId}.` };
  }

  const cat = resolveCatalogMeta(objectId);
  objectStmts.upsertObject.run(
    objectId, folderName, 0, new Date().toISOString(), 0, null,
    cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
    cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy,
  );
  setObjectLayout(objectId, layoutFromFiles(entry));
  return { kind: 'created', objectId };
}
