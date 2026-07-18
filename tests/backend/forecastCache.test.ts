import { describe, it, expect } from 'vitest';
import {
  map7TimerSeeing,
  map7TimerTransparency,
  map7TimerCloud,
  interpolateSeeingTransparency,
  rateNightConditions,
  getMoonPhaseName,
  parseSevenTimerInit,
  parseOpenMeteoHour,
  defaultNightDate,
  type ForecastHour,
} from '../../server/lib/forecastCache';

describe('map7TimerSeeing', () => {
  it('maps codes 1-2 to 1 (Excellent)', () => {
    expect(map7TimerSeeing(1)).toBe(1);
    expect(map7TimerSeeing(2)).toBe(1);
  });

  it('maps code 3 to 2 (Good)', () => {
    expect(map7TimerSeeing(3)).toBe(2);
  });

  it('maps codes 4-5 to 3 (Average)', () => {
    expect(map7TimerSeeing(4)).toBe(3);
    expect(map7TimerSeeing(5)).toBe(3);
  });

  it('maps code 6 to 4 (Poor)', () => {
    expect(map7TimerSeeing(6)).toBe(4);
  });

  it('maps codes 7-8 to 5 (Bad)', () => {
    expect(map7TimerSeeing(7)).toBe(5);
    expect(map7TimerSeeing(8)).toBe(5);
  });
});

describe('map7TimerTransparency', () => {
  it('passes the raw 1-8 scale through unchanged', () => {
    expect(map7TimerTransparency(1)).toBe(1);
    expect(map7TimerTransparency(8)).toBe(8);
  });
});

describe('map7TimerCloud', () => {
  it('maps known codes 0-9 through the lookup array', () => {
    expect(map7TimerCloud(0)).toBe(0);
    expect(map7TimerCloud(1)).toBe(3);
    expect(map7TimerCloud(9)).toBe(97);
  });

  it('falls back to code * 11 for a code outside the lookup array', () => {
    expect(map7TimerCloud(10)).toBe(110);
  });
});

describe('interpolateSeeingTransparency', () => {
  it('linearly interpolates seeing (and paired transparency) between two anchors', () => {
    const hours = [
      { seeing: 1, transparency: 2 },
      { seeing: null, transparency: null },
      { seeing: null, transparency: null },
      { seeing: 4, transparency: 8 },
    ];
    interpolateSeeingTransparency(hours);
    expect(hours.map(h => h.seeing)).toEqual([1, 2, 3, 4]);
    expect(hours.map(h => h.transparency)).toEqual([2, 4, 6, 8]);
  });

  it('copies the next anchor backward for hours before the first anchor', () => {
    const hours = [
      { seeing: null, transparency: null },
      { seeing: null, transparency: null },
      { seeing: 3, transparency: 5 },
    ];
    interpolateSeeingTransparency(hours);
    expect(hours.map(h => h.seeing)).toEqual([3, 3, 3]);
    expect(hours.map(h => h.transparency)).toEqual([5, 5, 5]);
  });

  it('copies the previous anchor forward for hours after the last anchor', () => {
    const hours = [
      { seeing: 2, transparency: 4 },
      { seeing: null, transparency: null },
      { seeing: null, transparency: null },
    ];
    interpolateSeeingTransparency(hours);
    expect(hours.map(h => h.seeing)).toEqual([2, 2, 2]);
    expect(hours.map(h => h.transparency)).toEqual([4, 4, 4]);
  });

  it('leaves an all-null array untouched (no anchors to interpolate from)', () => {
    const hours = [
      { seeing: null, transparency: null },
      { seeing: null, transparency: null },
    ];
    interpolateSeeingTransparency(hours);
    expect(hours.map(h => h.seeing)).toEqual([null, null]);
  });

  it('does not interpolate transparency when one flanking anchor lacks it', () => {
    const hours = [
      { seeing: 1, transparency: null },
      { seeing: null, transparency: null },
      { seeing: 4, transparency: 8 },
    ];
    interpolateSeeingTransparency(hours);
    expect(hours[1].seeing).toBe(3); // (1 + 4*2)/3 rounded = round(1*(1/3)+4*(2/3)) = 3
    expect(hours[1].transparency).toBeNull();
  });
});

function mkHour(overrides: Partial<ForecastHour>): ForecastHour {
  return {
    time: '2026-06-21T00:00:00.000Z',
    cloudCover: 0,
    cloudCoverLow: 0,
    cloudCoverMid: 0,
    cloudCoverHigh: 0,
    seeing: null,
    transparency: null,
    humidity: 0,
    temperature: 0,
    dewPoint: 0,
    wind: 0,
    visibility: null,
    precipProb: 0,
    jetStream: null,
    cape: null,
    ...overrides,
  };
}

