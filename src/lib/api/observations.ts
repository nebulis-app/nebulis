import { fetchJSON } from './client';
import type { ObservationNote } from './notes';

export interface ObservationSummary {
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
  subFrameCount: number;
  processedCount: number;
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
  /** Observing site this session is explicitly tagged to. Null means untagged,
   *  in which case the coordinates come from the capture files, or from the
   *  default site when the files carry none. */
  siteId: string | null;
  /** Where `coordinates` came from. 'fits' = the capture files recorded them,
   *  so the user never chose this location and the UI must not imply they did. */
  locationSource: 'fits' | 'site';
  /** Display name for the location. For a file-derived location this names no
   *  saved site, so it cannot be looked up in the sites list. */
  locationLabel: string;
  /** What the capture files recorded, present even when a site tag overrides it,
   *  so the location can be set back to it. */
  fileCoordinates: { lat: number; lon: number } | null;
  /** What the telescope recorded about this night, parsed from its own sidecar
   *  (a Dwarf's shotsInfo.json). Null when no sidecar was imported. */
  capture: import('../../types').SessionCaptureSummary | null;
}

export interface ObservationLocation {
  objectId: string;
  date: string;
  objectName: string;
  catalogId: string;
  telescopeId: string | null;
  lat: number;
  lon: number;
  /** 'fits' = precise (from the file); 'settings' = the saved observer location. */
  source: 'fits' | 'settings';
}

export const getObservations = () => fetchJSON<ObservationSummary[]>('/library/observations');
export const getObservationDetail = (objectId: string, date: string) =>
  fetchJSON<ObservationDetail>(`/library/observations/${encodeURIComponent(objectId)}/${encodeURIComponent(date)}`);
export const getObservationLocations = () =>
  fetchJSON<ObservationLocation[]>('/observations/locations');

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
export const clearSatelliteCache = () =>
  fetchJSON<{ cleared: boolean; count?: number }>('/satellite/cache', { method: 'DELETE' });

interface TleCatalogStatus {
  count: number;
  lastFetch: string | null;
  isStale: boolean;
  archiveRange: { oldest: string | null; newest: string | null; count: number };
}

export const getSatelliteCatalogStatus = () =>
  fetchJSON<TleCatalogStatus>('/satellite/catalog/status');
