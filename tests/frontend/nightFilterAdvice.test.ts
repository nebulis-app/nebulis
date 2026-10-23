import { describe, it, expect, vi } from 'vitest';

// The Moon's hours are the input under test; the ephemeris itself is covered
// by plannerNight.test.ts.
const up = vi.hoisted(() => ({ intervals: [] as { start: number; end: number }[] }));
vi.mock('../../src/lib/plannerNight', () => ({ moonUpIntervals: () => up.intervals }));

import { nightFilterAdvice } from '../../src/lib/nightFilterAdvice';

const darkStart = new Date('2026-09-05T20:00:00Z');
const darkEnd = new Date('2026-09-06T04:00:00Z'); // 8 h
const at = (h: number) => darkStart.getTime() + h * 3_600_000;
const advice = (moonIllumination: number, intervals: [number, number][]) => {
  up.intervals = intervals.map(([a, b]) => ({ start: at(a), end: at(b) }));
  return nightFilterAdvice({ darkStart, darkEnd, lat: 45.6, lon: 6.1, moonIllumination });
};

describe('nightFilterAdvice', () => {
  it('leaves the night to broadband under a faint or absent Moon', () => {
    expect(advice(10, [[0, 8]])).toEqual({ kind: 'broadband' });
    expect(advice(90, [])).toEqual({ kind: 'broadband' });
    expect(advice(90, [[7.5, 8]])).toEqual({ kind: 'broadband' }); // up 6 % of the night
  });

  it('makes it a narrowband night when a bright Moon is up nearly all night', () => {
    expect(advice(80, [[0, 8]])).toEqual({ kind: 'narrowband' });
  });

  it('splits the night at moonset or moonrise', () => {
    expect(advice(60, [[0, 3]])).toEqual({ kind: 'broadbandFrom', at: new Date(at(3)) });
    expect(advice(60, [[5, 8]])).toEqual({ kind: 'broadbandUntil', at: new Date(at(5)) });
  });

  it('falls back to narrowband when the Moon rises and sets inside the night', () => {
    expect(advice(60, [[2, 6]])).toEqual({ kind: 'narrowband' });
  });
});
