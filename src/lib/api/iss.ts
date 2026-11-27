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
