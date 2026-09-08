/**
 * Dwarf STARTRAILS folder: pure helpers shared by the live-sync path
 * (dwarfWalker.ts / import.ts) and the manual folder-import wizard
 * (folderScan.ts / commitFolderImport in import.ts).
 *
 * A Dwarf's STARTRAILS/ folder holds star-trail captures that are not
 * observations of any celestial target — each capture is identified only by
 * when it was taken. Both import paths fold every STARTRAILS capture into
 * one shared synthetic library object ("DWARF Star Trails") instead of
 * inventing an object per capture, reusing the entire existing
 * object/session pipeline: this module only supplies the constants and the
 * one-time metadata patch that pipeline can't derive on its own.
 */
import db from '../db.js';
import { normalizeObjectId } from '../telescopeFiles.js';
import { resolveCanonicalId } from '../catalogAliases.js';
// The folder name and synthetic-object name are Dwarf device facts, owned by
// the walker; re-exported here so every existing importer of this module
// keeps working.
import { STARTRAILS_FOLDER, STARTRAILS_TARGET_NAME } from '../walkers/dwarfWalker.js';
export { STARTRAILS_FOLDER, STARTRAILS_TARGET_NAME };

export const STARTRAILS_OBJECT_TYPE = 'Star Trails';
export const STARTRAILS_DESCRIPTION =
  'Star Trails captures show the apparent motion of the night sky as Earth rotates, ' +
  'created by combining a series of exposures taken over an extended period into long, ' +
  'continuous arcs of stars across the image. Depending on the direction of the camera, ' +
  'the trails may circle the celestial poles or sweep across the sky, revealing the ' +
  'rotation of the Earth against the background of stars. These images can also capture ' +
  'the changing brightness and color of individual stars, and other features of the night ' +
  'sky visible during the exposure sequence. Each entry here represents one period of time ' +
  'spent imaging the sky, preserving both the resulting trails and the progression of the ' +
  'stars throughout the session.';

export function isStartrailsFolder(name: string): boolean {
  return name.toLowerCase() === STARTRAILS_FOLDER.toLowerCase();
}

/** Deterministic id for the one shared synthetic object, derived through the
 *  same normalize/resolve pipeline every real target goes through rather
 *  than a hand-picked literal, so it can never drift from what the import
 *  pipeline actually computes for this target string. */
export function getStartrailsObjectId(): string {
  return resolveCanonicalId(normalizeObjectId(STARTRAILS_TARGET_NAME));
}

/** Apply the curated name/type/constellation/description to the Star Trails
 *  row. Safe to call on every import, not just the object's first-ever
 *  `upsertObject.run()`: it always writes the same fixed constants for this
 *  one reserved id, so re-applying them is a no-op once already correct and
 *  self-heals a row created before this patch existed (or before a given
 *  field, like constellation, was added to it) without needing a migration.
 *  `upsertObject`'s own COALESCE can't do this self-heal on its own — it only
 *  fills a NULL, and resolveCatalogMeta leaves it nothing to fill, since it
 *  returns non-null placeholders ('Unknown', '') for any id it doesn't
 *  recognize. Star Trails isn't a deep-sky object, so it has no constellation;
 *  the column is cleared to '' rather than left holding that placeholder. */
export function patchStartrailsObjectMeta(objectId: string): void {
  db.prepare(
    `UPDATE libraryObjects SET objectName = ?, objectType = ?, constellation = ?, description = ? WHERE objectId = ?`,
  ).run(STARTRAILS_TARGET_NAME, STARTRAILS_OBJECT_TYPE, '', STARTRAILS_DESCRIPTION, objectId);
}
