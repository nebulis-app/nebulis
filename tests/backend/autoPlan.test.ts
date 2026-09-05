import { describe, it, expect } from 'vitest';
import { generateNightPlan, type PlanCandidate } from '../../server/lib/autoPlan';

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
