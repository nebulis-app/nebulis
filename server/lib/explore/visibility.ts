/**
 * Explore's location awareness: what each object does from one observing
 * site, tonight and across the year.
 *
 * Cost control. Three tiers, cheapest first:
 *  - "ever rises above minAlt" is pure geometry (dec + latitude), free, and
 *    applied to whole categories;
 *  - the tonight index runs the planner's own visibilityWindow once per
 *    (site, night) over the whole catalog and is cached;
 *  - the 12-month best window (576 altitude samples) is computed only for
 *    the page of objects actually returned, and cached per object.
 */
import { getPlannerCatalog, type DsoEntry } from '../dsoCatalog.js';
import { maxPossibleAltitude, visibilityWindow } from '../astroCalc.js';
import { computeBestImagingWindow } from '../bestImagingWindow.js';
import { computeBestTonightScore } from '../bestTonightScore.js';

export interface ExploreSiteContext {
  /** Cache identity: the site id, or the transient coordinate id. */
  siteKey: string;
  lat: number;
  lon: number;
  minAlt: number;
  horizonProfile?: number[];
}

export interface TonightEntry {
  /** Geometric peak during the dark window. */
  maxAlt: number;
  /** The planner's composite 0-1 "Best Tonight" score. */
  score: number;
}

export interface TonightIndex {
  start: Date;
  end: Date;
  byId: Map<string, TonightEntry>;
}

const TONIGHT_CACHE_MAX = 8;
const tonightCache = new Map<string, TonightIndex>();

function tonightKey(ctx: ExploreSiteContext, start: Date): string {
  const hp = ctx.horizonProfile ? ctx.horizonProfile.join(',') : '';
  return `${ctx.lat}:${ctx.lon}:${ctx.minAlt}:${hp}:${start.toISOString()}`;
}

/** Everything that clears the site's floor during [start, end], with its
 *  planner score. Mirrors the loop in GET /planner/tonight so Explore and the
 *  Planner agree about what is up. */
export function getTonightIndex(ctx: ExploreSiteContext, start: Date, end: Date): TonightIndex {
  const key = tonightKey(ctx, start);
  const hit = tonightCache.get(key);
  if (hit) return hit;

  const byId = new Map<string, TonightEntry>();
  for (const entry of getPlannerCatalog()) {
    if (maxPossibleAltitude(ctx.lat, entry.dec) < ctx.minAlt) continue;
    const w = visibilityWindow(entry.ra, entry.dec, ctx.lat, ctx.lon, start, end, ctx.minAlt, ctx.horizonProfile);
    if (w.maxAlt < ctx.minAlt || !w.rises) continue;
    const score = computeBestTonightScore({
      maxAlt: w.maxAlt,
      risesAt: w.rises.toISOString(),
      setsAt: w.sets?.toISOString() ?? null,
      magnitude: entry.magnitude,
      maxAltTime: w.maxAltTime?.toISOString() ?? null,
      majorAxisArcmin: entry.majorAxisArcmin,
    }, start, end).total;
    byId.set(entry.id, { maxAlt: Math.round(w.maxAlt * 10) / 10, score });
  }

  const index: TonightIndex = { start, end, byId };
  if (tonightCache.size >= TONIGHT_CACHE_MAX) {
    const oldest = tonightCache.keys().next().value;
    if (oldest !== undefined) tonightCache.delete(oldest);
  }
  tonightCache.set(key, index);
  return index;
}

/** Geometry-only: can this object ever clear the site's floor? */
export function everVisible(entry: DsoEntry, ctx: ExploreSiteContext): boolean {
  return maxPossibleAltitude(ctx.lat, entry.dec) >= ctx.minAlt;
}

export type VisibilityKind = 'tonight' | 'season' | 'low' | 'never';

export interface Visibility {
  kind: VisibilityKind;
  /** Highest altitude the object ever reaches from this latitude. */
  maxAlt: number;
  /** Month labels ("Oct") of the longest run above minAlt, null when never. */
  bestFrom: string | null;
  bestTo: string | null;
  /** Altitude at tonight's peak, when it is up tonight. */
  tonightMaxAlt: number | null;
}

const LOW_MARGIN_DEG = 10;
const windowCache = new Map<string, ReturnType<typeof computeBestImagingWindow>>();
const WINDOW_CACHE_MAX = 4000;

function bestWindow(entry: DsoEntry, ctx: ExploreSiteContext, now: Date) {
  const key = `${entry.id}:${ctx.lat}:${ctx.lon}:${ctx.minAlt}:${now.getFullYear()}-${now.getMonth()}`;
  const hit = windowCache.get(key);
  if (hit) return hit;
  const w = computeBestImagingWindow(entry.ra, entry.dec, ctx.lat, ctx.lon, ctx.minAlt, now);
  if (windowCache.size >= WINDOW_CACHE_MAX) windowCache.clear();
  windowCache.set(key, w);
  return w;
}

export function visibilityFor(
  entry: DsoEntry,
  ctx: ExploreSiteContext,
  tonight: TonightIndex | null,
  now: Date = new Date(),
): Visibility {
  const peak = Math.round(maxPossibleAltitude(ctx.lat, entry.dec) * 10) / 10;
  if (peak < ctx.minAlt) {
    return { kind: 'never', maxAlt: peak, bestFrom: null, bestTo: null, tonightMaxAlt: null };
  }
  const up = tonight?.byId.get(entry.id) ?? null;
  const win = bestWindow(entry, ctx, now);
  const bestFrom = win.windowStart;
  const bestTo = win.windowEnd;
  if (up) return { kind: 'tonight', maxAlt: peak, bestFrom, bestTo, tonightMaxAlt: up.maxAlt };
  if (peak < ctx.minAlt + LOW_MARGIN_DEG) return { kind: 'low', maxAlt: peak, bestFrom, bestTo, tonightMaxAlt: null };
  return { kind: 'season', maxAlt: peak, bestFrom, bestTo, tonightMaxAlt: null };
}
