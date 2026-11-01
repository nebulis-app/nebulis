import { describe, it, expect } from 'vitest';
import { buildMoonTrack, moonPenaltyFor } from '../../server/lib/tonightMoon';

// Franklin, TN on 2026-10-29: an 88% waning gibbous that rises in the evening.
const LAT = 35.9;
const LON = -86.9;
const START = new Date('2026-10-29T00:30:00Z');
const END = new Date('2026-10-29T10:40:00Z');

describe('moonPenaltyFor', () => {
  const track = buildMoonTrack(LAT, LON, START, END, 88);

  it('is 0 when the object has no rise time', () => {
    expect(moonPenaltyFor(track, { ra: 3.8, dec: 24, type: 'Open Cluster' }, null, null)).toBe(0);
  });

  it('is 0 with a new Moon', () => {
    const dark = buildMoonTrack(LAT, LON, START, END, 0);
    expect(moonPenaltyFor(dark, { ra: 3.8, dec: 24, type: 'Open Cluster' }, START, END)).toBe(0);
  });

  it('is within 0-1 and larger for a broadband target than a narrowband one at the same spot', () => {
    const spot = { ra: 3.8, dec: 24 };
    const broad = moonPenaltyFor(track, { ...spot, type: 'Open Cluster' }, START, END);
    const narrow = moonPenaltyFor(track, { ...spot, type: 'Emission Nebula' }, START, END);
    expect(broad).toBeGreaterThanOrEqual(0);
    expect(broad).toBeLessThanOrEqual(1);
    expect(narrow).toBeLessThanOrEqual(broad);
  });

  it('ignores the part of the night outside the object\'s rise and set', () => {
    const spot = { ra: 3.8, dec: 24, type: 'Open Cluster' };
    const all = moonPenaltyFor(track, spot, START, END);
    const before = moonPenaltyFor(track, spot, START, new Date('2026-10-29T01:00:00Z'));
    expect(before).toBeLessThanOrEqual(all + 1e-9);
  });
});
