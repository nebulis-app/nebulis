import { fetchJSON, BASE, authHeaders, errorMessage } from './client';

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

export interface SiteBortleResult {
  bortleClass: number;
  sqm: number;
  /** 'live' when DarkSkySites answered just now, 'cache' when this server had
   *  already looked the same coordinates up within the last day. */
  source: 'live' | 'cache';
}

/**
 * Look the site's light pollution class up from satellite data.
 *
 * Admin only, and the one call in the app that sends the observer's exact
 * coordinates to a third party. The server enforces the admin check as well;
 * the client checks first so a viewer never triggers the request at all. See
 * the Help page and Settings -> Data Sources.
 */
export const lookupSiteBortle = (siteId: string) =>
  fetchJSON<SiteBortleResult>(`/sites/${encodeURIComponent(siteId)}/bortle-lookup`, {
    method: 'POST',
  });

/** Retag an already-imported session to a different observing site.
 *  `siteId: null` clears the tag, so the session goes back to reading its
 *  location out of the capture files (and only then the default site). */
export const reassignSessionSite = (objectId: string, date: string, siteId: string | null) =>
  fetchJSON<{ updated: boolean; siteId: string | null }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/site`,
    { method: 'PUT', body: JSON.stringify({ siteId }) },
  );

/** A picture attached to an observing site (the garden, the skyline, where the tripod stands). */
export interface SitePhoto {
  id: string;
  siteId: string;
  fileName: string;
  mimeType: string;
  size: number;
  caption: string;
  createdAt: string;
}

export const getSitePhotos = (siteId: string) =>
  fetchJSON<SitePhoto[]>(`/sites/${encodeURIComponent(siteId)}/photos`);

/** Readable without a token, so it works as an <img> src. `width` asks for a JPEG preview. */
export const sitePhotoUrl = (photoId: string, width?: number) =>
  `${BASE}/sites/photos/${encodeURIComponent(photoId)}${width ? `?w=${width}` : ''}`;

export async function uploadSitePhoto(siteId: string, file: File, caption = ''): Promise<SitePhoto> {
  const form = new FormData();
  form.append('file', file, file.name);
  if (caption) form.append('caption', caption);
  // fetchJSON forces a JSON content type, which would break the multipart boundary.
  const res = await fetch(`${BASE}/sites/${encodeURIComponent(siteId)}/photos`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(body, res.statusText));
  const data = (body as { data?: SitePhoto }).data;
  if (!data) throw new Error('Upload response had no picture');
  return data;
}

export const updateSitePhotoCaption = (photoId: string, caption: string) =>
  fetchJSON<SitePhoto>(`/sites/photos/${encodeURIComponent(photoId)}`, {
    method: 'PUT',
    body: JSON.stringify({ caption }),
  });

export const deleteSitePhoto = (photoId: string) =>
  fetchJSON<{ deleted: boolean }>(`/sites/photos/${encodeURIComponent(photoId)}`, { method: 'DELETE' });
