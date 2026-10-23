/**
 * Dwarf Videos folder: pure helpers shared by the live-sync path
 * (dwarfWalker.ts / import.ts), mirroring dwarfStartrails.ts.
 *
 * A Dwarf's Videos/ folder holds timelapse/short-clip captures that are not
 * observations of any celestial target — each clip is identified only by
 * when it was taken, same as a STARTRAILS capture. The live-sync path folds
 * every video into one shared synthetic library object ("DWARF Videos")
 * instead of inventing an object per clip, reusing the entire existing
 * object/session pipeline: this module only supplies the constants and the
 * one-time metadata patch that pipeline can't derive on its own.
 */
import db from '../db.js';
import { normalizeObjectId } from '../telescopeFiles.js';
import { resolveCanonicalId } from '../catalogAliases.js';
// The folder name and synthetic-object name are Dwarf device facts, owned by
// the walker; re-exported here so every existing importer of this module
// keeps working.
import { VIDEOS_FOLDER, VIDEOS_TARGET_NAME } from '../walkers/dwarfWalker.js';
export { VIDEOS_FOLDER, VIDEOS_TARGET_NAME };

export const VIDEOS_OBJECT_TYPE = 'Timelapse';
export const VIDEOS_DESCRIPTION =
  'Timelapse and short video clips captured directly by the telescope, outside its normal ' +
  'deep-sky imaging sessions. These are not observations of a celestial target, so each entry ' +
  'here groups a period of recorded video rather than a specific object in the sky.';

/** Deterministic id for the one shared synthetic object, derived through the
 *  same normalize/resolve pipeline every real target goes through rather
 *  than a hand-picked literal, so it can never drift from what the import
 *  pipeline actually computes for this target string. */
export function getVideosObjectId(): string {
  return resolveCanonicalId(normalizeObjectId(VIDEOS_TARGET_NAME));
}

/** Apply the curated name/type/constellation/description to the Videos row.
 *  Safe to call on every boot, not just the object's first-ever
 *  `upsertObject.run()`: it always writes the same fixed constants for this
 *  one reserved id, so re-applying them is a no-op once already correct and
 *  self-heals a row created before this patch existed. See
 *  patchStartrailsObjectMeta's own comment for why this can't be left to
 *  upsertObject's COALESCE or to resolveCatalogMeta. */
export function patchVideosObjectMeta(objectId: string): void {
  db.prepare(
    `UPDATE libraryObjects SET objectName = ?, objectType = ?, constellation = ?, description = ? WHERE objectId = ?`,
  ).run(VIDEOS_TARGET_NAME, VIDEOS_OBJECT_TYPE, '', VIDEOS_DESCRIPTION, objectId);
}
