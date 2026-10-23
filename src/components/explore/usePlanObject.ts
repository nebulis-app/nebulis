import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getPlannerTargets } from '../../lib/api/planner';
import { createPlannedSession, listPlannedSessions } from '../../lib/api/plannedSessions';
import { bestSlotFor } from '../../lib/plannerNight';
import { DEFAULT_BLOCK_MINUTES, MIN_BLOCK_MINUTES, clampTime, minutesBetween, snapToGrid } from '../planner/scheduleGeometry';

export interface PlanTarget {
  objectId: string;
  name: string;
  /** Decimal hours. */
  ra: number;
  /** Decimal degrees. */
  dec: number;
}

export type PlanResult =
  | { ok: true; start: Date; end: Date }
  | { ok: false; reason: 'noWindow' | 'noRoom' | 'failed' };

/**
 * Drops one default-length block for an object into the best free spot of a
 * night's dark window: tonight when `date` is omitted, otherwise that evening
 * (YYYY-MM-DD, as returned by /explore/next-good-nights).
 *
 * Non-destructive by construction: the slot search treats every session
 * already on that night as busy, so an existing plan is worked around rather
 * than replaced, and no Replace/Add/Cancel prompt is needed. Mirrors the
 * Wishlist page's quick-add, which this lets Explore share.
 */
export function usePlanObject(siteId: string | null) {
  const queryClient = useQueryClient();

  return useCallback(async (target: PlanTarget, date?: string): Promise<PlanResult> => {
    try {
      const planner = await queryClient.fetchQuery({
        queryKey: ['planner-targets', 'explore-plan', siteId, date ?? 'tonight'],
        queryFn: () => getPlannerTargets({ ...(siteId ? { siteId } : {}), ...(date ? { date } : {}) }),
        staleTime: 60_000,
      });
      const { nightStart, nightEnd, observerLat, observerLon } = planner;
      if (!nightStart || !nightEnd || observerLat == null || observerLon == null) return { ok: false, reason: 'noWindow' };

      const windowStart = new Date(nightStart);
      const windowEnd = new Date(nightEnd);
      const FIVE = 5 * 60_000;
      const nowMs = Date.now();
      const earliest = nowMs > windowStart.getTime() && nowMs < windowEnd.getTime()
        ? new Date(Math.ceil(nowMs / FIVE) * FIVE)
        : windowStart;

      const existing = await listPlannedSessions({ from: nightStart, to: nightEnd });
      const busy = existing.map(s => ({ start: new Date(s.startTime).getTime(), end: new Date(s.endTime).getTime() }));

      const slot = bestSlotFor({
        ra: target.ra,
        dec: target.dec,
        lat: observerLat,
        lon: observerLon,
        windowStart: earliest,
        windowEnd,
        durationMinutes: DEFAULT_BLOCK_MINUTES,
        busy,
        moonIllumination: planner.moonIllumination,
      });
      if (!slot) return { ok: false, reason: 'noRoom' };

      const start = clampTime(snapToGrid(slot.start), windowStart, windowEnd);
      const end = clampTime(new Date(start.getTime() + DEFAULT_BLOCK_MINUTES * 60_000), windowStart, windowEnd);
      if (minutesBetween(start, end) < MIN_BLOCK_MINUTES) return { ok: false, reason: 'noRoom' };

      await createPlannedSession({
        objectId: target.objectId,
        objectName: target.name,
        ra: target.ra,
        dec: target.dec,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
      await queryClient.invalidateQueries({ queryKey: ['planned-sessions'] });
      return { ok: true, start, end };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }, [queryClient, siteId]);
}
