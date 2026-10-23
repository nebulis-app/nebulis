/**
 * Planner scheduled blocks: client for /api/v1/planned-sessions.
 */
import { fetchJSON } from './client';
import type { FilterBand } from '../moonProximity';

export interface PlannedSession {
  id: number;
  objectId: string;
  objectName: string;
  ra: number;
  dec: number;
  startTime: string;
  endTime: string;
  notes: string;
  /** JSON-serialized mosaic framing saved from the Framing & Mosaic planner
   *  for this scheduled block, or null if none was saved. See FramingModal.tsx. */
  framingSetup: string | null;
  /** What the block will be shot through, for its Moon check. Null = not set
   *  (checked as broadband). Absent from servers that predate it. */
  filterBand?: FilterBand | null;
  /** The filter picked for the block ("D2", "Ha"), or null. */
  filter?: string | null;
  /** 1 when the user marked the block as deliberately skipped. Absent on
   *  rows from servers that predate plan vs actual. */
  skipped?: number;
  /** Plan vs actual, computed by the server from the library on read
   *  (server/lib/planOutcome.ts). Null when it could not be computed. */
  outcome?: PlanOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export type PlanOutcomeStatus = 'upcoming' | 'in_progress' | 'awaiting_import' | 'done' | 'partial' | 'missed' | 'skipped';

export interface PlanOutcome {
  status: PlanOutcomeStatus;
  plannedSec: number;
  achievedSec: number;
  frames: number;
}

export interface PlannedSessionCreate {
  objectId: string;
  objectName: string;
  ra: number;
  dec: number;
  startTime: string;
  endTime: string;
  notes?: string;
  filterBand?: FilterBand | null;
  filter?: string | null;
}

interface PlannedSessionPatch {
  startTime?: string;
  endTime?: string;
  notes?: string;
  /** null clears it. */
  filterBand?: FilterBand | null;
  filter?: string | null;
  framingSetup?: string;
  skipped?: boolean;
}

export const listPlannedSessions = (range?: { from: string; to: string }) => {
  const qs = range ? `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : '';
  return fetchJSON<PlannedSession[]>(`/planned-sessions${qs}`);
};

export const createPlannedSession = (body: PlannedSessionCreate) =>
  fetchJSON<PlannedSession>('/planned-sessions', { method: 'POST', body: JSON.stringify(body) });

export const updatePlannedSession = (id: number, patch: PlannedSessionPatch) =>
  fetchJSON<PlannedSession>(`/planned-sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deletePlannedSession = (id: number) =>
  fetchJSON<{ deleted: boolean }>(`/planned-sessions/${id}`, { method: 'DELETE' });

/** Plan vs actual for one object on one observing night. Mirrors
 *  server/lib/planOutcome.ts PlanNightSummary. */
export interface PlanNightSummary {
  night: string;
  objectId: string;
  objectName: string;
  libraryObjectIds: string[];
  blocks: number;
  plannedSec: number;
  achievedSec: number;
  frames: number;
  status: PlanOutcomeStatus;
}

/** Per-night plan summaries for observing nights in [from, to] (YYYY-MM-DD). */
export const listPlanNights = (from: string, to: string) =>
  fetchJSON<PlanNightSummary[]>(`/planned-sessions/nights?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
