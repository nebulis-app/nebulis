/**
 * Sky quality for a planner slot, from the hourly forecast.
 *
 * "Plan My Night" used to schedule on altitude, horizon and Moon only, so it
 * happily put the best target in the cloudy half of the night. This turns the
 * forecast the Sky Forecast page already shows (Open-Meteo clouds, 7Timer
 * seeing/transparency) into one verdict per slot that the auto-planner can
 * act on:
 *
 *   - `usable`: false when the mean cloud cover over the slot is above the
 *     user's threshold. The planner leaves those slots empty.
 *   - `seeing` / `transparency`: carried through so small, detail-hungry
 *     targets can be steered to the steadiest hours.
 *
 * Pure: takes the hourly array, never fetches. Hours are treated as covering
 * [time, time + 1h).
 */
import type { ForecastHour } from './forecastCache.js';

/** Default cloud-cover ceiling (%) for a slot to count as usable. */
export const DEFAULT_MAX_CLOUD_COVER = 60;

export interface SlotSkyQuality {
  /** Mean total cloud cover over the slot, 0-100, rounded. */
  cloudCover: number;
  /** Mean 7Timer seeing over the slot, 1 (best) - 5 (worst), or null. */
  seeing: number | null;
  /** Mean 7Timer transparency, 1 (clearest) - 8, or null. */
  transparency: number | null;
  /** True when any hour in the slot is within 3 °C of the dew point. */
  dewRisk: boolean;
  /** cloudCover <= the threshold the slot was judged against. */
  usable: boolean;
}

const HOUR_MS = 3_600_000;

/** Hourly entries whose hour overlaps [start, end), keyed on parsed time. */
interface TimedHour { t: number; h: ForecastHour }

export function indexForecastHours(hours: readonly ForecastHour[]): TimedHour[] {
  return hours
    .map(h => ({ t: Date.parse(h.time), h }))
    .filter(x => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Sky quality over [start, end), weighting each forecast hour by how much of
 * the slot it covers. Null when the forecast doesn't reach the slot at all
 * (past the forecast horizon, or no data) — the caller then plans as before.
 */
export function slotSkyQuality(
  hours: readonly TimedHour[],
  start: Date,
  end: Date,
  maxCloudCover: number = DEFAULT_MAX_CLOUD_COVER,
): SlotSkyQuality | null {
  const s = start.getTime();
  const e = end.getTime();
  if (!(e > s)) return null;

  let weightSum = 0;
  let cloud = 0;
  const seeing: number[] = [];
  const transparency: number[] = [];
  let dewRisk = false;
  let covered = 0;

  for (const { t, h } of hours) {
    const overlap = Math.min(e, t + HOUR_MS) - Math.max(s, t);
    if (overlap <= 0) continue;
    covered += overlap;
    weightSum += overlap;
    cloud += h.cloudCover * overlap;
    if (h.seeing !== null && h.seeing !== undefined) seeing.push(h.seeing);
    if (h.transparency !== null && h.transparency !== undefined) transparency.push(h.transparency);
    if (h.temperature - h.dewPoint < 3) dewRisk = true;
  }

  // Less than half the slot covered by forecast data: not enough to judge.
  if (weightSum === 0 || covered < (e - s) / 2) return null;

  const cloudCover = Math.round(cloud / weightSum);
  const seeingMean = mean(seeing);
  const transparencyMean = mean(transparency);
  return {
    cloudCover,
    seeing: seeingMean === null ? null : Math.round(seeingMean * 10) / 10,
    transparency: transparencyMean === null ? null : Math.round(transparencyMean * 10) / 10,
    dewRisk,
    usable: cloudCover <= maxCloudCover,
  };
}

/**
 * Score adjustment (degrees of altitude-equivalent, like the planner's other
 * terms) for putting a target in a slot with this seeing. Small targets
 * (galaxies, planetary nebulae, anything under 20′) gain in steady air and
 * lose in poor seeing; large nebulae barely care. Average seeing (3) is
 * neutral, so a forecast without seeing data changes nothing.
 */
export function seeingAdjustment(
  quality: SlotSkyQuality | null,
  target: { majorAxisArcmin: number | null; type: string },
): number {
  if (!quality || quality.seeing === null) return 0;
  const small = (target.majorAxisArcmin !== null && target.majorAxisArcmin > 0 && target.majorAxisArcmin < 20)
    || /galaxy|planetary/i.test(target.type);
  const weight = small ? 8 : 2;
  return (3 - quality.seeing) * weight;
}
