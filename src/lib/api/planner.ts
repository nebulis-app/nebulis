import { fetchJSON, fetchJSONWithMeta } from './client';
import type { AutoPlanFocus, PlanBlock, PlanCandidate, PlanGoalsSummary, PlanWeatherSummary } from '../planTypes';
import type { VisibleSkyMap } from '../visibilityCheck';
import type { BlockVisibilityResult } from '../visibilityCheck';
import type { MoonProximityResult } from '../moonProximity';

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
  /** `'low'` for the furthest-out night (~72-96 h): render it as a dimmer,
   *  clearly-less-certain card. Older cached forecasts omit it. */
  confidence?: 'normal' | 'low';
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

/** Forecast for an explicit observing site rather than raw coordinates. */
export const getForecastForSite = (siteId: string, refresh = false) =>
  fetchJSON<ForecastData>(`/forecast?siteId=${encodeURIComponent(siteId)}${refresh ? '&refresh=1' : ''}`);

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
  /** Other catalog designations (C39, M42...). */
  aliases?: string[];
  altNow: number;
  azNow: number;
  maxAlt: number;
  maxAltTime: string | null;
  risesAt: string | null;
  setsAt: string | null;
  isInWishlist: boolean;
  isAlreadyImaged: boolean;
  libraryObjectId: string | null;
  /** Composite "Best Tonight" ranking (0-1: altitude/duration/magnitude/
   *  transit/size), computed server-side so every client ranks the same way.
   *  Absent on older servers. */
  bestTonightScore?: number;
  /** How rewarding the object is to shoot at all (the showpiece score). Absent on older servers. */
  showpiece?: number;
  /** The shared "Best tonight" order: the blend of `bestTonightScore` and `showpiece` (server/lib/explore/rank.ts).
   *  Absent on older servers, which fall back to `bestTonightScore`. */
  tonightRank?: number;
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
  /** Which observing site the server actually resolved this response from.
   *  Null when resolved from an ad-hoc lat/lon override rather than a named
   *  site. Absent on older servers. */
  siteId?: string | null;
  siteName?: string;
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
  /** Other catalog designations (M/NGC/IC/Caldwell/Sharpless); search results only. */
  aliases?: string[];
}

export const getPlannerTargets = (opts?: {
  type?: string; minAlt?: number; limit?: number; date?: string;
  /** Explicit observing site to plan from. Omit to use the server's active/default site. */
  siteId?: string;
}) => {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.minAlt != null) params.set('minAlt', String(opts.minAlt));
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.date) params.set('date', opts.date);
  if (opts?.siteId) params.set('siteId', opts.siteId);
  const qs = params.toString();
  return fetchJSON<PlannerResponse>(`/planner/tonight${qs ? `?${qs}` : ''}`);
};

export const searchDsoCatalog = (q: string, limit = 20) =>
  fetchJSON<{ results: DsoEntry[]; total: number }>(`/dso?q=${encodeURIComponent(q)}&limit=${limit}`);

export type DsoSort = 'name' | 'magnitude';

// Auto-plan ("Plan My Night") — the scheduling algorithm runs server-side so
// every client (web, iOS, and eventually Android) produces the same plan for
// the same inputs. See server/lib/autoPlan.ts for the canonical algorithm.

export interface AutoPlanRequest {
  targets: PlanCandidate[];
  observerLat: number;
  observerLon: number;
  windowStart: Date;
  windowEnd: Date;
  slotMinutes: number;
  maxObjects: number;
  minAlt: number;
  moonIllumination: number;
  visibleSkyMap: VisibleSkyMap | null;
  focus?: AutoPlanFocus;
  unimagedOnly?: boolean;
  jitter?: number;
  /** Skip cloudy slots and favour steady seeing for small targets. */
  useForecast?: boolean;
  /** Cloud cover (%) above which a slot is skipped (server default 60). */
  maxCloudCover?: number;
  /** Favour objects with time left toward their goals (candidates' `goals`)
   *  and leave out finished ones. */
  favorGoals?: boolean;
}

interface WirePlanBlock {
  target: PlanCandidate;
  start: string;
  end: string;
  meanAlt: number;
  moonSeparation: number | null;
  moonVerdict: PlanBlock['moonVerdict'];
  filterBand?: PlanBlock['filterBand'];
  filter?: PlanBlock['filter'];
  filterRemainingSec?: PlanBlock['filterRemainingSec'];
  sky?: PlanBlock['sky'];
}

interface WireWeatherSummary {
  requested: boolean;
  used: boolean;
  forecastFetchedAt: string | null;
  maxCloudCover: number;
  skippedSlots: { start: string; end: string; cloudCover: number }[];
}

