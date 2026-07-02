import type { CatalogEntry } from '../../types';
import { fetchJSON } from './client';

// Thumbnail URL
export const fetchLocationName = (lat: number, lon: number, signal?: AbortSignal) =>
  fetchJSON<{ city: string | null }>(`/catalog/geocode/reverse?lat=${lat}&lon=${lon}`, signal ? { signal } : undefined)
    .then(r => r.city)
    .catch(() => null);
export const fetchLocationInfo = (lat: number, lon: number) =>
  fetchJSON<{ city: string | null; timezone: string | null }>(`/catalog/geocode/reverse?lat=${lat}&lon=${lon}`)
    .catch(() => ({ city: null, timezone: null }));

export interface GeocodeSearchResult {
  name: string;
  /** "Asheville, North Carolina, United States" */
  label: string;
  latitude: number;
  longitude: number;
  /** IANA zone, e.g. "America/New_York". May be null. */
  timezone: string | null;
  country: string | null;
  admin1: string | null;
}

/** Forward geocode a city/place name to ranked candidates (Open-Meteo). */
export const searchLocations = (q: string) =>
  fetchJSON<GeocodeSearchResult[]>(`/catalog/geocode/search?q=${encodeURIComponent(q)}`)
    .catch(() => [] as GeocodeSearchResult[]);
export const getCatalogEntry = (id: string) => fetchJSON<CatalogEntry>(`/catalog/${encodeURIComponent(id)}`);

// Catalog object info (fetched lazily from library DB / catalogCache / static catalog)
interface CatalogObjectInfo {
  name: string;
  type: string;
  constellation: string;
  magnitude: number | null;
  description: string;
  ra: string | number | null;
  dec: string | number | null;
  distance: string | null;
  distanceLy: number | null;
  size: string | null;
  imageUrl: string;
  wikiUrl: string | null;
  alsoKnownAs: string[];
  override: CatalogOverrideRecord | null;
}
export const getCatalogObjectInfo = (id: string) =>
  fetchJSON<CatalogObjectInfo>(`/catalog/${encodeURIComponent(id)}/info`);

// User-supplied per-field overrides for catalog metadata. Saved fields win
// over the static catalog and library DB. Empty/blank fields clear that
// override (a value of null/empty means "no override for this field").
export interface CatalogOverrideRecord {
  objectId: string;
  name?: string;
  type?: string;
  constellation?: string;
  magnitude?: number;
  description?: string;
  ra?: string;
  dec?: string;
  distanceLy?: number;
  updatedAt: number;
  updatedBy: string | null;
}
export interface CatalogOverrideInput {
  name?: string;
  type?: string;
  constellation?: string;
  magnitude?: number | null;
  description?: string;
  ra?: string;
  dec?: string;
  distanceLy?: number | null;
}
export const saveCatalogOverride = (id: string, patch: CatalogOverrideInput) =>
  fetchJSON<CatalogOverrideRecord>(`/catalog/${encodeURIComponent(id)}/override`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
export const deleteCatalogOverride = (id: string) =>
  fetchJSON<{ removed: boolean }>(`/catalog/${encodeURIComponent(id)}/override`, {
    method: 'DELETE',
  });

// Catalog prefetch job (bulk download of imagery + Wikipedia descriptions)
interface CatalogCacheStats {
  dss2Count: number;
  dss2Bytes: number;
  wikiImageCount: number;
  wikiImageBytes: number;
  caldwellCount: number;
  caldwellBytes: number;
  wikiWithExtract: number;
  wikiNotFound: number;
}
export interface PackStateRow {
  tier: 'messier' | 'caldwell' | 'popular' | 'extended' | 'sharpless';
  version: string;
  installedAt: number;
  objectCount: number;
}

interface CatalogPrefetchStatus {
  running: boolean;
  phase: 'idle' | 'pack' | 'images' | 'wikipedia' | 'caldwell' | 'done' | 'cancelled' | 'error';
  processed: number;
  total: number;
  errors: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string;
  imagesCompletedAt: number | null;
  wikiCompletedAt: number | null;
  caldwellCompletedAt: number | null;
  packCompletedAt: number | null;
  stats: CatalogCacheStats;
  packStates: PackStateRow[];
}
export const getCatalogPrefetchStatus = () =>
  fetchJSON<CatalogPrefetchStatus>('/catalog/prefetch/status');
export const startCatalogPrefetch = (force = false, packsOnly = false) => {
  const params = new URLSearchParams();
  if (force) params.set('force', '1');
  if (packsOnly) params.set('packsOnly', '1');
  const qs = params.size ? `?${params}` : '';
  return fetchJSON<{ started: boolean; reason?: string; status: CatalogPrefetchStatus }>(
    `/catalog/prefetch/start${qs}`,
    { method: 'POST' },
  );
};
export const cancelCatalogPrefetch = () =>
  fetchJSON<{ cancelled: boolean; status: CatalogPrefetchStatus }>(
    '/catalog/prefetch/cancel',
    { method: 'POST' },
  );
export const wipeCatalogCache = () =>
  fetchJSON<{ wiped: boolean; stats: CatalogCacheStats }>(
    '/catalog/prefetch/cache',
    {
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'reinitialize' }),
    },
  );

// Catalog cached sources — what masters are on disk for an object
export type CatalogSource = {
  source: 'hubble' | 'wiki' | 'dss2';
  label: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
};

export const getCatalogSources = (catalogId: string) =>
  fetchJSON<{ id: string; sources: CatalogSource[] }>(
    `/catalog/${encodeURIComponent(catalogId)}/sources`
  );

/** Force a fresh DSS2 fetch for one object — recovers from a prefetch miss
 *  (alasky timeout, transient 5xx) without re-running the whole catalog
 *  prefetch. Resolves when the fetch completes (success or failure). */
export const prefetchCatalogObject = (catalogId: string) =>
  fetchJSON<{ id: string; fetched: boolean; path: string | null }>(
    `/catalog/${encodeURIComponent(catalogId)}/prefetch`,
    { method: 'POST' }
  );
