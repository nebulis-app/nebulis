import { fetchJSON } from './client';

/** Mirrors server/lib/iss/passes.ts. */
export interface PassPoint {
  t: string;
  az: number;
  alt: number;
}

export interface IssPass {
  rise: PassPoint;
  peak: PassPoint;
  set: PassPoint;
  visible: { start: PassPoint; end: PassPoint; peak: PassPoint } | null;
  magnitude: number | null;
  endsInShadow: boolean;
  startsInShadow: boolean;
}

export interface IssPassesResponse {
  site: { id: string | null; name: string; latitude: number; longitude: number; timezone: string };
  tle: { epoch: string; ageHours: number; stale: boolean; source: 'iss' | 'catalog' } | null;
  minAltitude: number;
  passes: IssPass[];
}

export const getIssPasses = (opts: { siteId?: string | null; days?: number } = {}) => {
  const params = new URLSearchParams();
  if (opts.siteId) params.set('siteId', opts.siteId);
  if (opts.days) params.set('days', String(opts.days));
  const qs = params.toString();
  return fetchJSON<IssPassesResponse>(`/sky-events/iss-passes${qs ? `?${qs}` : ''}`);
};

/** Mirrors server/lib/iss/transits.ts. */
export interface IssTransit {
  body: 'moon' | 'sun';
  time: string;
  durationSec: number;
  nearest: { lat: number; lon: number; distanceKm: number; bearingDeg: number };
  bandHalfWidthKm: number;
  siteInBand: boolean;
  bodyAltitude: number;
  bodyAzimuth: number;
  issRangeKm: number;
  centerline: { t: string; lat: number; lon: number }[];
}

export interface IssTransitsResponse {
  site: IssPassesResponse['site'];
  tle: IssPassesResponse['tle'];
  radiusKm: number;
  transits: IssTransit[];
}

export const getIssTransits = (opts: { siteId?: string | null; radiusKm?: number; days?: number } = {}) => {
  const params = new URLSearchParams();
  if (opts.siteId) params.set('siteId', opts.siteId);
  if (opts.radiusKm) params.set('radiusKm', String(opts.radiusKm));
  if (opts.days) params.set('days', String(opts.days));
  const qs = params.toString();
  return fetchJSON<IssTransitsResponse>(`/sky-events/iss-transits${qs ? `?${qs}` : ''}`);
};
