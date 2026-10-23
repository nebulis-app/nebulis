/**
 * Explore's selection and ordering, as a pure function: which of the offered
 * objects survive the filters, and in what order they are listed. The route
 * feeds it the whole catalog (or the matches for a search, already in
 * relevance order) plus the site context; the native clients' standalone
 * mode replays the same behaviour in Swift, pinned to this by the golden file
 * `spikes/direct-mode/explore/gen-explore.mts` writes.
 */
import type { DsoEntry } from '../dsoCatalog.js';
import { categoryOf, type ExploreCategoryId } from './categories.js';
import { isShowpiece, showpieceScore } from './showpiece.js';
import { MIN_RAIL_SHOWPIECE, tonightRank } from './rank.js';
import { classifyFit, fitsScope, type FovDeg } from './fit.js';
import { everVisible, type ExploreSiteContext, type TonightIndex } from './visibility.js';

export type ExploreSort = 'best' | 'tonight' | 'bright' | 'large' | 'name';
export type ExploreVisibilityFilter = 'all' | 'here' | 'tonight';

export interface BrowseOptions {
  category: ExploreCategoryId | 'all';
  /** Case-insensitive exact constellation name. */
  constellation?: string;
  notImaged: boolean;
  visibility: ExploreVisibilityFilter;
  fitsOnly: boolean;
  sort: ExploreSort;
  /** A free-text query produced `entries`: keep its relevance order unless a sort was chosen. */
  hasQuery: boolean;
}

export interface BrowseContext {
  site: ExploreSiteContext | null;
  tonight: TonightIndex | null;
  fov: FovDeg | null;
  /** Catalog ids the user has imaged. */
  isImaged: (id: string) => boolean;
}

export function inCategory(entry: DsoEntry, category: ExploreCategoryId | 'all'): boolean {
  if (category === 'all') return true;
  if (category === 'showpieces') return isShowpiece(entry);
  return categoryOf(entry) === category;
}

export function selectAndSort(entries: DsoEntry[], opts: BrowseOptions, ctx: BrowseContext): DsoEntry[] {
  const wantConstellation = opts.constellation?.toLowerCase();
  let list = entries.filter(entry => {
    if (!inCategory(entry, opts.category)) return false;
    if (wantConstellation && (entry.constellation ?? '').toLowerCase() !== wantConstellation) return false;
    if (opts.notImaged && ctx.isImaged(entry.id)) return false;
    if (opts.fitsOnly && ctx.fov && !fitsScope(classifyFit(ctx.fov, entry.majorAxisArcmin))) return false;
    if (ctx.site && opts.visibility !== 'all') {
      if (!everVisible(entry, ctx.site)) return false;
      if (opts.visibility === 'tonight' && !ctx.tonight?.byId.has(entry.id)) return false;
    }
    return true;
  });

  // Search keeps its relevance order unless the caller picked another sort.
  const sort = opts.hasQuery && opts.sort === 'best' ? null : opts.sort;
  if (sort === 'best') list = [...list].sort((a, b) => showpieceScore(b) - showpieceScore(a));
  else if (sort === 'bright') list = [...list].sort((a, b) => (a.magnitude ?? Infinity) - (b.magnitude ?? Infinity));
  else if (sort === 'large') list = [...list].sort((a, b) => (b.majorAxisArcmin ?? 0) - (a.majorAxisArcmin ?? 0));
  else if (sort === 'name') list = [...list].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  else if (sort === 'tonight') {
    // Up tonight first, in the shared "best tonight" order (see rank.ts), then
    // everything else by showpiece score.
    const rank = (e: DsoEntry) => {
      const t = ctx.tonight?.byId.get(e.id);
      return t ? 1000 + tonightRank(t.score, showpieceScore(e)) * 100 : showpieceScore(e);
    };
    list = [...list].sort((a, b) => rank(b) - rank(a));
  }
  return list;
}

/** Tonight's rail: rewarding objects that are up, best first. */
export function bestTonightEntries(all: DsoEntry[], tonight: TonightIndex, limit: number): DsoEntry[] {
  return all
    .filter(e => tonight.byId.has(e.id))
    .map(e => ({ e, rank: tonightRank(tonight.byId.get(e.id)?.score ?? 0, showpieceScore(e)) }))
    // The long tail of well-placed but unremarkable NGCs would otherwise crowd
    // out the genuinely rewarding targets.
    .filter(r => showpieceScore(r.e) >= MIN_RAIL_SHOWPIECE)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(r => r.e);
}
