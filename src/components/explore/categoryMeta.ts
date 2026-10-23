import type { ExploreCategoryId } from '../../lib/api/explore';

export interface ExploreCategoryMeta {
  id: ExploreCategoryId;
  /** Accent used behind the tile's label when the picture hasn't loaded. */
  tint: string;
}

/** Display order of the browse tiles. */
export const EXPLORE_CATEGORIES: ExploreCategoryMeta[] = [
  { id: 'showpieces',         tint: '#b45309' },
  { id: 'galaxies',           tint: '#1d4ed8' },
  { id: 'emission-nebulae',   tint: '#be123c' },
  { id: 'planetary-nebulae',  tint: '#0f766e' },
  { id: 'supernova-remnants', tint: '#7e22ce' },
  { id: 'clusters',           tint: '#0369a1' },
  { id: 'dark-reflection',    tint: '#475569' },
  { id: 'galaxy-groups',      tint: '#4338ca' },
];

export function categoryMeta(id: string): ExploreCategoryMeta | undefined {
  return EXPLORE_CATEGORIES.find(c => c.id === id);
}
