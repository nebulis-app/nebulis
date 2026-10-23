/**
 * "Best tonight": the one definition every screen uses (Planner, Explore, and
 * the native clients' standalone mode).
 *
 * Two ingredients, both already 0-1 or capped to it:
 *  - conditions: the planner's own score for how well the object is placed
 *    tonight (altitude, time up, brightness, transit, size);
 *  - worth: how rewarding the object is to shoot (the showpiece score, capped
 *    at 100 so the hand-picked list can't swamp conditions entirely).
 *
 * The blend is the default order of "Best tonight" so a very high but
 * unremarkable galaxy doesn't lead the list. The pure conditions order stays
 * available as "Best conditions" and is just `bestTonightScore`.
 */
export const RANK_CONDITIONS_WEIGHT = 0.55;
export const RANK_WORTH_WEIGHT = 0.45;
/** Objects below this showpiece score are left out of the short "best tonight" rail, never out of a full list. */
export const MIN_RAIL_SHOWPIECE = 40;

/** 0-1: the blend of tonight's conditions score (0-1) and an object's showpiece score. */
export function tonightRank(conditions: number, showpiece: number): number {
  return conditions * RANK_CONDITIONS_WEIGHT + Math.min(1, showpiece / 100) * RANK_WORTH_WEIGHT;
}
