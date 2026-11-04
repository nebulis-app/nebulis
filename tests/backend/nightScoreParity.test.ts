/**
 * The night score has two implementations that cannot share a source file: the
 * server's (server/lib/nightScore.ts, behind the Forecast outlook cards and the
 * logbook) and the browser's (calculateVisibilityScore + scoreNight, behind the
 * Planner strip and the Sky Forecast hero).
 *
 * In 2.1.2 they were two different formulas, so the same night read "Bad 16" in
 * the Planner and "Fair 42" on the Forecast page. This file is the lock: it
 * runs both on the same inputs and fails the moment they disagree, by a single
 * point or by a word.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SunCalc from 'suncalc';
import { hourScore, scoreLabel, scoreNightHours } from '../../server/lib/nightScore';
import { buildForecast, type ForecastHour } from '../../server/lib/forecastCache';
import { calculateVisibilityScore, scoreLabel as clientScoreLabel, type TFunc } from '../../src/lib/forecastScore';
import { hoursInWindow, scoreNight } from '../../src/lib/plannerNight';
import { nightWindowFor } from '../../src/lib/nightWindow';
import type { ForecastHour as ClientHour } from '../../src/lib/api/planner';

const t: TFunc = (key) => key;
const TZ = 'America/Chicago';

/** Small seeded generator so a failure names the same inputs every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHour(rand: () => number, time: string): ForecastHour {
  const pick = <T,>(values: T[]) => values[Math.floor(rand() * values.length)];
  return {
    time,
    cloudCover: Math.round(rand() * 100), cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0,
    seeing: pick([null, 1, 2, 3, 4, 5]), transparency: null,
    humidity: Math.round(rand() * 100), temperature: 8, dewPoint: 2,
    wind: Math.round(rand() * 60), visibility: null, precipProb: Math.round(rand() * 100),
    jetStream: pick([null, 10, 45, 90, 130]), cape: pick([null, 0, 300, 800, 2000]),
  };
}

describe('server and browser agree on an hour and a night', () => {
  it('scores 500 random hours identically, moon in and out of the dark window', () => {
    const rand = rng(20261027);
    const dark = { start: Date.parse('2026-10-28T00:42:00Z'), end: Date.parse('2026-10-28T11:01:00Z') };
    for (let i = 0; i < 500; i++) {
      const time = new Date(Date.parse('2026-10-27T18:00:00Z') + Math.floor(rand() * 20) * 3_600_000).toISOString();
      const h = randomHour(rand, time);
      const moon = Math.round(rand() * 100);
      const inDark = Date.parse(time) >= dark.start && Date.parse(time) <= dark.end;
      const client = calculateVisibilityScore(h as unknown as ClientHour, moon, TZ, dark, t).score;
      expect(hourScore(h, moon, inDark), JSON.stringify({ h, moon })).toBe(client);
    }
  });

  it('rolls 200 random nights up to the same score and word, with and without a dark window', () => {
    const rand = rng(42);
    for (let n = 0; n < 200; n++) {
      const start = Date.parse('2026-10-28T00:00:00Z') + Math.floor(rand() * 4) * 3_600_000;
      const count = 2 + Math.floor(rand() * 11);
      const hours = Array.from({ length: count }, (_, i) => randomHour(rand, new Date(start + i * 3_600_000).toISOString()));
      const moon = Math.round(rand() * 100);
      const darkWindow = rand() < 0.75 ? { start: start + 3_600_000, end: start + (count - 1) * 3_600_000 } : null;

      const server = scoreNightHours(hours, { moonIllumination: moon, darkWindow, timeZone: TZ })!;
      const client = scoreNight(hours as unknown as ClientHour[], moon, TZ, darkWindow, t)!;
      expect(server.score, JSON.stringify({ n, moon, darkWindow })).toBe(client.score);
      expect(server.avgCloudCover).toBe(client.cloudCover);
      expect(`scoreBand.${server.rating.toLowerCase()}`).toBe(clientScoreLabel(client.score, t));
    }
  });

  it('uses the same word for every score from 0 to 100', () => {
    for (let score = 0; score <= 100; score++) {
      expect(`scoreBand.${scoreLabel(score).toLowerCase()}`, `score ${score}`).toBe(clientScoreLabel(score, t));
    }
  });
});

describe('the Forecast outlook cards match the Planner strip, night for night', () => {
  const LAT = 41.98, LON = -91.67; // Cedar Rapids, Iowa: the 2.1.2 report

  /** Five days of Open-Meteo hours in naive local time, the way the API sends them. */
  function openMeteoPayload() {
    const time: string[] = [], cloud: number[] = [], humidity: number[] = [], wind: number[] = [];
    const precip: number[] = [], jet: number[] = [], cape: number[] = [];
    for (let day = 27; day <= 31; day++) {
      for (let h = 0; h < 24; h++) {
        const i = time.length;
        time.push(`2026-10-${day}T${String(h).padStart(2, '0')}:00`);
        cloud.push((i * 37 + (day === 28 ? 50 : 0)) % 101);
        humidity.push(45 + ((i * 11) % 50));
        wind.push(3 + ((i * 7) % 25));
        precip.push(day === 28 ? 40 : (i * 3) % 20);
        jet.push(20 + ((i * 13) % 110));
        cape.push((i * 29) % 700);
      }
    }
    return {
      timezone: TZ,
      hourly: {
        time, cloud_cover: cloud, relative_humidity_2m: humidity, wind_speed_10m: wind,
        precipitation_probability: precip, wind_speed_500hPa: jet, cape,
      },
    };
  }

  beforeEach(() => {
    // 19:31 CDT on Monday the 26th, the moment from the report.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T00:31:00Z'));
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (String(url).includes('open-meteo')) return { ok: true, json: async () => openMeteoPayload() } as Response;
      const dataseries = Array.from({ length: 24 }, (_, i) => ({ timepoint: 3 + i * 3, seeing: 1 + (i % 7), transparency: 3 }));
      return { ok: true, json: async () => ({ init: '2026102700', dataseries }) } as Response;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives each rated night the score the Planner strip computes for it', async () => {
    const data = await buildForecast(LAT, LON) as unknown as {
      hourly: ClientHour[];
      nightRatings: { date: string; score: number; rating: string }[];
    };
    expect(data.nightRatings.length).toBeGreaterThanOrEqual(3);

    for (const card of data.nightRatings) {
      // The Planner strip, step for step: dark window, hours inside it, moon at its middle.
      const [y, m, d] = card.date.split('-').map(Number);
      const win = nightWindowFor(new Date(y, m - 1, d, 12), LAT, LON)!;
      const hours = hoursInWindow(data.hourly, win.start, win.end, 0);
      const illum = Math.round(SunCalc.getMoonIllumination(new Date((win.start.getTime() + win.end.getTime()) / 2)).fraction * 100);
      const planner = scoreNight(hours, illum, TZ, { start: win.start.getTime(), end: win.end.getTime() }, t)!;

      expect(card.score, `night of ${card.date}`).toBe(planner.score);
      expect(`scoreBand.${card.rating.toLowerCase()}`, `night of ${card.date}`).toBe(clientScoreLabel(planner.score, t));
    }
  });
});
