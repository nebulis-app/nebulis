import { fetchJSON } from './client';

export interface ObservationNote {
  id: string;
  objectId: string;
  date: string;
  bortleClass: number | null;
  seeingRating: number | null;
  transparencyRating: number | null;
  moonPhase: string | null;
  moonIllumination: number | null;
  equipment: string;
  notes: string;
  rating: number | null;
  location: string;
  createdAt: string;
  updatedAt: string;
}

export const getNote = (objectId: string, date: string) =>
  fetchJSON<ObservationNote | null>(`/notes/object/${encodeURIComponent(objectId)}/${encodeURIComponent(date)}`);
export const saveNote = (data: Partial<ObservationNote> & { objectId: string; date: string }) =>
  fetchJSON<ObservationNote>('/notes', { method: 'POST', body: JSON.stringify(data) });
export const deleteNote = (id: string) =>
  fetchJSON<{ deleted: boolean }>(`/notes/${id}`, { method: 'DELETE' });
