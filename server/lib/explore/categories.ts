/**
 * Explore's browse groups: presentation buckets over the catalog's own
 * type labels. One table, server-side, so every client groups objects the
 * same way (web, and later iOS / Android / Mac).
 */
import type { DsoEntry } from '../dsoCatalog.js';

export const EXPLORE_CATEGORY_IDS = [
  'showpieces',
  'galaxies',
  'galaxy-groups',
  'emission-nebulae',
  'planetary-nebulae',
  'supernova-remnants',
  'dark-reflection',
  'clusters',
] as const;
export type ExploreCategoryId = (typeof EXPLORE_CATEGORY_IDS)[number];

export function isExploreCategoryId(v: string): v is ExploreCategoryId {
  return (EXPLORE_CATEGORY_IDS as readonly string[]).includes(v);
}

/** Which non-showpiece bucket an entry belongs to; `null` when it fits none
 *  (a lone double star, "Other"). Showpieces is a separate, cross-cutting list. */
export function categoryOf(entry: DsoEntry): Exclude<ExploreCategoryId, 'showpieces'> | null {
  const code = entry.typeCode;
  const label = entry.type.toLowerCase();
  if (code === 'GPair' || code === 'GTrpl' || code === 'GGroup') return 'galaxy-groups';
  if (code === 'G' || label.includes('galaxy')) return 'galaxies';
  if (code === 'PN' || label.includes('planetary')) return 'planetary-nebulae';
  if (code === 'SNR' || label.includes('supernova')) return 'supernova-remnants';
  if (code === 'OCl' || code === 'GCl' || code === '*Ass' || label.includes('cluster') && !label.includes('nebula') || label === 'star cloud') return 'clusters';
  if (code === 'DrkN' || label.includes('dark')) return 'dark-reflection';
  if (code === 'RfN' || (label.includes('reflection') && !label.includes('emission'))) return 'dark-reflection';
  if (code === 'EmN' || code === 'HII' || code === 'Cl+N' || code === 'Neb' || label.includes('nebula')) return 'emission-nebulae';
  return null;
}
