import { describe, it, expect } from 'vitest';
import { generateNightPlan, generateNightPlanDetailed, goalBonus, MAX_GOAL_ALT_DEFICIT, type PlanCandidate } from '../../server/lib/autoPlan';
import { altAz } from '../../server/lib/astroCalc';

/**
 * Regression coverage for the web/iOS planner divergence: iOS's port of this
 * algorithm had drifted (an undocumented already-imaged penalty, and a
 * different named-object tie-break). This server-side engine is now the
 * single canonical implementation for every client, so these tests pin the
 * intended behavior for good.
 */

const OBSERVER_LAT = 40;
const OBSERVER_LON = -74;

function candidate(overrides: Partial<PlanCandidate> & { id: string; ra: number; dec: number }): PlanCandidate {
  return {
    name: overrides.id,
    type: 'Galaxy',
    magnitude: 8,
    majorAxisArcmin: 10,
    constellation: null,
    commonNames: [],
    isAlreadyImaged: false,
    ...overrides,
  };
}

// A window and a single circumpolar-ish declination that stays comfortably
// above the horizon for the whole window at this latitude, so tests aren't
// sensitive to exact rise/set timing.
const WINDOW_START = new Date('2026-01-01T02:00:00Z');
const WINDOW_END = new Date('2026-01-01T04:00:00Z');
const HIGH_DEC = 65; // near-circumpolar at lat 40

