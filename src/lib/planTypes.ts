/**
 * Shared types for "Plan My Night" — the scheduling algorithm itself now runs
 * server-side (POST /planner/plan, see lib/api/planner.ts) so every client
 * agrees on the result. These are just the shapes the UI renders.
 */
import type { MoonVerdict } from './moonProximity';

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
}

export interface PlanBlock {
  target: PlanCandidate;
  start: Date;
  end: Date;
  meanAlt: number;
  moonSeparation: number;
  moonVerdict: MoonVerdict;
}
