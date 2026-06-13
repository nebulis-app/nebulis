import { fetchJSON } from './client';
import type { ObservationNote } from './notes';

interface ObservationSummary {
  id: string;
  objectId: string;
  objectName: string;
  catalogId: string;
  type: string;
  constellation: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  fileCount: number;
  stackedCount: number;
  fitsCount: number;
  thumbnailUrl: string;
  ra: string | null;
  dec: string | null;
  hasNotes: boolean;
  telescopeId: string | null;
}

export interface ObservationDetail extends ObservationSummary {
  files: import('../../types').SessionFile[];
  note: ObservationNote | null;
  coordinates: { lat: number; lon: number } | null;
  magnitude: number | null;
  distanceLy: number | null;
  description: string;
  wikiUrl: string | null;
  sizeArcmin: string | null;
  weather: import('../../types').SessionWeather | null;
  sessionImage: string | null;
  telescopeId: string | null;
}

export const getObservations = () => fetchJSON<ObservationSummary[]>('/library/observations');
export const getObservationDetail = (objectId: string, date: string) =>
  fetchJSON<ObservationDetail>(`/library/observations/${encodeURIComponent(objectId)}/${encodeURIComponent(date)}`);

// Object info (from public datasource)
interface ObjectInfoData {
  name: string;
  type: string;
  constellation: string;
  magnitude: number | null;
  description: string;
  ra: string | null;
  dec: string | null;
  distance: string | null;
  size: string | null;
  imageUrl: string | null;
  wikiUrl: string | null;
}
export const getObjectInfo = (objectId: string) =>
  fetchJSON<ObjectInfoData>(`/catalog/${encodeURIComponent(objectId)}/info`);

// Satellite trail detection
export interface SatelliteTrailResult {
  trailDetected: boolean;
  angleDegrees?: number;
  lengthPixels?: number;
  confidence?: number;
  profileWidth?: number;
  midpoint?: { x: number; y: number };
  exposureStart?: string;   // ISO UTC — DATE-OBS from FITS header
  exposureSeconds?: number;
  candidates?: Array<{
    satellite: string;
    noradId: number;
    crossingTimeUTC: string;
    angularDistanceFromCenter: number;
    velocityDegPerSec: number;
    matchScore: number;
    duringExposure: boolean; // crossed within the actual exposure window
  }>;
  /** True when identification was skipped because no observer location is available
   *  (not in FITS headers, not in app settings, no override supplied). */
  locationRequired?: boolean;
  missingHeaders?: string[];
  nearMissFallback?: boolean;
  tleArchiveUnavailable?: boolean;
}
export const detectSatelliteTrail = (filePath: string, skipCache = false, overrideLat?: number, overrideLon?: number) =>
  fetchJSON<SatelliteTrailResult>('/satellite/detect', {
    method: 'POST',
    body: JSON.stringify({ filePath, skipCache, overrideLat, overrideLon }),
  });

export const identifySatellites = (filePath: string, overrideLat?: number, overrideLon?: number) =>
  fetchJSON<SatelliteTrailResult>('/satellite/detect', {
    method: 'POST',
    body: JSON.stringify({ filePath, identifyOnly: true, overrideLat, overrideLon }),
  });
export const getCachedSatelliteResults = (filePaths: string[]) =>
  fetchJSON<Record<string, SatelliteTrailResult>>('/satellite/results', {
    method: 'POST',
    body: JSON.stringify({ filePaths }),
  });

export const clearSatelliteCache = () =>
  fetchJSON<{ cleared: boolean; count?: number }>('/satellite/cache', { method: 'DELETE' });

export interface TleCatalogStatus {
  count: number;
  lastFetch: string | null;
  isStale: boolean;
  archiveRange: { oldest: string | null; newest: string | null; count: number };
}

export const getSatelliteCatalogStatus = () =>
  fetchJSON<TleCatalogStatus>('/satellite/catalog/status');
