import { describe, expect, it } from 'vitest';
import { placeMovingBody, positionAt } from '../../src/lib/cometPosition';
import type { EphemerisRow } from '../../src/lib/api/planner';

// C/2023 A3 from Paris on 14 October 2024, as Horizons gave it (tests/fixtures/horizons/a3-3days.json).
const ROWS: EphemerisRow[] = [
  { t: '2024-10-14T18:00:00.000Z', ra: 223.34130 / 15, dec: 0.15061, az: 256.65, alt: 11.47, mag: 6 },
  { t: '2024-10-14T19:00:00.000Z', ra: 223.55974 / 15, dec: 0.17346, az: 268.01, alt: 1.84, mag: 6 },
  { t: '2024-10-14T20:00:00.000Z', ra: 223.77792 / 15, dec: 0.19623, az: 279.25, alt: -7.86, mag: 6 },
];

describe('positionAt', () => {
  it('is the row itself on the hour, and between rows in between', () => {
    const onHour = positionAt(ROWS, new Date('2024-10-14T19:00:00Z'))!;
    expect(onHour.ra).toBeCloseTo(ROWS[1].ra, 10);
    expect(onHour.dec).toBeCloseTo(ROWS[1].dec, 10);
    const p = positionAt(ROWS, new Date('2024-10-14T19:15:00Z'))!;
    expect(p.ra).toBeCloseTo(ROWS[1].ra + 0.25 * (ROWS[2].ra - ROWS[1].ra), 10);
    expect(p.dec).toBeCloseTo(ROWS[1].dec + 0.25 * (ROWS[2].dec - ROWS[1].dec), 10);
  });

  it('is null outside the rows', () => {
    expect(positionAt(ROWS, new Date('2024-10-14T17:59:00Z'))).toBeNull();
    expect(positionAt([], new Date())).toBeNull();
  });
});

describe('placeMovingBody', () => {
  const block = { objectId: 'C/2023 A3', ra: 0, dec: 0, startTime: '2024-10-14T18:00:00.000Z', endTime: '2024-10-14T20:00:00.000Z', notes: 'x' };

  it("puts a comet's block where the comet is at the block's middle", () => {
    const placed = placeMovingBody(block, new Map([['C/2023 A3', ROWS]]));
    expect(placed).toMatchObject({ objectId: 'C/2023 A3', notes: 'x', startTime: block.startTime });
    expect(placed.ra).toBeCloseTo(ROWS[1].ra, 10);
    expect(placed.dec).toBeCloseTo(ROWS[1].dec, 10);
  });

  it('leaves any other object, and a block outside the rows, as it was', () => {
    expect(placeMovingBody({ ...block, objectId: 'M42' }, new Map([['C/2023 A3', ROWS]]))).toEqual({ ...block, objectId: 'M42' });
    const late = { ...block, startTime: '2024-10-15T02:00:00.000Z', endTime: '2024-10-15T03:00:00.000Z' };
    expect(placeMovingBody(late, new Map([['C/2023 A3', ROWS]]))).toBe(late);
  });
});
