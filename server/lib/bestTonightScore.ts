/**
 * "Best Tonight" composite ranking for a planner target.
 *
 * Ported from the iOS client's BestTonightScorer.swift, which previously had
 * no web equivalent — this becomes the canonical implementation for both.
 * Weights: altitude 30%, visible duration 30%, magnitude 20%, transit
 * timing 10%, angular size fit 10%.
 */

export interface BestTonightScoreInput {
  maxAlt: number;
  /** ISO instant or null (circumpolar / never sets during the window). */
  risesAt: string | null;
  setsAt: string | null;
  magnitude: number | null;
  maxAltTime: string | null;
  majorAxisArcmin: number | null;
}

export interface BestTonightScore {
  total: number;
  altScore: number;
  durationHours: number;
  durationScore: number;
  magScore: number;
  transitScore: number;
  sizeScore: number;
}

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function computeBestTonightScore(
  target: BestTonightScoreInput,
  nightStart: Date,
  nightEnd: Date,
): BestTonightScore {
  // (1) Max altitude — normalize 0..90 → 0..1
  const altScore = Math.max(0, Math.min(90, target.maxAlt)) / 90;

  // (2) Visible hours during the dark window
  const rise = parseDate(target.risesAt);
  const set = parseDate(target.setsAt);
  let visibleSeconds: number;
  if (rise && set) {
    const clampedRise = Math.max(rise.getTime(), nightStart.getTime());
    const clampedSet = Math.min(set.getTime(), nightEnd.getTime());
    visibleSeconds = Math.max(0, (clampedSet - clampedRise) / 1000);
  } else {
    // Circumpolar — visible all night
    visibleSeconds = Math.max(0, (nightEnd.getTime() - nightStart.getTime()) / 1000);
  }
  const durationHours = visibleSeconds / 3600;
  const durationScore = Math.max(0, Math.min(1, durationHours / 8));

  // (3) Magnitude — brighter = better. Mag 5 → 1.0, Mag 13 → 0.0
  let magScore = 0.3;
  if (target.magnitude !== null && Number.isFinite(target.magnitude)) {
    magScore = Math.max(0, Math.min(1, (13 - target.magnitude) / 8));
  }

  // (4) Transit timing — closer to local midnight = better
  let transitScore = 0.5;
  const midnightMs = (nightStart.getTime() + nightEnd.getTime()) / 2;
  const transit = parseDate(target.maxAltTime);
  if (transit) {
    const hoursOff = Math.abs(transit.getTime() - midnightMs) / 3_600_000;
    transitScore = Math.max(0, 1 - hoursOff / 6);
  }

  // (5) Angular size fit — sweet spot 5-80 arcmin for Seestar FOV
  let sizeScore = 0.5;
  const size = target.majorAxisArcmin;
  if (size !== null && size > 0) {
    if (size >= 5 && size <= 80) {
      sizeScore = 1.0;
    } else if (size < 5) {
      sizeScore = size / 5;
    } else {
      sizeScore = Math.max(0, 1 - (size - 80) / 120);
    }
  }

  const total =
    altScore * 0.3 + durationScore * 0.3 + magScore * 0.2 + transitScore * 0.1 + sizeScore * 0.1;

  return { total, altScore, durationHours, durationScore, magScore, transitScore, sizeScore };
}
