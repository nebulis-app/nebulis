/**
 * Auto-plan engine for "Plan My Night".
 *
 * This is the single canonical implementation of the scheduling algorithm,
 * used by every client (web, iOS, and eventually Android) via
 * POST /api/v1/planner/plan. It replaces two previously-independent
 * implementations (web's src/lib/autoPlan.ts and iOS's AutoPlan.swift) that
 * had drifted: iOS penalized already-imaged objects even when unimagedOnly
 * was off, and used a different named-object tie-break than web. This
 * version keeps web's original (documented, intentional) behavior for both.
 *
 * Given the night's visible catalog and an observer, this builds a sequential
 * imaging plan that:
 *   - focuses on objects the user has NOT imaged before (isAlreadyImaged),
 *     but only when unimagedOnly excludes them outright — once eligible,
 *     already-imaged objects compete on equal footing
 *   - images each object when it sits highest during its time slot (elevation)
 *   - stays away from the moon (skips moon-wrecked slots, penalizes close ones)
 *   - fills the night back-to-back from the chosen start time
 *
 * The schedule is greedy and per-slot: walking the night in order, each slot
 * takes the highest-scoring remaining object that is actually up (and clear
 * of the moon) during that slot. This guarantees every block has its object
 * in the sky, instead of just sorting by "best overall tonight" and hoping.
 */
import { altAz } from './astroCalc.js';
import { checkMoonProximity, type MoonProximityResult } from './moonProximity.js';
import { objectEverVisible, type VisibleSkyMap } from './visibilityCheck.js';

export const AUTO_PLAN_FOCUSES = ['all', 'galaxies', 'nebulae', 'clusters'] as const;
export type AutoPlanFocus = (typeof AUTO_PLAN_FOCUSES)[number];

/** Structural subset of a deep-sky object the planner engine needs. */
export interface PlanCandidate {
  id: string;
  name: string;
  type: string;
  ra: number;
  dec: number;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  constellation: string | null;
  commonNames: string[];
  isAlreadyImaged: boolean;
}

export interface AutoPlanParams {
  targets: PlanCandidate[];
  observerLat: number;
  observerLon: number;
  /** First moment a block may start. */
  windowStart: Date;
  /** Hard end of the planning window. */
  windowEnd: Date;
  /** Length of each imaging block in minutes. */
  slotMinutes: number;
  /** Cap on how many blocks to generate. */
  maxObjects: number;
  /** Altitude floor (degrees). */
  minAlt: number;
  /** Tonight's moon illumination (0-100), for the proximity threshold. */
  moonIllumination: number;
  visibleSkyMap: VisibleSkyMap | null;
  focus?: AutoPlanFocus;
  /** When true, already-imaged objects are excluded entirely from the plan
   *  instead of just competing normally. */
  unimagedOnly?: boolean;
  /** 0 = deterministic, >0 adds randomness so "Shuffle" surfaces
   *  different-but-still-good plans. Degrees of altitude-equivalent. */
  jitter?: number;
}

export interface PlanBlock {
  target: PlanCandidate;
  start: Date;
  end: Date;
  meanAlt: number;
  moonSeparation: number;
  moonVerdict: 'ok' | 'caution' | 'warning';
}

function matchesFocus(t: PlanCandidate, focus: AutoPlanFocus): boolean {
  if (focus === 'all') return true;
  if (focus === 'galaxies') return t.type.toLowerCase().includes('galaxy');
  if (focus === 'nebulae') return /nebula|emission|reflection|planetary/i.test(t.type);
  if (focus === 'clusters') return /cluster/i.test(t.type);
  return true;
}

/** Mean altitude over a slot, sampled at start / middle / end. */
function meanAltitude(
  ra: number,
  dec: number,
  lat: number,
  lon: number,
  start: Date,
  end: Date,
): number {
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  const samples = [start, mid, end].map(t => altAz(ra, dec, lat, lon, t).alt);
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

export function generateNightPlan(p: AutoPlanParams): PlanBlock[] {
  const slotMs = Math.max(5, p.slotMinutes) * 60_000;
  const jitter = p.jitter ?? 0;

  // Candidate pool: matching focus and reaching the visible sky at some point
  // in the window. When unimagedOnly is off, already-imaged objects stay in
  // the pool on equal footing (no score penalty, see below) since the user
  // asked for them; unimagedOnly is the only lever that excludes them.
  const pool = p.targets.filter(t => {
    if (!matchesFocus(t, p.focus ?? 'all')) return false;
    if (p.unimagedOnly && t.isAlreadyImaged) return false;
    if (
      !objectEverVisible(t.ra, t.dec, p.observerLat, p.observerLon, p.windowStart, p.windowEnd, p.visibleSkyMap)
    ) {
      return false;
    }
    return true;
  });

  const used = new Set<string>();
  const blocks: PlanBlock[] = [];

  for (
    let slotStart = p.windowStart.getTime();
    slotStart + slotMs <= p.windowEnd.getTime() + 60_000 && blocks.length < p.maxObjects;
    slotStart += slotMs
  ) {
    const start = new Date(slotStart);
    const end = new Date(Math.min(slotStart + slotMs, p.windowEnd.getTime()));

    type Candidate = { target: PlanCandidate; meanAlt: number; moon: MoonProximityResult; score: number };
    let best: Candidate | null = null;
    let bestRelaxed: Candidate | null = null;

    for (const t of pool) {
      if (used.has(t.id)) continue;
      const meanAlt = meanAltitude(t.ra, t.dec, p.observerLat, p.observerLon, start, end);
      if (meanAlt < 10) continue; // effectively below the horizon for this slot

      const moon = checkMoonProximity(t.ra, t.dec, p.observerLat, p.observerLon, start, end, p.moonIllumination);
      if (moon.verdict === 'warning') continue; // moon would wreck it

      // Score (degrees of altitude-equivalent):
      //   + elevation (dominant, so the plan favors well-placed objects)
      //   - moon penalty when the moon is merely close
      //   + popularity bonus for objects with a common name so the plan leans
      //     toward recognizable targets over obscure catalog entries
      //   + jitter for "Shuffle"
      // Already-imaged status has no score effect here: unimagedOnly (above)
      // is the sole switch for whether imaged objects are eligible at all.
      const moonPenalty = moon.verdict === 'caution' ? 10 : 0;
      const popularBonus = t.commonNames.length > 0 ? 30 : 0;
      const score = meanAlt - moonPenalty + popularBonus + (jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0);
      const candidate = { target: t, meanAlt, moon, score };

      if (!bestRelaxed || candidate.score > bestRelaxed.score) bestRelaxed = candidate;
      if (meanAlt >= p.minAlt && (!best || candidate.score > best.score)) best = candidate;
    }

    // Prefer an object above the elevation floor; if the slot has none, fall
    // back to the best available rather than leaving a hole in the night.
    const chosen = best ?? bestRelaxed;
    if (!chosen) continue;

    used.add(chosen.target.id);
    blocks.push({
      target: chosen.target,
      start,
      end,
      meanAlt: chosen.meanAlt,
      moonSeparation: chosen.moon.minSeparation,
      moonVerdict: chosen.moon.verdict,
    });
  }

  return blocks;
}
