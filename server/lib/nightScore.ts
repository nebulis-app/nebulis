/**
 * The night score: how good one night is for imaging, 0-100.
 *
 * This is the server half of ONE formula. The browser half is
 * `calculateVisibilityScore` (src/lib/forecastScore.ts) and `scoreNight`
 * (src/lib/plannerNight.ts). The two cannot share a source file, so
 * tests/backend/nightScoreParity.test.ts runs them side by side and fails the
 * moment they disagree. Change the formula in both places, never in one.
 *
 * Every number a user sees for a night comes from here or from its twin: the
 * Planner strip, the Sky Forecast hero, and the outlook cards. See
 * internal-doc/night-score.md for the weights, the bands and a worked example.
 *
 * Pure on purpose: no database, no network, no clock. Callers pass the moon
 * and the dark window in.
 */
import { localParts } from './timezone.js';
import type { ForecastHour } from './forecastCache.js';

/** An hour scoring at least this counts as worth being outside for. */
export const USABLE_SCORE = 55;

/** Score bands, high to low. Mirrors SCORE_BANDS in src/lib/forecastScore.ts. */
export const SCORE_BANDS = [
  { min: 85, label: 'Ideal' },
  { min: 70, label: 'Great' },
  { min: 55, label: 'Good' },
  { min: 40, label: 'Fair' },
  { min: 25, label: 'Poor' },
  { min: 0, label: 'Bad' },
] as const;

export type ScoreLabel = (typeof SCORE_BANDS)[number]['label'];

export function scoreLabel(score: number): ScoreLabel {
  return (SCORE_BANDS.find((b) => score >= b.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1]).label;
}

export interface DarkWindow {
  /** Epoch ms. */
  start: number;
  end: number;
}

export interface NightScoreInput {
  /** 0-100, the moon's lit fraction for the night. */
  moonIllumination: number;
  /** Astronomical (else nautical) dark. `null` when neither occurs. */
  darkWindow: DarkWindow | null;
  /** The site's zone, for the fixed 19:00-05:00 band used when there is no dark window. */
  timeZone: string;
}

export interface NightScore {
  score: number;
  rating: ScoreLabel;
  avgCloudCover: number;
  avgHumidity: number;
  avgWind: number;
  precipChance: number;
}

const SEEING_BASE: Record<number, number> = { 1: 1.0, 2: 0.75, 3: 0.5, 4: 0.2, 5: 0.0 };

/**
 * One hour, 0-100. Cloud 60%, seeing 20%, moon 20%, plus up to 10 for dry air.
 * Rain and wind are not in it: the clouds already say whether it will be
 * clear, and the forecast skill for both falls off faster than for cloud.
 */
export function hourScore(hour: ForecastHour, moonIllumination: number, isDark: boolean): number {
  const cloud = 1 - hour.cloudCover / 100;

  let seeing = hour.seeing != null ? (SEEING_BASE[hour.seeing] ?? 0.5) : 0.5;
  if (hour.jetStream != null) {
    const penalty = hour.jetStream < 40 ? 0 : hour.jetStream < 80 ? 0.12 : hour.jetStream < 120 ? 0.25 : 0.4;
    seeing = Math.max(0, seeing - penalty);
  }
  if (hour.cape != null && hour.cape > 100) {
    const penalty = hour.cape < 500 ? 0.05 : hour.cape < 1500 ? 0.1 : 0.15;
    seeing = Math.max(0, seeing - penalty);
  }

  const moon = isDark ? 1 - moonIllumination / 100 : 1.0;
  const dryAir = Math.max(0, 1 - Math.max(0, hour.humidity - 40) / 60) * 0.1;

  const raw = cloud * 0.6 + seeing * 0.2 + moon * 0.2 + dryAir;
  return Math.round(Math.min(100, Math.max(0, raw * 100)));
}

function isDarkHour(time: string, input: NightScoreInput): boolean {
  const t = new Date(time).getTime();
  if (input.darkWindow) return t >= input.darkWindow.start && t <= input.darkWindow.end;
  const hour = localParts(new Date(time), input.timeZone).hour;
  return hour >= 19 || hour <= 5;
}

/**
 * Roll a night's hours into one score: the mean of the hourly scores over the
 * dark window (all the hours given when none fall inside it). Cloud cover is
 * used as forecast, with no smoothing. Averaging eleven hours smooths it
 * already. Returns null for an empty list.
 */
export function scoreNightHours(hours: ForecastHour[], input: NightScoreInput): NightScore | null {
  if (hours.length === 0) return null;
  const scored = hours.map((hour) => ({ hour, score: hourScore(hour, input.moonIllumination, isDarkHour(hour.time, input)) }));

  const inWindow = input.darkWindow
    ? scored.filter(({ hour }) => {
        const t = new Date(hour.time).getTime();
        return t >= input.darkWindow!.start && t <= input.darkWindow!.end;
      })
    : scored;
  const rated = inWindow.length > 0 ? inWindow : scored;

  const mean = (pick: (h: ForecastHour) => number) => rated.reduce((sum, r) => sum + pick(r.hour), 0) / rated.length;
  const score = Math.round(rated.reduce((sum, r) => sum + r.score, 0) / rated.length);
  return {
    score,
    rating: scoreLabel(score),
    avgCloudCover: Math.round(mean((h) => h.cloudCover)),
    avgHumidity: Math.round(mean((h) => h.humidity)),
    avgWind: Math.round(mean((h) => h.wind) * 10) / 10,
    precipChance: Math.round(mean((h) => h.precipProb)),
  };
}
