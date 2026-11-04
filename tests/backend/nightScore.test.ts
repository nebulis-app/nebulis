import { describe, it, expect } from 'vitest';
import {
  SCORE_BANDS,
  USABLE_SCORE,
  hourScore,
  scoreLabel,
  scoreNightHours,
  type NightScoreInput,
} from '../../server/lib/nightScore';
import type { ForecastHour } from '../../server/lib/forecastCache';

// Chicago, CDT (UTC-5): local 03:00 is 08:00Z, local 15:00 is 20:00Z.
const TZ = 'America/Chicago';
const NIGHT_START = Date.parse('2026-10-28T00:42:00Z');
const NIGHT_END = Date.parse('2026-10-28T11:01:00Z');
const DARK = { start: NIGHT_START, end: NIGHT_END };

function hour(over: Partial<ForecastHour> = {}): ForecastHour {
  return {
    time: '2026-10-28T06:00:00.000Z', cloudCover: 0, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0,
    seeing: 1, transparency: null, humidity: 40, temperature: 10, dewPoint: 0, wind: 5,
    visibility: null, precipProb: 0, jetStream: null, cape: null, ...over,
  };
}

const input = (over: Partial<NightScoreInput> = {}): NightScoreInput => ({
  moonIllumination: 0, darkWindow: DARK, timeZone: TZ, ...over,
});

describe('hourScore', () => {
  it('caps a perfect dark, clear, new-moon, dry hour at 100', () => {
    expect(hourScore(hour(), 0, true)).toBe(100); // raw 1.1
  });

  it('weighs cloud 60, seeing 20, moon 20 and up to 10 for dry air', () => {
    // cloud 50 -> 30, seeing unknown (0.5) -> 10, moon 50% lit -> 10, humidity 70 -> 5
    expect(hourScore(hour({ cloudCover: 50, seeing: null, humidity: 70 }), 50, true)).toBe(55);
  });

  it('charges for the moon only while it is dark', () => {
    // moon term is 20 points of weight; the 10 for dry air stays, so a full moon takes a perfect 100 to 90
    expect(hourScore(hour(), 100, true)).toBe(90);
    expect(hourScore(hour(), 100, false)).toBe(100);
  });

  it('lowers seeing for a fast jet stream and for unstable air', () => {
    // seeing 3 = 0.5, minus 0.25 for a 100 km/h jet = 0.25 -> 5 points
    expect(hourScore(hour({ cloudCover: 100, seeing: 3, jetStream: 100, humidity: 100 }), 100, true)).toBe(5);
    // seeing 1 = 1.0, minus 0.10 for CAPE 600 = 0.9 -> 18 points, plus cloud 0 (60) + moon (20)
    expect(hourScore(hour({ cape: 600, humidity: 100 }), 0, true)).toBe(98);
    // CAPE at or below 100 is ignored
    expect(hourScore(hour({ cape: 100, humidity: 100 }), 0, true)).toBe(100);
  });

  it('never goes below 0', () => {
    expect(hourScore(hour({ cloudCover: 100, seeing: 5, jetStream: 150, cape: 2000, humidity: 100 }), 100, true)).toBe(0);
  });

  it('ignores rain chance and wind, which the clouds already speak for', () => {
    const calm = hourScore(hour({ cloudCover: 30 }), 40, true);
    expect(hourScore(hour({ cloudCover: 30, precipProb: 100, wind: 90 }), 40, true)).toBe(calm);
  });
});

describe('score bands', () => {
  it.each([
    [100, 'Ideal'], [85, 'Ideal'], [84, 'Great'], [70, 'Great'], [69, 'Good'], [55, 'Good'],
    [54, 'Fair'], [40, 'Fair'], [39, 'Poor'], [25, 'Poor'], [24, 'Bad'], [0, 'Bad'],
  ])('labels %d as %s', (score, label) => {
    expect(scoreLabel(score)).toBe(label);
  });

  it('keeps the usable cutoff on the Good boundary', () => {
    expect(USABLE_SCORE).toBe(SCORE_BANDS.find((b) => b.label === 'Good')!.min);
  });
});

describe('scoreNightHours', () => {
  it('returns null for no hours', () => {
    expect(scoreNightHours([], input())).toBeNull();
  });

  it('averages the hourly scores', () => {
    const hours = [
      hour({ time: '2026-10-28T03:00:00.000Z', cloudCover: 0 }),
      hour({ time: '2026-10-28T04:00:00.000Z', cloudCover: 100 }),
    ];
    // 100 (capped) and 50 (the 60 for clear sky lost, 10 of dry air kept) -> 75
    const r = scoreNightHours(hours, input())!;
    expect(r.score).toBe(75);
    expect(r.rating).toBe('Great');
    expect(r.avgCloudCover).toBe(50);
  });

  it('rates only the hours inside the dark window', () => {
    const hours = [
      hour({ time: '2026-10-27T22:00:00.000Z', cloudCover: 100 }), // afternoon, before dark
      hour({ time: '2026-10-28T03:00:00.000Z', cloudCover: 0 }),
      hour({ time: '2026-10-28T04:00:00.000Z', cloudCover: 0 }),
    ];
    expect(scoreNightHours(hours, input())!.score).toBe(100);
  });

  it('falls back to every hour given when none is inside the window', () => {
    const hours = [hour({ time: '2026-10-27T18:00:00.000Z', cloudCover: 0 })];
    expect(scoreNightHours(hours, input())!.score).toBe(100);
  });

  it('applies the moon to a moonlit night, so it scores below the same night with a new moon', () => {
    const hours = [3, 4, 5, 6].map((h) => hour({ time: `2026-10-28T0${h}:00:00.000Z`, cloudCover: 20, seeing: 3 }));
    const dark = scoreNightHours(hours, input({ moonIllumination: 0 }))!.score;
    const full = scoreNightHours(hours, input({ moonIllumination: 96 }))!.score;
    expect(dark - full).toBe(19); // 20 points of weight x 96% lit, each hour rounded
  });

  it('uses a 19:00-05:00 local band for the moon when no dark window exists', () => {
    const afternoon = hour({ time: '2026-10-28T20:00:00.000Z' }); // 15:00 CDT
    const night = hour({ time: '2026-10-28T08:00:00.000Z' });     // 03:00 CDT
    const full = input({ darkWindow: null, moonIllumination: 100 });
    expect(scoreNightHours([afternoon], full)!.score).toBe(100);
    expect(scoreNightHours([night], full)!.score).toBe(90);
  });

  it('labels the night from the same band table as the score', () => {
    for (const cloudCover of [0, 30, 60, 90, 100]) {
      const r = scoreNightHours([hour({ cloudCover })], input({ moonIllumination: 50 }))!;
      expect(r.rating).toBe(scoreLabel(r.score));
    }
  });

  it('reports the weather the card shows beside the score', () => {
    const hours = [
      hour({ time: '2026-10-28T03:00:00.000Z', cloudCover: 10, humidity: 50, wind: 4, precipProb: 0 }),
      hour({ time: '2026-10-28T04:00:00.000Z', cloudCover: 30, humidity: 70, wind: 9, precipProb: 20 }),
    ];
    const r = scoreNightHours(hours, input())!;
    expect(r).toMatchObject({ avgCloudCover: 20, avgHumidity: 60, avgWind: 6.5, precipChance: 10 });
  });
});
