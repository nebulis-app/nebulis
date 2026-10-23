/**
 * The objects Explore leads with, which therefore have to look right with no
 * internet: the hand-picked showpieces plus the top of every category.
 *
 * The default (curated) prefetch used to cover only Messier, about a hundred
 * popular objects and the user's own library, so most of what a category page
 * ranks first (NGC and IC objects, Sharpless nebulae, the Horsehead) could be
 * missing from disk until someone viewed it online. Anything returned here is
 * added to that scope, so one online run leaves the whole front of Explore
 * cached for good.
 */
import { getPlannerCatalog, type DsoEntry } from '../dsoCatalog.js';
import { categoryOf, EXPLORE_CATEGORY_IDS } from './categories.js';
import { isShowpiece, showpieceScore } from './showpiece.js';

/** How many of each category's best objects count as "front of Explore". The
 *  first screens of a category page and the best-tonight rail sit well inside
 *  this. */
export const CORE_PER_CATEGORY = 80;

let cached: DsoEntry[] | null = null;

export function exploreCoreEntries(): DsoEntry[] {
  if (cached) return cached;
  const catalog = getPlannerCatalog();
  const core = new Map<string, DsoEntry>();
  for (const e of catalog) if (isShowpiece(e)) core.set(e.id, e);
  for (const id of EXPLORE_CATEGORY_IDS) {
    if (id === 'showpieces') continue;
    catalog
      .filter(e => categoryOf(e) === id)
      .sort((a, b) => showpieceScore(b) - showpieceScore(a))
      .slice(0, CORE_PER_CATEGORY)
      .forEach(e => core.set(e.id, e));
  }
  cached = [...core.values()];
  return cached;
}