describe('generateNightPlan — already-imaged objects', () => {
  it('does not penalize already-imaged objects when unimagedOnly is false', () => {
    // Two otherwise-identical candidates at the same coordinates: one already
    // imaged, one not. With no penalty, either could win a single-slot plan
    // depending on iteration order (score ties), but the imaged one must
    // never be structurally excluded or demoted below a clearly worse object.
    const imaged = candidate({ id: 'imaged', ra: 12, dec: HIGH_DEC, isAlreadyImaged: true });
    const worse = candidate({ id: 'worse', ra: 0, dec: -80 }); // never rises at this latitude

    const blocks = generateNightPlan({
      targets: [imaged, worse],
      observerLat: OBSERVER_LAT,
      observerLon: OBSERVER_LON,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      slotMinutes: 60,
      maxObjects: 1,
      minAlt: 30,
      moonIllumination: 0,
      visibleSkyMap: null,
      unimagedOnly: false,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.target.id).toBe('imaged');
  });

  it('excludes already-imaged objects entirely when unimagedOnly is true', () => {
    const imaged = candidate({ id: 'imaged', ra: 12, dec: HIGH_DEC, isAlreadyImaged: true });

    const blocks = generateNightPlan({
      targets: [imaged],
      observerLat: OBSERVER_LAT,
      observerLon: OBSERVER_LON,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      slotMinutes: 60,
      maxObjects: 1,
      minAlt: 30,
      moonIllumination: 0,
      visibleSkyMap: null,
      unimagedOnly: true,
    });

    expect(blocks).toHaveLength(0);
  });
});

describe('generateNightPlan — named-object tie-break', () => {
  it('uses a continuous score bonus, not a hard tier: a big altitude edge can still beat a named object', () => {
    // Named object sits at a mediocre altitude; an unnamed object sits at a
    // much better altitude (more than the 30-point popularity bonus could
    // ever offset). The unnamed object must win — a hard tiered precedence
    // (named always beats unnamed above the floor) would instead pick the
    // named one regardless of the gap.
    const named = candidate({ id: 'named', ra: 12, dec: 35, commonNames: ['Andromeda Galaxy'] });
    const unnamed = candidate({ id: 'unnamed', ra: 12, dec: HIGH_DEC });

    const blocks = generateNightPlan({
      targets: [named, unnamed],
      observerLat: OBSERVER_LAT,
      observerLon: OBSERVER_LON,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      slotMinutes: 60,
      maxObjects: 1,
      minAlt: 10,
      moonIllumination: 0,
      visibleSkyMap: null,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.target.id).toBe('unnamed');
  });

  it('lets the popularity bonus break a close tie in favor of the named object', () => {
    // Same coordinates (identical altitude), one named, one not: the +30
    // bonus should decide it every time.
    const named = candidate({ id: 'named', ra: 12, dec: HIGH_DEC, commonNames: ['Some Popular Name'] });
    const unnamed = candidate({ id: 'unnamed', ra: 12.001, dec: HIGH_DEC });

    const blocks = generateNightPlan({
      targets: [named, unnamed],
      observerLat: OBSERVER_LAT,
      observerLon: OBSERVER_LON,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      slotMinutes: 60,
      maxObjects: 1,
      minAlt: 10,
      moonIllumination: 0,
      visibleSkyMap: null,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.target.id).toBe('named');
  });
});

describe('generateNightPlan — deterministic golden output', () => {
  it('produces the same schedule for the same input when jitter is 0', () => {
    const targets = [
      candidate({ id: 'a', ra: 5, dec: 45 }),
      candidate({ id: 'b', ra: 10, dec: 60, commonNames: ['Popular A'] }),
      candidate({ id: 'c', ra: 15, dec: 20 }),
      candidate({ id: 'd', ra: 20, dec: -10 }), // low/negative dec, likely excluded at this latitude
    ];

    const params = {
      targets,
      observerLat: OBSERVER_LAT,
      observerLon: OBSERVER_LON,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      slotMinutes: 60,
      maxObjects: 2,
      minAlt: 20,
      moonIllumination: 10,
      visibleSkyMap: null,
      jitter: 0,
    };

    const first = generateNightPlan(params);
    const second = generateNightPlan(params);

    expect(second.map(b => b.target.id)).toEqual(first.map(b => b.target.id));
    expect(first.length).toBeGreaterThan(0);
  });
});

describe('generateNightPlanDetailed — forecast', () => {
  const base = {
    observerLat: OBSERVER_LAT,
    observerLon: OBSERVER_LON,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    slotMinutes: 60,
    maxObjects: 2,
    minAlt: 30,
    moonIllumination: 0,
    visibleSkyMap: null,
  };
  const quality = (cloudCover: number, seeing: number | null = 3) => ({
    cloudCover, seeing, transparency: 3, dewRisk: false, usable: cloudCover <= 60,
  });

  it('leaves cloudy slots empty and reports them', () => {
    const targets = [
      candidate({ id: 'a', ra: 12, dec: HIGH_DEC }),
      candidate({ id: 'b', ra: 13, dec: HIGH_DEC }),
    ];
    const { blocks, skippedSlots } = generateNightPlanDetailed({
      ...base,
      targets,
      skyQuality: (start) => (start.getTime() === WINDOW_START.getTime() ? quality(90) : quality(10)),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start.toISOString()).toBe('2026-01-01T03:00:00.000Z');
    expect(blocks[0]!.sky?.cloudCover).toBe(10);
    expect(skippedSlots).toEqual([{ start: WINDOW_START, end: new Date('2026-01-01T03:00:00Z'), cloudCover: 90 }]);
  });

  it('puts the small target in the steadiest slot', () => {
    // Same coordinates, so altitude is equal: only the seeing term differs.
    const galaxy = candidate({ id: 'galaxy', ra: 12, dec: HIGH_DEC, type: 'Galaxy', majorAxisArcmin: 5 });
    const nebula = candidate({ id: 'nebula', ra: 12, dec: HIGH_DEC, type: 'Emission Nebula', majorAxisArcmin: 120 });
    const { blocks } = generateNightPlanDetailed({
      ...base,
      targets: [nebula, galaxy],
      // first hour: poor seeing, second hour: excellent
      skyQuality: (start) => (start.getTime() === WINDOW_START.getTime() ? quality(10, 5) : quality(10, 1)),
    });
    expect(blocks.map(b => b.target.id)).toEqual(['nebula', 'galaxy']);
  });

  it('plans exactly as before without a forecast', () => {
    const targets = [candidate({ id: 'a', ra: 12, dec: HIGH_DEC })];
    const withNull = generateNightPlanDetailed({ ...base, targets, skyQuality: () => null });
    const without = generateNightPlanDetailed({ ...base, targets });
    expect(withNull.blocks.map(b => [b.target.id, b.start.getTime()])).toEqual(without.blocks.map(b => [b.target.id, b.start.getTime()]));
    expect(without.skippedSlots).toEqual([]);
  });
});

describe('generateNightPlan — filter type and the Moon', () => {
  // 2025-06-21 12:00–13:00 UTC from New York: a target at RA 0h, Dec +30°
  // sits ~70° high and ~34° from the Moon (see moonProximity.test.ts).
  const params = (moonIllumination: number, targets: PlanCandidate[]) => ({
    targets,
    observerLat: 40.7128,
    observerLon: -74.006,
    windowStart: new Date('2025-06-21T12:00:00Z'),
    windowEnd: new Date('2025-06-21T13:00:00Z'),
    slotMinutes: 60,
    maxObjects: 1,
    minAlt: 30,
    moonIllumination,
    visibleSkyMap: null,
  });
  // The galaxy has a common name, so it wins whenever the Moon lets it.
  const galaxy = candidate({ id: 'galaxy', ra: 0, dec: 30, type: 'Spiral Galaxy', commonNames: ['Bright one'] });
  const nebula = candidate({ id: 'nebula', ra: 0.05, dec: 30, type: 'Emission Nebula' });

  it('turns to a narrowband target when the Moon is too close for a galaxy', () => {
    const [block] = generateNightPlan(params(60, [galaxy, nebula]));
    expect(block).toMatchObject({ target: { id: 'nebula' }, filterBand: 'narrowband', moonVerdict: 'ok' });
  });

  it('judges everything broadband when the user has no narrowband gear', () => {
    const [block] = generateNightPlan({ ...params(60, [galaxy, nebula]), narrowbandCapable: false });
    // Both are too close to a 60% Moon for broadband; the plan must not call the nebula narrowband-safe.
    expect(block?.filterBand ?? 'broadband').toBe('broadband');
    expect(block?.moonVerdict ?? 'warning').not.toBe('ok');
  });

  it('keeps the broadband target on a dark night, and says it is broadband', () => {
    const [block] = generateNightPlan(params(0, [galaxy, nebula]));
    expect(block).toMatchObject({ target: { id: 'galaxy' }, filterBand: 'broadband', moonVerdict: 'ok' });
  });
});

describe('generateNightPlan — integration goals', () => {
  const base = {
    observerLat: OBSERVER_LAT,
    observerLon: OBSERVER_LON,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    slotMinutes: 60,
    maxObjects: 1,
    minAlt: 30,
    moonIllumination: 0,
    visibleSkyMap: null,
  };
  const h = (hours: number) => hours * 3600;
  // Same place in the sky: only the popularity and goal terms differ.
  const popular = candidate({ id: 'popular', ra: 12, dec: HIGH_DEC, commonNames: ['Famous'] });
  const project = candidate({
    id: 'project', ra: 12, dec: HIGH_DEC, type: 'Emission Nebula',
    goals: [{ filter: 'L', goalSec: h(10), remainingSec: h(8) }, { filter: 'Ha', goalSec: h(10), remainingSec: h(3) }],
  });

  it('puts an object with time left ahead of a better-known one', () => {
    const [block] = generateNightPlan({ ...base, targets: [popular, project], favorGoals: true });
    expect(block?.target.id).toBe('project');
    expect(block).toMatchObject({ filter: 'L', filterRemainingSec: h(8), filterBand: 'broadband' });
  });

  it('does not let the goal bonus beat a target far higher in the sky', () => {
    const DEC = OBSERVER_LAT; // passes through the zenith, so there is room below it
    const mid = new Date(WINDOW_START.getTime() + 1800_000);
    const slotEnd = new Date(WINDOW_START.getTime() + 3600_000);
    const meanAlt = (ra: number) =>
      [WINDOW_START, mid, slotEnd].map(t => altAz(ra, DEC, OBSERVER_LAT, OBSERVER_LON, t).alt).reduce((a, b) => a + b) / 3;
    const ras = Array.from({ length: 720 }, (_, i) => i * 0.5);
    const topRa = ras.reduce((a, b) => (meanAlt(b) > meanAlt(a) ? b : a));
    const rival = candidate({ id: 'popular', ra: topRa, dec: DEC, commonNames: ['Famous'] });
    // A project `gap` degrees below the rival, still above the 30 degree floor.
    const projectBelow = (gap: number) => {
      const ra = ras
        .filter(r => meanAlt(r) > 31)
        .reduce((a, b) => (Math.abs(meanAlt(topRa) - meanAlt(b) - gap) < Math.abs(meanAlt(topRa) - meanAlt(a) - gap) ? b : a));
      return candidate({ ...project, id: 'project', ra, dec: DEC, commonNames: ['Famous'] });
    };
    const run = (p: PlanCandidate) =>
      generateNightPlan({ ...base, targets: [rival, p], favorGoals: true })[0]?.target.id;
    // Inside the allowed deficit the bonus still wins; well beyond it, it cannot.
    expect(run(projectBelow(MAX_GOAL_ALT_DEFICIT - 8))).toBe('project');
    expect(run(projectBelow(MAX_GOAL_ALT_DEFICIT + 15))).toBe('popular');
  });

  it('plans exactly as before when the switch is off', () => {
    const [block] = generateNightPlan({ ...base, targets: [popular, project] });
    expect(block?.target.id).toBe('popular');
    expect(block?.filter).toBeUndefined();
  });

  it('leaves out objects whose goals are all reached, and says which', () => {
    const done = candidate({
      id: 'done', ra: 12, dec: HIGH_DEC, commonNames: ['Done'],
      goals: [{ filter: 'L', goalSec: h(5), remainingSec: 0 }],
    });
    const result = generateNightPlanDetailed({ ...base, maxObjects: 2, targets: [done, popular], favorGoals: true });
    expect(result.blocks.map(b => b.target.id)).toEqual(['popular']);
    expect(result.goalsComplete.map(t => t.id)).toEqual(['done']);
    // Off: the finished object competes as usual.
    expect(generateNightPlanDetailed({ ...base, maxObjects: 2, targets: [done, popular] }).goalsComplete).toEqual([]);
  });

  describe('with the Moon up', () => {
    // Same scene as "filter type and the Moon": ~34° from a 60 % Moon, too
    // close for broadband, fine for narrowband.
    const moonParams = {
      observerLat: 40.7128,
      observerLon: -74.006,
      windowStart: new Date('2025-06-21T12:00:00Z'),
      windowEnd: new Date('2025-06-21T13:00:00Z'),
      slotMinutes: 60,
      maxObjects: 1,
      minAlt: 30,
      moonIllumination: 60,
      visibleSkyMap: null,
      favorGoals: true,
    };
    const near = (over: Partial<PlanCandidate>) => candidate({ ra: 0, dec: 30, ...over });

    it('picks the narrowband filter with time left when broadband is ruled out', () => {
      const [block] = generateNightPlan({
        ...moonParams,
        targets: [near({ id: 'project', type: 'Emission Nebula', goals: project.goals })],
      });
      expect(block).toMatchObject({ filter: 'Ha', filterRemainingSec: h(3), filterBand: 'narrowband', moonVerdict: 'ok' });
    });

    it('skips an object whose only time left is in broadband', () => {
      const galaxy = near({ id: 'galaxy', type: 'Spiral Galaxy', goals: [{ filter: 'L', goalSec: h(10), remainingSec: h(9) }] });
      expect(generateNightPlan({ ...moonParams, targets: [galaxy] })).toEqual([]);
    });
  });
});

describe('goalBonus', () => {
  it('grows with the share of time left', () => {
    expect(goalBonus([])).toBe(0);
    expect(goalBonus([{ filter: 'L', goalSec: 100, remainingSec: 0 }])).toBe(0);
    expect(goalBonus([{ filter: 'L', goalSec: 100, remainingSec: 100 }])).toBe(45);
    expect(goalBonus([{ filter: 'L', goalSec: 100, remainingSec: 50 }, { filter: 'R', goalSec: 100, remainingSec: 0 }])).toBe(35.25);
  });
});
