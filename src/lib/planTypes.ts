/**
 * Shared types for "Plan My Night" — the scheduling algorithm itself now runs
 * server-side (POST /planner/plan, see lib/api/planner.ts) so every client
 * agrees on the result. These are just the shapes the UI renders.
 */
import type { FilterBand, MoonVerdict } from './moonProximity';

export type AutoPlanFocus = 'all' | 'galaxies' | 'nebulae' | 'clusters';

/** Structural subset of a deep-sky object the planner engine needs. Both the
 *  planner's PlannerTarget and a catalog progress object satisfy this. */
export interface PlanCandidate {
  id: string;
  name: string;
  type: string;
  ra: number;
  dec: number;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  constellation: string | null;
  commonNames: string[];
  isAlreadyImaged: boolean;
  /** Per-filter integration goals, sent with `favorGoals`. */
  goals?: PlanGoal[];
}

/** Mirrors server/lib/autoPlan.ts GoalProgress. */
export interface PlanGoal {
  /** Canonical filter name; null = the "no filter" goal. */
  filter: string | null;
  goalSec: number;
  remainingSec: number;
}

export interface PlanBlock {
  target: PlanCandidate;
  start: Date;
  end: Date;
  meanAlt: number;
  moonSeparation: number;
  moonVerdict: MoonVerdict;
  /** Filter type the plan assumed for the block (from the object type);
   *  absent from servers that predate it. */
  filterBand?: FilterBand;
  /** With favorGoals, the goal filter picked for the block (null = the "no
   *  filter" goal); absent for objects without goals. */
  filter?: string | null;
  /** Time left on that filter before the block, in seconds. */
  filterRemainingSec?: number;
  /** Forecast for the block when the plan was built with the forecast. */
  sky?: PlanSkyQuality | null;
}

/** Mirrors server/lib/skyQuality.ts SlotSkyQuality. */
export interface PlanSkyQuality {
  cloudCover: number;
  /** 1 (best) – 5 */
  seeing: number | null;
  /** 1 (clearest) – 8 */
  transparency: number | null;
  dewRisk: boolean;
  usable: boolean;
}

/** Weather summary POST /planner/plan returns in the envelope's meta. */
export interface PlanWeatherSummary {
  requested: boolean;
  /** False when no forecast could be had; the plan then ignores weather. */
  used: boolean;
  forecastFetchedAt: string | null;
  maxCloudCover: number;
  skippedSlots: { start: Date; end: Date; cloudCover: number }[];
}

/** Goals summary POST /planner/plan returns in the envelope's meta. */
export interface PlanGoalsSummary {
  requested: boolean;
  /** Objects left out because every goal on them is reached. */
  complete: { id: string; name: string }[];
}
