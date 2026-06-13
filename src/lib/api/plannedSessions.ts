/**
 * Planner scheduled blocks: client for /api/v1/planned-sessions.
 */
import { fetchJSON } from './client';

export interface PlannedSession {
  id: number;
  objectId: string;
  objectName: string;
  ra: number;
  dec: number;
  startTime: string;
  endTime: string;
  notes: string;
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
}

export interface PlannedSessionPatch {
  startTime?: string;
  endTime?: string;
  notes?: string;
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
