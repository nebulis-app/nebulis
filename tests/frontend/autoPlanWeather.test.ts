import { describe, it, expect } from 'vitest';
import { mergeSkipped } from '../../src/lib/planWeather';

const d = (hm: string) => new Date(`2026-10-14T${hm}:00Z`);

describe('mergeSkipped', () => {
  it('merges back-to-back cloudy slots and keeps the worst cloud cover', () => {
    expect(mergeSkipped([
      { start: d('23:00'), end: d('23:30'), cloudCover: 90 },
      { start: d('22:00'), end: d('22:30'), cloudCover: 70 },
      { start: d('22:30'), end: d('23:00'), cloudCover: 80 },
      { start: d('01:00'), end: d('01:30'), cloudCover: 65 },
    ])).toEqual([
      { start: d('01:00'), end: d('01:30'), cloudCover: 65 },
      { start: d('22:00'), end: d('23:30'), cloudCover: 90 },
    ]);
  });
});
