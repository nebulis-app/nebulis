/**
 * The planner's drag payloads, and the guard that reads them back.
 *
 * dnd-kit types `active.data.current` as `Record<string, unknown> | undefined`
 * because any draggable on the page may have put anything there. The two
 * producers (LibraryRow and ScheduledImagingBlock) and the consumer
 * (PlannerPage's drag handlers) therefore need a shared contract, plus a
 * runtime check on the way out: a third draggable added later would otherwise
 * reach the handlers as a half-filled object and schedule a session at NaN.
 */

/** A catalog target dragged off the library panel onto the timeline. */
export interface LibraryDragData {
  kind: 'library';
  objectId: string;
  objectName: string;
  ra: number;
  dec: number;
}

/** An already-scheduled block being dragged to a new time. */
export interface BlockDragData {
  kind: 'block';
  sessionId: number;
}

export type PlannerDragData = LibraryDragData | BlockDragData;

/**
 * Narrow dnd-kit's untyped drag payload to a PlannerDragData, or null if it is
 * missing, from a foreign draggable, or malformed. ra/dec must be finite:
 * scheduling against NaN coordinates silently produces a block that no
 * visibility calculation can score.
 */
export function parsePlannerDragData(value: Record<string, unknown> | undefined): PlannerDragData | null {
  if (!value) return null;
  const { kind } = value;

  if (kind === 'block') {
    const { sessionId } = value;
    if (typeof sessionId !== 'number' || !Number.isFinite(sessionId)) return null;
    return { kind: 'block', sessionId };
  }

  if (kind === 'library') {
    const { objectId, objectName, ra, dec } = value;
    if (typeof objectId !== 'string' || objectId === '') return null;
    if (typeof objectName !== 'string') return null;
    if (typeof ra !== 'number' || !Number.isFinite(ra)) return null;
    if (typeof dec !== 'number' || !Number.isFinite(dec)) return null;
    return { kind: 'library', objectId, objectName, ra, dec };
  }

  return null;
}
