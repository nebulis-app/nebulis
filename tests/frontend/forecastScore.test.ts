import { describe, it, expect } from 'vitest';
import {
  calculateVisibilityScore,
  smoothHours,
  scoreHex,
  scoreRingColor,
  scoreTextColor,
  scoreLabel,
  scoreBgColor,
  translateScoreRating,
  localHour,
  formatTime,
  formatTemp,
  formatWind,
  type TFunc,
} from '../../src/lib/forecastScore';
import type { ForecastHour } from '../../src/lib/api/planner';

// Echo translator: returns the key so assertions can name the exact band/recommendation.
const t: TFunc = (key) => key;

const MIDNIGHT = '2026-10-09T00:00:00Z';
const DARK = { start: Date.parse('2026-10-08T20:00:00Z'), end: Date.parse('2026-10-09T04:00:00Z') };

function hour(overrides: Partial<ForecastHour> = {}): ForecastHour {
  return {
    time: MIDNIGHT,
    cloudCover: 0,
    cloudCoverLow: 0,
    cloudCoverMid: 0,
    cloudCoverHigh: 0,
    seeing: 1,
    transparency: null,
    humidity: 40,
    temperature: 10,
    dewPoint: 0,
    wind: 5,
    visibility: null,
    precipProb: 0,
    jetStream: null,
    cape: null,
    ...overrides,
  };
}

describe('calculateVisibilityScore', () => {
  it('scores a perfect dark, clear, new-moon hour at 100 (capped)', () => {
    const r = calculateVisibilityScore(hour(), 0, 'UTC', DARK, t);
    // raw = 0.6 + 0.2 + 0.2 + 0.1 = 1.1 -> capped to 100
    expect(r.score).toBe(100);
    expect(r.label).toBe('scoreBand.ideal');
    expect(r.hex).toBe('#34d399');
    expect(r.breakdown).toEqual({ clouds: 100, seeing: 100, moon: 100, transparency: 100 });
    expect(r.recommendation).toBe('scoreRecommendation.darkSkies');
  });

  it('applies the full moon penalty only inside the dark window', () => {
    const inside = calculateVisibilityScore(hour(), 100, 'UTC', DARK, t);
    const outside = calculateVisibilityScore(hour({ time: '2026-10-08T15:00:00Z' }), 100, 'UTC', DARK, t);
    expect(inside.breakdown.moon).toBe(0);
    expect(inside.score).toBe(90);
    expect(outside.breakdown.moon).toBe(100);
  });

  it('falls back to a 19:00-05:00 local band when no dark window is known', () => {
    const night = calculateVisibilityScore(hour({ time: '2026-10-08T22:00:00Z' }), 100, 'UTC', null, t);
    const day = calculateVisibilityScore(hour({ time: '2026-10-08T12:00:00Z' }), 100, 'UTC', null, t);
    expect(night.breakdown.moon).toBe(0);
    expect(day.breakdown.moon).toBe(100);
  });

  it('defaults seeing to 0.5 when null and subtracts jet-stream and CAPE penalties', () => {
    expect(calculateVisibilityScore(hour({ seeing: null }), 0, 'UTC', DARK, t).breakdown.seeing).toBe(50);
    // seeing 1 (1.0) - jet 0.25 (80..120) - cape 0.10 (500..1500) = 0.65
    const r = calculateVisibilityScore(hour({ jetStream: 100, cape: 800 }), 0, 'UTC', DARK, t);
    expect(r.breakdown.seeing).toBe(65);
  });

  it('never drives seeing below zero', () => {
    const r = calculateVisibilityScore(hour({ seeing: 5, jetStream: 200, cape: 3000 }), 0, 'UTC', DARK, t);
    expect(r.breakdown.seeing).toBe(0);
  });

  it('reduces transparency linearly above 40% humidity', () => {
    expect(calculateVisibilityScore(hour({ humidity: 70 }), 0, 'UTC', DARK, t).breakdown.transparency).toBe(50);
    expect(calculateVisibilityScore(hour({ humidity: 100 }), 0, 'UTC', DARK, t).breakdown.transparency).toBe(0);
  });

  it('flags dew risk when temperature is within 3C of dew point', () => {
    expect(calculateVisibilityScore(hour({ temperature: 5, dewPoint: 3 }), 0, 'UTC', DARK, t).dewWarning).toBe(true);
    expect(calculateVisibilityScore(hour({ temperature: 6, dewPoint: 3 }), 0, 'UTC', DARK, t).dewWarning).toBe(false);
  });

  it('recommends "overcast" for a fully clouded, bad-seeing, full-moon hour', () => {
    const r = calculateVisibilityScore(hour({ cloudCover: 100, seeing: 5, humidity: 100 }), 100, 'UTC', DARK, t);
    expect(r.score).toBe(0);
    expect(r.label).toBe('scoreBand.bad');
    expect(r.recommendation).toBe('scoreRecommendation.overcast');
  });

  it('uses the night-theme red ladder when isNightTheme is set', () => {
    const r = calculateVisibilityScore(hour(), 0, 'UTC', DARK, t, true);
    expect(r.hex).toBe('#cc3333');
    expect(r.color).toBe('text-[#cc3333]');
  });
});