describe('rateNightConditions', () => {
  it('scores a perfectly clear, calm, dry night as 100/Excellent', () => {
    const hours = [mkHour({ cloudCover: 0, humidity: 0, wind: 0, precipProb: 0 })];
    const result = rateNightConditions(hours);
    expect(result.score).toBe(100);
    expect(result.rating).toBe('Excellent');
  });

  it('scores a fully overcast, rainy, windy night near 0/Bad', () => {
    const hours = [mkHour({ cloudCover: 100, humidity: 100, wind: 60, precipProb: 100 })];
    const result = rateNightConditions(hours);
    expect(result.score).toBe(0);
    expect(result.rating).toBe('Bad');
  });

  it('averages across multiple hours rather than scoring only one', () => {
    const hours = [
      mkHour({ cloudCover: 0, humidity: 0, wind: 0, precipProb: 0 }),
      mkHour({ cloudCover: 100, humidity: 0, wind: 0, precipProb: 0 }),
    ];
    const result = rateNightConditions(hours);
    // avgCloud = 50 -> score = 100 - 50*0.6 = 70
    expect(result.avgCloudCover).toBe(50);
    expect(result.score).toBe(70);
    expect(result.rating).toBe('Good');
  });

  it('does not penalize humidity at or below the 60% floor', () => {
    const hours = [mkHour({ cloudCover: 0, humidity: 60, wind: 0, precipProb: 0 })];
    expect(rateNightConditions(hours).score).toBe(100);
  });

  it('does not penalize wind at or below the 15 km/h floor', () => {
    const hours = [mkHour({ cloudCover: 0, humidity: 0, wind: 15, precipProb: 0 })];
    expect(rateNightConditions(hours).score).toBe(100);
  });

  it.each([
    [80, 'Excellent'],
    [60, 'Good'],
    [40, 'Fair'],
    [20, 'Poor'],
    [19, 'Bad'],
  ])('rates score %d as %s', (targetScore, expectedRating) => {
    // Only cloud cover contributes (0.6 per %), so pick cloudCover to land
    // exactly on the target score with everything else at its zero-penalty floor.
    const cloudCover = (100 - targetScore) / 0.6;
    const hours = [mkHour({ cloudCover, humidity: 0, wind: 0, precipProb: 0 })];
    const result = rateNightConditions(hours);
    expect(result.rating).toBe(expectedRating);
  });
});

describe('getMoonPhaseName', () => {
  it('names New Moon at phase 0 and near 1', () => {
    expect(getMoonPhaseName(0)).toBe('New Moon');
    expect(getMoonPhaseName(0.99)).toBe('New Moon');
  });

  it('names the four primary phases at their canonical values', () => {
    expect(getMoonPhaseName(0.25)).toBe('First Quarter');
    expect(getMoonPhaseName(0.5)).toBe('Full Moon');
    expect(getMoonPhaseName(0.75)).toBe('Last Quarter');
  });

  it('names the waxing/waning phases between the primaries', () => {
    expect(getMoonPhaseName(0.1)).toBe('Waxing Crescent');
    expect(getMoonPhaseName(0.35)).toBe('Waxing Gibbous');
    expect(getMoonPhaseName(0.6)).toBe('Waning Gibbous');
    expect(getMoonPhaseName(0.9)).toBe('Waning Crescent');
  });

  it('resolves the exact boundary values to the phase below the cutoff', () => {
    // Each branch is a strict `<`, so the boundary value itself falls to the next branch.
    expect(getMoonPhaseName(0.03)).toBe('Waxing Crescent');
    expect(getMoonPhaseName(0.22)).toBe('First Quarter');
    expect(getMoonPhaseName(0.28)).toBe('Waxing Gibbous');
    expect(getMoonPhaseName(0.47)).toBe('Full Moon');
    expect(getMoonPhaseName(0.53)).toBe('Waning Gibbous');
    expect(getMoonPhaseName(0.72)).toBe('Last Quarter');
    expect(getMoonPhaseName(0.78)).toBe('Waning Crescent');
  });
});

describe('parseSevenTimerInit', () => {
  it('parses the 10-digit YYYYMMDDHH init string as a UTC instant', () => {
    expect(parseSevenTimerInit('2024011512').toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });
});

describe('parseOpenMeteoHour', () => {
  it('parses a date+time value in the given IANA zone (UTC)', () => {
    expect(parseOpenMeteoHour('2026-06-21T14:00', 'UTC').toISOString()).toBe(
      '2026-06-21T14:00:00.000Z',
    );
  });

  it('defaults the time part to midnight when absent', () => {
    expect(parseOpenMeteoHour('2026-06-21', 'UTC').toISOString()).toBe(
      '2026-06-21T00:00:00.000Z',
    );
  });
});

describe('defaultNightDate', () => {
  it('returns the current calendar day at or after 7am local', () => {
    expect(defaultNightDate(new Date('2026-06-21T07:00:00.000Z'), 'UTC')).toBe('2026-06-21');
    expect(defaultNightDate(new Date('2026-06-21T23:00:00.000Z'), 'UTC')).toBe('2026-06-21');
  });

  it('returns the previous calendar day before 7am local (still counts as last night)', () => {
    expect(defaultNightDate(new Date('2026-06-21T06:59:00.000Z'), 'UTC')).toBe('2026-06-20');
    expect(defaultNightDate(new Date('2026-06-21T00:00:00.000Z'), 'UTC')).toBe('2026-06-20');
  });
});
