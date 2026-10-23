/**
 * Which Explore browse tile an object belongs to, from the type label the wishlist and the Planner carry.
 *
 * Mirrors `categoryOf` in server/lib/explore/categories.ts, which also looks at OpenNGC's type code. Every
 * label the catalog produces maps the same way, and tests/frontend/exploreCategory.test.ts walks the whole
 * catalog to prove it, so "Find similar" lands on the tile the object is actually listed under.
 */
import type { ExploreCategoryId } from './api/explore';

export function exploreCategoryForType(type: string | null | undefined): Exclude<ExploreCategoryId, 'showpieces'> | null {
  const label = (type ?? '').toLowerCase();
  if (!label) return null;
  if (label === 'galaxy pair' || label === 'galaxy triplet' || label === 'galaxy group') return 'galaxy-groups';
  if (label.includes('galaxy')) return 'galaxies';
  if (label.includes('planetary')) return 'planetary-nebulae';
  if (label.includes('supernova')) return 'supernova-remnants';
  if ((label.includes('cluster') && !label.includes('nebula')) || label === 'star cloud') return 'clusters';
  if (label.includes('dark')) return 'dark-reflection';
  if (label.includes('reflection') && !label.includes('emission')) return 'dark-reflection';
  if (label.includes('nebula')) return 'emission-nebulae';
  return null;
}