describe('score band helpers', () => {
  it('maps band boundaries to the right hex', () => {
    expect(scoreHex(85)).toBe('#34d399');
    expect(scoreHex(84)).toBe('#10b981');
    expect(scoreHex(55)).toBe('#60a5fa');
    expect(scoreHex(40)).toBe('#fbbf24');
    expect(scoreHex(25)).toBe('#f97316');
    expect(scoreHex(24)).toBe('#ef4444');
  });

  it('falls back to the lowest band for negative scores', () => {
    expect(scoreHex(-5)).toBe('#ef4444');
    expect(scoreRingColor(-5, true)).toBe('stroke-[#4d1414]');
  });

  it('returns ring and text classes consistent with the band', () => {
    expect(scoreRingColor(72)).toBe('stroke-emerald-500');
    expect(scoreTextColor(60)).toBe('text-blue-400');
    expect(scoreTextColor(60, true)).toBe('text-[#a02828]');
  });

  it('scoreLabel passes the band key through the translator with common ns', () => {
    const calls: Array<[string, unknown]> = [];
    const spy: TFunc = (k, o) => { calls.push([k, o]); return `T:${k}`; };
    expect(scoreLabel(45, spy)).toBe('T:scoreBand.fair');
    expect(calls).toEqual([['scoreBand.fair', { ns: 'common' }]]);
  });

  it('scoreBgColor picks dark, light, and night variants', () => {
    expect(scoreBgColor(90, true)).toBe('bg-emerald-500/10 border-emerald-500/30');
    expect(scoreBgColor(90, false)).toBe('bg-emerald-50 border-emerald-200');
    expect(scoreBgColor(10, true)).toBe('bg-red-500/5 border-red-500/20');
    expect(scoreBgColor(10, false, true)).toBe('bg-[#661a1a]/5 border-[#661a1a]/20');
  });

  it('translateScoreRating maps known server ratings and passes unknown text through', () => {
    expect(translateScoreRating(t, 'Excellent')).toBe('scoreBand.excellent');
    expect(translateScoreRating(t, 'Mystery')).toBe('Mystery');
  });
});

describe('smoothHours', () => {
  it('averages each hour with its neighbours and rounds', () => {
    const out = smoothHours([hour({ cloudCover: 0 }), hour({ cloudCover: 100 }), hour({ cloudCover: 50 })]);
    expect(out.map(h => h.cloudCover)).toEqual([50, 50, 75]);
  });

  it('leaves a single hour unchanged and does not mutate the input', () => {
    const input = [hour({ cloudCover: 33 })];
    expect(smoothHours(input)[0].cloudCover).toBe(33);
    expect(smoothHours([]).length).toBe(0);
    expect(input[0].cloudCover).toBe(33);
  });
});

describe('formatting helpers', () => {
  it('localHour reads the hour in the given time zone', () => {
    const d = new Date('2026-10-09T03:00:00Z');
    expect(localHour(d, 'UTC')).toBe(3);
    expect(localHour(d, 'America/New_York')).toBe(23);
  });

  it('localHour falls back to local getHours for an invalid zone', () => {
    const d = new Date('2026-10-09T03:00:00Z');
    expect(localHour(d, 'Not/AZone')).toBe(d.getHours());
  });

  it('formatTime returns "-" for empty input', () => {
    expect(formatTime('')).toBe('-');
  });

  it('formatTemp converts and rounds', () => {
    expect(formatTemp(20, 'celsius')).toBe('20°C');
    expect(formatTemp(20, 'fahrenheit')).toBe('68°F');
    // Math.round(-0.4) is -0, which a template literal prints as "0".
    expect(formatTemp(-0.4, 'celsius')).toBe('0°C');
  });

  it('formatWind converts km/h to mph', () => {
    expect(formatWind(100, 'mph')).toBe('62 mph');
    expect(formatWind(12.6, 'kmh')).toBe('13 km/h');
  });
});
