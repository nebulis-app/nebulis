/**
 * Pictures that can never be plate solved, so no one should spend a solver run (up to ninety seconds of blind search)
 * on them: the Sun, Moon and planets have no stars in frame to match, scenery is a landscape, and star trails are
 * ten-second frames of an apparent-motion effect with no target.
 */
import { SOLAR_SYSTEM_CATALOG } from '../../data/solar-system-catalog.js';
import { getStartrailsObjectId } from '../library/dwarfStartrails.js';

/** Seestar capture-mode folders, which are not catalog objects: "lunar_photo", "scenery_video" and so on. */
const MODE_FOLDERS = ['solar', 'lunar', 'planetary', 'scenery'].flatMap(mode =>
  ['photo', 'photos', 'video', 'videos'].map(suffix => `${mode}_${suffix}`));

/** Lowercase object ids, for matching against `libraryFiles.objectId` lowercased. */
export const UNSOLVABLE_OBJECT_IDS: readonly string[] = [
  getStartrailsObjectId(),
  ...SOLAR_SYSTEM_CATALOG.map(e => e.id),
  ...MODE_FOLDERS,
].map(id => id.toLowerCase());

const UNSOLVABLE_SET = new Set(UNSOLVABLE_OBJECT_IDS);

export function isUnsolvableObject(objectId: string | null | undefined): boolean {
  return !!objectId && UNSOLVABLE_SET.has(objectId.toLowerCase());
}
