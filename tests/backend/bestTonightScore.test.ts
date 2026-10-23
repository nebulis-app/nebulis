import { describe, it, expect } from 'vitest';
import { computeBestTonightScore, type BestTonightScoreInput } from '../../server/lib/bestTonightScore';

// An 8-hour dark window, 20:00Z -> 04:00Z; midnight is 00:00Z.
const NIGHT_START = new Date('2026-10-08T20:00:00Z');
const NIGHT_END = new Date('2026-10-09T04:00:00Z');

function target(overrides: Partial<BestTonightScoreInput> = {}): BestTonightScoreInput {
  return {
    maxAlt: 45,
    risesAt: null,
    setsAt: null,
    magnitude: null,
    maxAltTime: null,
    majorAxisArcmin: null,
    ...overrides,
  };
}

describe('computeBestTonightScore — altitude component', () => {
  it('normalizes 45 degrees to 0.5', () => {
    expect(computeBestTonightScore(target({ maxAlt: 45 }), NIGHT_START, NIGHT_END).altScore).toBe(0.5);
  });

  it('clamps negative altitude to 0 and >90 to 1', () => {
    expect(computeBestTonightScore(target({ maxAlt: -10 }), NIGHT_START, NIGHT_END).altScore).toBe(0);
    expect(computeBestTonightScore(target({ maxAlt: 120 }), NIGHT_START, NIGHT_END).altScore).toBe(1);
  });
});

describe('computeBestTonightScore — visible duration', () => {
  it('treats a target with no rise/set as visible the whole 8h night', () => {
    const s = computeBestTonightScore(target(), NIGHT_START, NIGHT_END);
    expect(s.durationHours).toBe(8);
    expect(s.durationScore).toBe(1);
  });

  it('clamps rise/set to the dark window', () => {
    const s = computeBestTonightScore(
      target({ risesAt: '2026-10-08T18:00:00Z', setsAt: '2026-10-09T00:00:00Z' }),
      NIGHT_START, NIGHT_END,
    );
    expect(s.durationHours).toBe(4);
    expect(s.durationScore).toBe(0.5);
  });

  it('gives zero duration when the target sets before the night starts', () => {
    const s = computeBestTonightScore(
      target({ risesAt: '2026-10-08T10:00:00Z', setsAt: '2026-10-08T15:00:00Z' }),
      NIGHT_START, NIGHT_END,
    );
    expect(s.durationHours).toBe(0);
    expect(s.durationScore).toBe(0);
  });

  it('falls back to all-night when a rise/set string is unparseable', () => {
    const s = computeBestTonightScore(
      target({ risesAt: 'not-a-date', setsAt: '2026-10-09T00:00:00Z' }),
      NIGHT_START, NIGHT_END,
    );
    expect(s.durationHours).toBe(8);
  });
});

describe('computeBestTonightScore — magnitude', () => {
  it('maps mag 5 -> 1, mag 9 -> 0.5, mag 13 -> 0', () => {
    const at = (m: number) => computeBestTonightScore(target({ magnitude: m }), NIGHT_START, NIGHT_END).magScore;
    expect(at(5)).toBe(1);
    expect(at(9)).toBe(0.5);
    expect(at(13)).toBe(0);
  });

  it('clamps very bright and very faint magnitudes into 0..1', () => {
    const at = (m: number) => computeBestTonightScore(target({ magnitude: m }), NIGHT_START, NIGHT_END).magScore;
    expect(at(-2)).toBe(1);
    expect(at(18)).toBe(0);
  });

  it('uses 0.3 for unknown or non-finite magnitude', () => {
    expect(computeBestTonightScore(target({ magnitude: null }), NIGHT_START, NIGHT_END).magScore).toBe(0.3);
    expect(computeBestTonightScore(target({ magnitude: NaN }), NIGHT_START, NIGHT_END).magScore).toBe(0.3);
  });
});

describe('computeBestTonightScore — transit timing', () => {
  it('scores 1 for transit exactly at mid-night', () => {
    const s = computeBestTonightScore(target({ maxAltTime: '2026-10-09T00:00:00Z' }), NIGHT_START, NIGHT_END);
    expect(s.transitScore).toBe(1);
  });

  it('scores 0.5 for transit 3h off and 0 for 6h or more off', () => {
    const at = (iso: string) => computeBestTonightScore(target({ maxAltTime: iso }), NIGHT_START, NIGHT_END).transitScore;
    expect(at('2026-10-09T03:00:00Z')).toBe(0.5);
    expect(at('2026-10-08T18:00:00Z')).toBe(0);
    expect(at('2026-10-08T12:00:00Z')).toBe(0);
  });

  it('defaults to 0.5 when transit time is missing or invalid', () => {
    expect(computeBestTonightScore(target({ maxAltTime: null }), NIGHT_START, NIGHT_END).transitScore).toBe(0.5);
    expect(computeBestTonightScore(target({ maxAltTime: 'garbage' }), NIGHT_START, NIGHT_END).transitScore).toBe(0.5);
  });
});

describe('computeBestTonightScore — angular size fit', () => {
  const at = (arcmin: number | null) =>
    computeBestTonightScore(target({ majorAxisArcmin: arcmin }), NIGHT_START, NIGHT_END).sizeScore;

  it('scores 1 inside the 5..80 arcmin sweet spot (inclusive)', () => {
    expect(at(5)).toBe(1);
    expect(at(30)).toBe(1);
    expect(at(80)).toBe(1);
  });

  it('scales linearly below 5 arcmin', () => {
    expect(at(2.5)).toBe(0.5);
  });

  it('decays over 120 arcmin above 80 and floors at 0', () => {
    expect(at(140)).toBe(0.5);
    expect(at(200)).toBe(0);
    expect(at(500)).toBe(0);
  });

  it('defaults to 0.5 for unknown or non-positive size', () => {
    expect(at(null)).toBe(0.5);
    expect(at(0)).toBe(0.5);
    expect(at(-3)).toBe(0.5);
  });
});

describe('computeBestTonightScore — total', () => {
  it('weights the components 30/30/20/10/10', () => {
    // alt 0.5, duration 1, mag 0.3 default, transit 0.5 default, size 0.5 default
    const s = computeBestTonightScore(target(), NIGHT_START, NIGHT_END);
    expect(s.total).toBeCloseTo(0.5 * 0.3 + 1 * 0.3 + 0.3 * 0.2 + 0.5 * 0.1 + 0.5 * 0.1, 10);
  });

  it('reaches 1.0 for an ideal target', () => {
    const s = computeBestTonightScore(
      target({ maxAlt: 90, magnitude: 4, maxAltTime: '2026-10-09T00:00:00Z', majorAxisArcmin: 30 }),
      NIGHT_START, NIGHT_END,
    );
    expect(s.total).toBeCloseTo(1, 10);
  });
});
