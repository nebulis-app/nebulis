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
 *   - stays away from the moon (skips moon-wrecked slots, penalizes close ones),
 *     judged for the filter type each object is shot through: narrowband
 *     targets (emission nebulae…) tolerate a much closer Moon than galaxies,
 *     so on a bright night the plan naturally turns to them
 *   - fills the night back-to-back from the chosen start time
 *   - with favorGoals, leans toward objects with integration time left toward
 *     their per-filter goals, picks the filter for each such block, and
 *     leaves out objects whose goals are all reached
 *
 * The schedule is greedy and per-slot: walking the night in order, each slot
 * takes the highest-scoring remaining object that is actually up (and clear
 * of the moon) during that slot. This guarantees every block has its object
 * in the sky, instead of just sorting by "best overall tonight" and hoping.
 */
import { altAz } from './astroCalc.js';
import { checkMoonProximity, type FilterBand, type MoonProximityResult } from './moonProximity.js';
import { bandForFilterName, bandForObjectType } from './filterBands.js';
import { objectEverVisible, type VisibleSkyMap } from './visibilityCheck.js';
import { typeInClass } from './objectCategories.js';
import { seeingAdjustment, type SlotSkyQuality } from './skyQuality.js';

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
  /** Integration goals of the object, per filter (see
   *  server/lib/library/integration.ts). Only read when `favorGoals` is on. */
  goals?: GoalProgress[];
}

export interface GoalProgress {
  /** Canonical filter name; null = the "no filter" goal. */
  filter: string | null;
  goalSec: number;
  remainingSec: number;
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
  /** Sky quality for a slot, from the forecast (see skyQuality.ts). Slots it
   *  marks unusable (too cloudy) are left empty and reported in
   *  `skippedSlots`; seeing nudges small targets toward steady hours. Omit,
   *  or return null for a slot, to plan exactly as without a forecast. */
  skyQuality?: (start: Date, end: Date) => SlotSkyQuality | null;
  /** Favour objects with integration time left toward their goals, and leave
   *  out objects whose goals are all reached. Each such block is shot through
   *  the filter with the most time left that the Moon allows (`filter`). */
  favorGoals?: boolean;
  /** Whether the user can shoot narrowband (a dual/tri/narrow-band filter in their gear). Only `false` changes
   *  anything: objects are then judged broadband whatever their type, as before filter-aware planning. */
  narrowbandCapable?: boolean;
}

export interface SkippedSlot {
  start: Date;
  end: Date;
  cloudCover: number;
}

export interface NightPlanResult {
  blocks: PlanBlock[];
  /** Slots left empty because the forecast says they are cloudy. */
  skippedSlots: SkippedSlot[];
  /** Objects left out because every goal on them is reached (favorGoals). */
  goalsComplete: PlanCandidate[];
}

export interface PlanBlock {
  target: PlanCandidate;
  start: Date;
  end: Date;
  meanAlt: number;
  moonSeparation: number;
  moonVerdict: 'ok' | 'caution' | 'warning';
  /** Filter type the block is planned for (from the object type), which the
   *  Moon check above used. Stored on the block when it is scheduled. */
  filterBand: FilterBand;
  /** With favorGoals, the filter picked from the object's goals (null = the
   *  "no filter" goal); undefined for an object without goals. */
  filter?: string | null;
  /** Integration time left on that filter before this block. */
  filterRemainingSec?: number;
  /** Forecast for the block, or null when there was none for it. */
  sky: SlotSkyQuality | null;
}

