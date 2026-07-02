/**
 * Auto-plan engine for "Plan My Night".
 *
 * Given the night's visible catalog and an observer, this builds a sequential
 * imaging plan that:
 *   - focuses on objects the user has NOT imaged before (isAlreadyImaged)
 *   - images each object when it sits highest during its time slot (elevation)
 *   - stays away from the moon (skips moon-wrecked slots, penalizes close ones)
 *   - fills the night back-to-back from the chosen start time
 *
 * The schedule is greedy and per-slot: walking the night in order, each slot
 * takes the highest-scoring remaining object that is actually up (and clear of
 * the moon) during that slot. This guarantees every block has its object in the
 * sky, instead of just sorting by "best overall tonight" and hoping.
 */
import { altAz } from './altaz';
import { checkMoonProximity } from './moonProximity';
import { objectEverVisible, type VisibleSkyMap } from './visibilityCheck';

export type AutoPlanFocus = 'all' | 'galaxies' | 'nebulae' | 'clusters';

/** Structural subset of a deep-sky object the planner engine needs. Both the
 *  planner's PlannerTarget and a catalog progress object satisfy this. */
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

interface AutoPlanParams {
  targets: PlanCandidate[];
  observerLat: number;
  observerLon: number;
  /** First moment a block may start (rounded "now" tonight, else dusk). */
  windowStart: Date;
  /** Hard end: the dark window's end, or start + available hours. */
  windowEnd: Date;
  /** Length of each imaging block in minutes. */
  slotMinutes: number;
  /** Cap on how many blocks to generate. */
  maxObjects: number;
  /** Altitude floor (degrees). Objects below this in a slot are passed over
   *  unless nothing else qualifies. */
  minAlt: number;
  /** Tonight's moon illumination (0-100), for the proximity threshold. */
  moonIllumination: number;
  visibleSkyMap: VisibleSkyMap | null;
  focus?: AutoPlanFocus;
  /** When true, already-imaged objects are excluded entirely from the plan
   *  instead of just being heavily penalized. */
  unimagedOnly?: boolean;
  /** 0 = deterministic (always the top picks). >0 adds randomness so "Shuffle"
   *  surfaces different-but-still-good plans. Degrees of altitude-equivalent. */
  jitter?: number;
}

export interface PlanBlock {
  target: PlanCandidate;
  start: Date;
  end: Date;
  /** Mean altitude (degrees) across the slot. */
  meanAlt: number;
  /** Smallest moon separation in the slot, or Infinity if the moon is down. */
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
  // in the window. We keep blocked-by-sky-map objects out so the plan only
  // contains things the observer can actually point at. Already-imaged objects
  // stay in the pool but are pushed far down by the score (see below), so they
  // only appear when there's nothing fresh to shoot.
  const pool = p.targets.filter(t => {
    if (!matchesFocus(t, p.focus ?? 'all')) return false;
    if (p.unimagedOnly && t.isAlreadyImaged) return false;
    if (!objectEverVisible(t.ra, t.dec, p.observerLat, p.observerLon, p.windowStart, p.windowEnd, p.visibleSkyMap)) {
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

    type Candidate = { target: PlanCandidate; meanAlt: number; moon: ReturnType<typeof checkMoonProximity>; score: number };
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
      //   + popularity bonus for objects with a common name (Messier, named
      //     galaxies, well-known NGC/IC) so the plan leans toward recognizable
      //     targets over obscure catalog entries
      //   - a heavy penalty for already-imaged objects, so fresh targets win
      //     every time one is available but imaged ones can still fill a slot
      //     that would otherwise sit empty
      //   + jitter for "Shuffle"
      const moonPenalty = moon.verdict === 'caution' ? 10 : 0;
      const popularBonus = t.commonNames.length > 0 ? 12 : 0;
      const imagedPenalty = t.isAlreadyImaged ? 1000 : 0;
      const score =
        meanAlt - moonPenalty + popularBonus - imagedPenalty +
        (jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0);
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