function isWireWeather(v: unknown): v is WireWeatherSummary {
  return typeof v === 'object' && v !== null && 'used' in v && Array.isArray((v as { skippedSlots?: unknown }).skippedSlots);
}

function isWireGoals(v: unknown): v is PlanGoalsSummary {
  return typeof v === 'object' && v !== null && Array.isArray((v as { complete?: unknown }).complete);
}

export async function generateNightPlan(req: AutoPlanRequest): Promise<PlanBlock[]> {
  return (await generateNightPlanWithWeather(req)).blocks;
}

/** The plan plus the server's weather and goals summaries (null when it sent
 *  none). */
export async function generateNightPlanWithWeather(
  req: AutoPlanRequest,
): Promise<{ blocks: PlanBlock[]; weather: PlanWeatherSummary | null; goals: PlanGoalsSummary | null }> {
  const { data: wire, meta } = await fetchJSONWithMeta<WirePlanBlock[]>('/planner/plan', {
    method: 'POST',
    body: JSON.stringify({
      ...req,
      windowStart: req.windowStart.toISOString(),
      windowEnd: req.windowEnd.toISOString(),
    }),
  });
  const rawWeather = typeof meta === 'object' && meta !== null ? (meta as { weather?: unknown }).weather : undefined;
  const rawGoals = typeof meta === 'object' && meta !== null ? (meta as { goals?: unknown }).goals : undefined;
  const weather: PlanWeatherSummary | null = isWireWeather(rawWeather)
    ? {
      ...rawWeather,
      skippedSlots: rawWeather.skippedSlots.map(s => ({ start: new Date(s.start), end: new Date(s.end), cloudCover: s.cloudCover })),
    }
    : null;
  const blocks = wire.map(b => ({
    ...b,
    start: new Date(b.start),
    end: new Date(b.end),
    // JSON has no Infinity; the server sends null for "moon down the whole
    // block", which is exactly what Infinity has always meant here.
    moonSeparation: b.moonSeparation ?? Infinity,
  }));
  return { blocks, weather, goals: isWireGoals(rawGoals) ? rawGoals : null };
}

// Batch moon-proximity + sky-visibility verdicts for placed blocks. Used for
// live feedback while a user drags/resizes a block on the schedule timeline.

export interface VerdictRequestItem {
  id: string;
  ra: number;
  dec: number;
  start: Date;
  end: Date;
  /** The block's filter type; omitted or null = broadband. */
  band?: 'broadband' | 'narrowband' | null;
}

interface WireBlockVerdict {
  id: string;
  moon: {
    verdict: MoonProximityResult['verdict'];
    minSeparation: number | null;
    threshold: number;
    worstAt: string | null;
    moonAltAtWorst: number;
    reason: string;
    band?: 'broadband' | 'narrowband';
    narrowbandVerdict?: MoonProximityResult['verdict'];
  };
  visibility: {
    verdict: BlockVisibilityResult['verdict'];
    fractionVisible: number;
    firstBlockedAt: string | null;
    reason: string;
    minAlt: number;
    maxAlt: number;
  };
}

export interface BlockVerdict {
  id: string;
  moon: MoonProximityResult;
  visibility: BlockVisibilityResult;
}

export async function getBlockVerdicts(
  items: VerdictRequestItem[],
  observerLat: number,
  observerLon: number,
  moonIllumination: number,
  visibleSkyMap: VisibleSkyMap | null,
  timeZone?: string,
): Promise<BlockVerdict[]> {
  const wire = await fetchJSON<WireBlockVerdict[]>('/planner/verdict', {
    method: 'POST',
    body: JSON.stringify({
      items: items.map(i => ({ id: i.id, ra: i.ra, dec: i.dec, start: i.start.toISOString(), end: i.end.toISOString(), band: i.band ?? null })),
      observerLat,
      observerLon,
      moonIllumination,
      visibleSkyMap,
      timeZone,
    }),
  });
  return wire.map(v => ({
    id: v.id,
    moon: {
      verdict: v.moon.verdict,
      minSeparation: v.moon.minSeparation ?? Infinity,
      threshold: v.moon.threshold,
      worstAt: v.moon.worstAt ? new Date(v.moon.worstAt) : null,
      moonAltAtWorst: v.moon.moonAltAtWorst,
      reason: v.moon.reason,
      band: v.moon.band,
      narrowbandVerdict: v.moon.narrowbandVerdict,
    },
    visibility: {
      verdict: v.visibility.verdict,
      fractionVisible: v.visibility.fractionVisible,
      firstBlockedAt: v.visibility.firstBlockedAt ? new Date(v.visibility.firstBlockedAt) : null,
      reason: v.visibility.reason,
      minAlt: v.visibility.minAlt,
      maxAlt: v.visibility.maxAlt,
    },
  }));
}
