import { describe, expect, it } from 'vitest';
import { nightsNeeded } from '../../src/lib/nightsNeeded';
import { telescopeIdOfFovProfile, telescopeProfileOptionId } from '../../src/lib/telescopeFov';
import type { ObjectIntegrationProgress } from '../../src/lib/api/library';
import type { TelescopeNightRate } from '../../src/lib/api/telescopes';

const H = 3600;
const progress = (remaining: number[], complete = false): ObjectIntegrationProgress => ({
  objectId: 'NGC 6888',
  complete,
  filters: remaining.map((r, i) => ({ filter: `F${i}`, goalSec: 10 * H, exposureSec: 10 * H - r, remainingSec: r })),
} as ObjectIntegrationProgress);
const rate = (medianNightSec: number | null, keptRatio: number | null = null): TelescopeNightRate => ({
  telescopeId: 'rig-1', nights: 5, medianNightSec, reviewedFrames: keptRatio == null ? 0 : 100, keptRatio,
});

describe('nightsNeeded', () => {
  it('divides the time left on every filter by a usual night, rounding up', () => {
    expect(nightsNeeded(progress([4 * H, 2 * H]), rate(4 * H))).toEqual({ nights: 2, usableNightSec: 4 * H });
    expect(nightsNeeded(progress([4 * H + 60]), rate(4 * H))?.nights).toBe(2);
  });

  it('counts only the kept share of a night when reviews say how much is kept', () => {
    expect(nightsNeeded(progress([6 * H]), rate(4 * H, 0.75))).toEqual({ nights: 2, usableNightSec: 3 * H });
    expect(nightsNeeded(progress([6 * H]), rate(4 * H, 0.5))?.nights).toBe(3);
  });

  it('says nothing without a rate, with nothing left, or once complete', () => {
    expect(nightsNeeded(progress([4 * H]), null)).toBeNull();
    expect(nightsNeeded(progress([4 * H]), rate(null))).toBeNull();
    expect(nightsNeeded(progress([0, 0]), rate(4 * H))).toBeNull();
    expect(nightsNeeded(progress([4 * H], true), rate(4 * H))).toBeNull();
    expect(nightsNeeded(progress([4 * H]), rate(4 * H, 0))).toBeNull();
  });
});

describe('telescopeIdOfFovProfile', () => {
  it('reads the telescope out of a framing pick, with or without an optical configuration', () => {
    expect(telescopeIdOfFovProfile(telescopeProfileOptionId('rig-1'))).toBe('rig-1');
    expect(telescopeIdOfFovProfile(telescopeProfileOptionId('rig-1', 'reducer'))).toBe('rig-1');
  });

  it('is null for a preset or custom optics', () => {
    expect(telescopeIdOfFovProfile('seestar-s50')).toBeNull();
    expect(telescopeIdOfFovProfile('custom')).toBeNull();
  });
});
