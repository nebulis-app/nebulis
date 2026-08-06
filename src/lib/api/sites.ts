import { fetchJSON } from './client';

/**
 * Observing sites — the places (and skies) the user observes from. Replaces
 * the single global location: an entry bundles coordinates with the sky
 * settings that apply there (minAlt, horizon profile, visible-sky mask), so
 * "same garden facing north" and "same garden facing south" are two entries
 * sharing coordinates.
 *
 * The server keeps the legacy Settings fields (latitude/longitude/etc.) as a
 * mirror of whichever site is the default, so older code paths that still
 * read those fields keep working untouched.
 */
export interface ObservingSite {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  minAlt: number;
  /** Blocked altitude per 10° azimuth bucket. Length 36. */
  horizonProfile: number[];
  /** 36 azimuth slices × 8 elevation bands. `[]` = no mask drawn (whole sky
   *  treated as visible). */
  visibleSkyMap: boolean[];
  bortleClass: number | null;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface ObservingSiteInput {
  name?: string;
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string;
  minAlt?: number;
  horizonProfile?: number[];
  visibleSkyMap?: boolean[];
  bortleClass?: number | null;
  isDefault?: boolean;
}

export const getSites = () => fetchJSON<ObservingSite[]>('/sites');

export const getSite = (id: string) => fetchJSON<ObservingSite>(`/sites/${encodeURIComponent(id)}`);

export const getActiveSite = () => fetchJSON<ObservingSite>('/sites/active');

export const setActiveSite = (siteId: string | null) =>
  fetchJSON<ObservingSite>('/sites/active', {
    method: 'PUT',
    body: JSON.stringify({ siteId }),
  });

export const createSite = (data: ObservingSiteInput) =>
  fetchJSON<ObservingSite>('/sites', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updateSite = (id: string, data: Partial<ObservingSiteInput>) =>
  fetchJSON<ObservingSite>(`/sites/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const setDefaultSite = (id: string) =>
  fetchJSON<ObservingSite>(`/sites/${encodeURIComponent(id)}/default`, {
    method: 'PUT',
  });

export const deleteSite = (id: string) =>
  fetchJSON<{ deleted: boolean; id: string }>(`/sites/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

/** Retag an already-imported session to a different observing site.
 *  `siteId: null` clears the tag, so the session goes back to reading its
 *  location out of the capture files (and only then the default site). */
export const reassignSessionSite = (objectId: string, date: string, siteId: string | null) =>
  fetchJSON<{ updated: boolean; siteId: string | null }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/site`,
    { method: 'PUT', body: JSON.stringify({ siteId }) },
  );
