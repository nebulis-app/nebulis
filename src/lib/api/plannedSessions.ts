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
  createdAt: string;
  updatedAt: string;
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
