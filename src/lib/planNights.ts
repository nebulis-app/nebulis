import type { PlanNightSummary } from './api/plannedSessions';

/** Plan summaries for one day of the Observations calendar, split into the
 *  ones that match an observation card and the planned-but-not-imaged rest. */
export interface DayPlan {
  /** library object id → summary, for observation cards that were planned. */
  byObject: Map<string, PlanNightSummary>;
  /** Plans with no observation that night (missed, skipped, still to come). */
  unmatched: PlanNightSummary[];
}

/**
 * Index plan summaries by night, matching each to the observations of that
 * night through the library object ids the server resolved. A summary
 * matches an observation when that observation's object is one of its
 * library ids, or (for objects that only exist in the catalog) shares its id.
 */
export function indexPlanByDate(
  summaries: readonly PlanNightSummary[],
  observationObjectIdsByDate: ReadonlyMap<string, readonly string[]>,
): Map<string, DayPlan> {
  const out = new Map<string, DayPlan>();
  for (const s of summaries) {
    let day = out.get(s.night);
    if (!day) {
      day = { byObject: new Map(), unmatched: [] };
      out.set(s.night, day);
    }
    const observed = observationObjectIdsByDate.get(s.night) ?? [];
    const match = observed.find(id => id === s.objectId || s.libraryObjectIds.includes(id));
    if (match) day.byObject.set(match, s);
    else day.unmatched.push(s);
  }
  return out;
}
