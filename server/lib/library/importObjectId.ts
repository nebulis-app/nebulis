/**
 * The one answer to "which library object is this device folder?" for every import path.
 *
 * The telescope sync used to stop at `resolveCanonicalId(normalizeObjectId(folderName))`, which only knows designations.
 * The folder wizard also reads common names and designations embedded in a longer name. So a Dwarf folder called
 * "California Nebula" became an `Unknown` object named `CaliforniaNebula` through a sync and `NGC1499` through the
 * wizard, and a "Remember this" reclassify redirect was honoured by the wizard and ignored by the next sync.
 *
 * Order:
 *  1. The catalog's own alias resolution, exactly as before.
 *  2. If that did not recognise the name, the wizard's identification (embedded designation, common name). An object
 *     already stored under the unrecognised id keeps it: a library that imported "CaliforniaNebula" before this
 *     existed must not grow a second object on its next sync.
 *  3. A user's reclassify redirect wins over all of it, because it exists to correct a wrong catalog answer.
 */
import db from '../db.js';
import { resolveCanonicalId } from '../catalogAliases.js';
import { normalizeObjectId } from '../telescopeFiles.js';
import { getDesignationRedirect } from './designationRedirects.js';
import { identifyObjectFromFolderName } from './objectIdentification.js';

const objectExists = db.prepare<[string], { one: number }>('SELECT 1 AS one FROM libraryObjects WHERE objectId = ?');

export function resolveImportObjectId(
  rawName: string,
  isKnownObject: (objectId: string) => boolean = id => objectExists.get(id) !== undefined,
): string {
  const normalized = normalizeObjectId(rawName);
  let objectId = resolveCanonicalId(normalized);
  if (objectId === normalized && !isKnownObject(objectId)) {
    const identified = identifyObjectFromFolderName(rawName.trim());
    if (identified) objectId = resolveCanonicalId(identified.targetObjectId);
  }
  return getDesignationRedirect(normalized) ?? getDesignationRedirect(objectId) ?? objectId;
}
