import { fetchJSON } from './client';

// Forecast
export interface ForecastHour {
  time: string;
  cloudCover: number;
  cloudCoverLow: number;
  cloudCoverMid: number;
  cloudCoverHigh: number;
  seeing: number | null;
  transparency: number | null;
  humidity: number;
  temperature: number;
  dewPoint: number;
  wind: number;
  visibility: number | null;
  precipProb: number;
  jetStream: number | null;
  cape: number | null;
}

export interface NightRating {
  date: string;
  score: number;
  rating: string;
  avgCloudCover: number;
  avgHumidity: number;
  avgWind: number;
  precipChance: number;
}

interface ForecastData {
  location: { lat: number; lon: number };
  timezone: string | null;
  hourly: ForecastHour[];
  tonight: {
    moonIllumination: number;
    moonPhase: string;
    moonRise: string | null;
    moonSet: string | null;
    sunset: string;
    sunrise: string;
    astronomicalTwilightEnd: string;
    astronomicalTwilightStart: string;
    nauticalTwilightEnd: string;
    nauticalTwilightStart: string;
    darkHours: number;
    nauticalDarkHours: number;
  };
  nightRatings: NightRating[];
  sources: { weather: string | null; seeing: string | null };
}

export const getForecast = (lat: number, lon: number, refresh = false) =>
  fetchJSON<ForecastData>(`/forecast?lat=${lat}&lon=${lon}${refresh ? '&refresh=1' : ''}`);

// Planner
export interface PlannerTarget {
  id: string;
  ngcName: string;
  name: string;
  type: string;
  typeCode: string;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  ra: number;
  dec: number;
  commonNames: string[];
  altNow: number;
  azNow: number;
  maxAlt: number;
  maxAltTime: string | null;
  risesAt: string | null;
  setsAt: string | null;
  isInWishlist: boolean;
  isAlreadyImaged: boolean;
  libraryObjectId: string | null;
}

interface PlannerResponse {
  locationSet: boolean;
  targets: PlannerTarget[];
  totalVisible: number;
  nightStart: string | null;
  nightEnd: string | null;
  sunset: string | null;
  sunrise: string | null;
  timelineStart?: string | null;
  timelineEnd?: string | null;
  moonIllumination: number;
  moonPhase: string;
  observerLat?: number;
  observerLon?: number;
  observerTimezone?: string | null;
}

export interface DsoEntry {
  id: string;
  ngcName: string;
  name: string;
  type: string;
  typeCode: string;
  constellation: string | null;
  ra: number;
  dec: number;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  commonNames: string[];
  messier: number | null;
}

export const getPlannerTargets = (opts?: { type?: string; minAlt?: number; limit?: number; date?: string }) => {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.minAlt != null) params.set('minAlt', String(opts.minAlt));
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.date) params.set('date', opts.date);
  const qs = params.toString();
  return fetchJSON<PlannerResponse>(`/planner/tonight${qs ? `?${qs}` : ''}`);
};

export const searchDsoCatalog = (q: string, limit = 20) =>
  fetchJSON<{ results: DsoEntry[]; total: number }>(`/dso?q=${encodeURIComponent(q)}&limit=${limit}`);