function matchesFocus(t: PlanCandidate, focus: AutoPlanFocus): boolean {
  if (focus === 'all') return true;
  if (focus === 'galaxies') return typeInClass(t.type, 'galaxy');
  if (focus === 'nebulae') return typeInClass(t.type, 'nebula');
  if (focus === 'clusters') return typeInClass(t.type, 'cluster');
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

/** Goals with time left; [] when there are none or all are reached. */
function openGoals(t: PlanCandidate): GoalProgress[] {
  return (t.goals ?? []).filter(g => g.goalSec > 0 && g.remainingSec > 0);
}

function goalsComplete(t: PlanCandidate): boolean {
  const goals = (t.goals ?? []).filter(g => g.goalSec > 0);
  return goals.length > 0 && goals.every(g => g.remainingSec <= 0);
}

/** A filter's band by its name; unknown names count as broadband, the
 *  cautious reading (same rule as src/lib/filterSuggestion.ts). */
function bandOfGoal(g: GoalProgress): FilterBand {
  return bandForFilterName(g.filter) ?? 'broadband';
}

/**
 * Score bonus for an object with goals, in degrees of altitude-equivalent:
 * 32 for having time left at all, up to 45 when nothing is shot yet. The floor
 * sits just above the +30 a named object gets, so a project beats a famous
 * object at the same place; the cap and the `minAlt` floor keep it from
 * scheduling a target low in the murk (upstream proposed 20..50, where an
 * almost-finished project lost to every named object). MAX_GOAL_ALT_DEFICIT
 * bounds how far below the best-placed target a boosted one may still win.
 */
export function goalBonus(goals: GoalProgress[]): number {
  const total = goals.reduce((a, g) => a + Math.max(0, g.goalSec), 0);
  if (total <= 0) return 0;
  const left = goals.reduce((a, g) => a + Math.min(Math.max(0, g.remainingSec), Math.max(0, g.goalSec)), 0);
  if (left <= 0) return 0;
  return 32 + 13 * (left / total);
}

/**
 * A goal bonus never carries a target past one that sits this many degrees
 * higher in the same slot. The bonus is there to finish projects, not to
 * schedule them in the murk: without a cap, a project at 32 degrees beat an
 * equally famous object at 70.
 */
export const MAX_GOAL_ALT_DEFICIT = 20;

export function generateNightPlan(p: AutoPlanParams): PlanBlock[] {
  return generateNightPlanDetailed(p).blocks;
}

/** Same plan, plus the slots skipped for clouds. */
export function generateNightPlanDetailed(p: AutoPlanParams): NightPlanResult {
  const slotMs = Math.max(5, p.slotMinutes) * 60_000;
  const jitter = p.jitter ?? 0;

  // Candidate pool: matching focus and reaching the visible sky at some point
  // in the window. When unimagedOnly is off, already-imaged objects stay in
  // the pool on equal footing (no score penalty, see below) since the user
  // asked for them; unimagedOnly is the only lever that excludes them.
  const completed: PlanCandidate[] = [];
  const pool = p.targets.filter(t => {
    if (!matchesFocus(t, p.focus ?? 'all')) return false;
    if (p.unimagedOnly && t.isAlreadyImaged) return false;
    if (p.favorGoals && goalsComplete(t)) {
      completed.push(t);
      return false;
    }
    if (
      !objectEverVisible(t.ra, t.dec, p.observerLat, p.observerLon, p.windowStart, p.windowEnd, p.visibleSkyMap)
    ) {
      return false;
    }
    return true;
  });

  const used = new Set<string>();
  const blocks: PlanBlock[] = [];
  const skippedSlots: SkippedSlot[] = [];

  for (
    let slotStart = p.windowStart.getTime();
    slotStart + slotMs <= p.windowEnd.getTime() + 60_000 && blocks.length < p.maxObjects;
    slotStart += slotMs
  ) {
    const start = new Date(slotStart);
    const end = new Date(Math.min(slotStart + slotMs, p.windowEnd.getTime()));

    // Cloudy slot: leave it empty rather than spend a target on it. The slot
    // doesn't count toward maxObjects, so a clear later slot still gets one.
    const sky = p.skyQuality?.(start, end) ?? null;
    if (sky && !sky.usable) {
      skippedSlots.push({ start, end, cloudCover: sky.cloudCover });
      continue;
    }

    type Candidate = {
      target: PlanCandidate;
      meanAlt: number;
      moon: MoonProximityResult;
      band: FilterBand;
      goal: GoalProgress | null;
      score: number;
      boosted: boolean;
    };
    const eligible: Candidate[] = [];
    let bestRelaxed: Candidate | null = null;

    for (const t of pool) {
      if (used.has(t.id)) continue;
      const meanAlt = meanAltitude(t.ra, t.dec, p.observerLat, p.observerLon, start, end);
      if (meanAlt < 10) continue; // effectively below the horizon for this slot

      const check = (band: FilterBand) =>
        checkMoonProximity(t.ra, t.dec, p.observerLat, p.observerLon, start, end, p.moonIllumination, 5, undefined, band);

      // An object with goals is shot through the filter with the most time
      // left among those the Moon allows on this slot: broadband filters
      // only when the Moon is well clear (as the block details suggest),
      // narrowband ones unless it would wreck them. Otherwise the object
      // type decides the band, as before.
      const goals = p.favorGoals ? openGoals(t) : [];
      let band: FilterBand;
      let moon: MoonProximityResult;
      let goal: GoalProgress | null = null;
      if (goals.length > 0) {
        const byBand = new Map<FilterBand, MoonProximityResult>();
        const moonFor = (b: FilterBand) => {
          let m = byBand.get(b);
          if (!m) { m = check(b); byBand.set(b, m); }
          return m;
        };
        const allowed = goals.filter(g => {
          // Same rule as the no-goals path below: only a "warning" rules a filter out.
          return moonFor(bandOfGoal(g)).verdict !== 'warning';
        });
        if (allowed.length === 0) continue; // the Moon rules out every filter with time left
        goal = allowed.reduce((a, b) => (b.remainingSec > a.remainingSec ? b : a));
        band = bandOfGoal(goal);
        moon = moonFor(band);
      } else {
        // Without narrowband gear the type-derived band would only loosen the Moon check for nothing.
        band = p.narrowbandCapable === false ? 'broadband' : bandForObjectType(t.type);
        moon = check(band);
        if (moon.verdict === 'warning') continue; // moon would wreck it
      }

      // Score (degrees of altitude-equivalent):
      //   + elevation (dominant, so the plan favors well-placed objects)
      //   - moon penalty when the moon is merely close
      //   + popularity bonus for objects with a common name so the plan leans
      //     toward recognizable targets over obscure catalog entries
      //   + seeing fit: small targets gain in steady air (forecast only)
      //   + goal bonus: time left toward integration goals (favorGoals only)
      //   + jitter for "Shuffle"
      // Already-imaged status has no score effect here: unimagedOnly (above)
      // is the sole switch for whether imaged objects are eligible at all.
      const moonPenalty = moon.verdict === 'caution' ? 10 : 0;
      const popularBonus = t.commonNames.length > 0 ? 30 : 0;
      const bonus = goalBonus(goals);
      const score = meanAlt - moonPenalty + popularBonus + seeingAdjustment(sky, t) + bonus
        + (jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0);
      const candidate = { target: t, meanAlt, moon, band, goal, score, boosted: bonus > 0 };

      if (!bestRelaxed || candidate.score > bestRelaxed.score) bestRelaxed = candidate;
      if (meanAlt >= p.minAlt) eligible.push(candidate);
    }

    // Best above the floor, where a goal-boosted target is out of the running
    // when something else clears the floor by more than MAX_GOAL_ALT_DEFICIT
    // degrees of altitude. The highest candidate always passes, so a slot is
    // never emptied by this rule.
    const topAlt = eligible.reduce((m, c) => Math.max(m, c.meanAlt), -Infinity);
    let best: Candidate | null = null;
    for (const c of eligible) {
      if (c.boosted && topAlt - c.meanAlt > MAX_GOAL_ALT_DEFICIT) continue;
      if (!best || c.score > best.score) best = c;
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
      filterBand: chosen.band,
      ...(chosen.goal ? { filter: chosen.goal.filter, filterRemainingSec: chosen.goal.remainingSec } : {}),
      sky,
    });
  }

  return { blocks, skippedSlots, goalsComplete: completed };
}
