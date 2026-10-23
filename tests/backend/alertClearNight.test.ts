import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertclearnight-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import {
  darkWindow,
  evaluateClearNight,
  evaluateDew,
  nextClearNightCheck,
  summarizePlan,
  isClearNightCheckDue,
  lastClearNightCheck,
  runClearNightCheck,
  _clearNightTickForTests,
} from '../../server/lib/alerts/clearNight';
import { createAlertChannel, setAlertConfig } from '../../server/lib/alerts/store';
import { _clearForecastCache, setForecastCacheEntry, type ForecastHour } from '../../server/lib/forecastCache';
import { createSite, setActiveSite } from '../../server/lib/observingSites';
import { create as createPlanned } from '../../server/lib/plannedSessions';
import db from '../../server/lib/db';

const LAT = 45.66;
const LON = 6.3;
const TZ = 'Europe/Paris';
const NIGHT = '2026-10-15';

/** Hourly forecast from noon UTC on the 15th to noon on the 16th. */
function hours(cloudAt: (iso: string) => number = () => 5, over: Partial<ForecastHour> = {}): ForecastHour[] {
  const out: ForecastHour[] = [];
  for (let t = Date.parse('2026-10-15T12:00:00Z'); t < Date.parse('2026-10-16T12:00:00Z'); t += 3_600_000) {
    const time = new Date(t).toISOString();
    out.push({
      time, cloudCover: cloudAt(time), cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, seeing: 2, transparency: 3,
      humidity: 60, temperature: 5, dewPoint: 0, wind: 5, visibility: null, precipProb: 0, jetStream: null, cape: null, ...over,
    });
  }
  return out;
}

const input = (h: ForecastHour[], from = new Date('2026-10-15T15:00:00Z')) => ({
  hours: h, lat: LAT, lon: LON, timeZone: TZ, siteName: 'Verrens-Arvey', night: NIGHT, maxCloudCover: 30, from,
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('nextClearNightCheck', () => {
  const CHI = 'America/Chicago';

  it('is today at the check time while that is still ahead and tonight has not been checked', () => {
    // 15:00 in Chicago on the 20th (20:00Z), check at 17:00 local = 22:00Z.
    expect(nextClearNightCheck(new Date('2026-10-20T20:00:00Z'), '17:00', CHI, null)).toEqual({ at: '2026-10-20T22:00:00.000Z', when: 'today' });
    expect(nextClearNightCheck(new Date('2026-10-20T20:00:00Z'), '17:00', CHI, '2026-10-19')).toEqual({ at: '2026-10-20T22:00:00.000Z', when: 'today' });
  });

  it('is now once the time has passed and tonight is still unchecked, which is when the scheduler runs it', () => {
    const now = new Date('2026-10-20T23:30:00Z');
    expect(nextClearNightCheck(now, '17:00', CHI, '2026-10-19')).toEqual({ at: now.toISOString(), when: 'now' });
  });

  it('is tomorrow at the check time once tonight has been checked, whether or not it sent anything', () => {
    expect(nextClearNightCheck(new Date('2026-10-20T23:30:00Z'), '17:00', CHI, '2026-10-20')).toEqual({ at: '2026-10-21T22:00:00.000Z', when: 'tomorrow' });
  });

  it('keeps the local clock time across a daylight-saving change', () => {
    // The clocks go back on 1 November in Chicago: 17:00 that day is UTC-6, not UTC-5.
    expect(nextClearNightCheck(new Date('2026-10-31T23:30:00Z'), '17:00', CHI, '2026-10-31')).toEqual({ at: '2026-11-01T23:00:00.000Z', when: 'tomorrow' });
  });

  it('uses the active site\'s day, not the server\'s', () => {
    // 23:30Z on the 20th is already the 21st in Paris: checked "tonight" there means the 21st.
    expect(nextClearNightCheck(new Date('2026-10-20T23:30:00Z'), '17:00', 'Europe/Paris', '2026-10-21')).toEqual({ at: '2026-10-22T15:00:00.000Z', when: 'tomorrow' });
    // Checked for the 20th, so the 21st's check is still ahead at 17:00 Paris time.
    expect(nextClearNightCheck(new Date('2026-10-20T23:30:00Z'), '17:00', 'Europe/Paris', '2026-10-20')).toEqual({ at: '2026-10-21T15:00:00.000Z', when: 'today' });
  });
});

describe('evaluateDew', () => {
  const start = Date.parse('2026-10-15T19:00:00Z'), end = Date.parse('2026-10-16T04:00:00Z');
  const hr = (iso: string, temperature: number, dewPoint: number) => ({ ...hours()[0]!, time: iso, temperature, dewPoint });

  it("finds when the air first comes close to its dew point, and the night's low", () => {
    const d = evaluateDew([hr('2026-10-15T19:00:00Z', 10, 3), hr('2026-10-15T23:00:00Z', 6, 4), hr('2026-10-16T02:00:00Z', 3, 2.5)], start, end);
    expect(d).toEqual({ level: 'likely', from: '2026-10-16T02:00:00.000Z', lowTempC: 3 });
  });

  it('calls a gap of up to 3 degrees possible and anything wider none', () => {
    expect(evaluateDew([hr('2026-10-15T22:00:00Z', 7, 4.5)], start, end)).toEqual({ level: 'possible', from: '2026-10-15T22:00:00.000Z', lowTempC: 7 });
    expect(evaluateDew([hr('2026-10-15T22:00:00Z', 7, 3)], start, end)).toEqual({ level: 'none', from: null, lowTempC: 7 });
  });

  it('only looks at the dark window', () => {
    const d = evaluateDew([hr('2026-10-15T15:00:00Z', 2, 2), hr('2026-10-15T22:00:00Z', 9, 2)], start, end);
    expect(d).toEqual({ level: 'none', from: null, lowTempC: 9 });
  });

  it("ignores the forecast's stand-in for a missing value and has no answer with nothing usable", () => {
    expect(evaluateDew([hr('2026-10-15T22:00:00Z', 0, 0)], start, end)).toBeNull();
    expect(evaluateDew([], start, end)).toBeNull();
    expect(evaluateDew([hr('2026-10-15T22:00:00Z', Number.NaN, 1)], start, end)).toBeNull();
  });
});

describe('summarizePlan', () => {
  const block = (objectName: string, startTime: string, skipped = 0) => ({ objectName, startTime, skipped });

  it('lists objects in the order they start, once each, leaving out skipped blocks', () => {
    expect(summarizePlan([block('M31', '2026-10-16T01:00:00Z'), block('M42', '2026-10-15T22:00:00Z'), block('M42', '2026-10-16T03:00:00Z'), block('M33', '2026-10-16T02:00:00Z', 1)]))
      .toEqual({ objects: ['M42', 'M31'], blocks: 3 });
  });

  it('is empty, not missing, when nothing is planned', () => {
    expect(summarizePlan([])).toEqual({ objects: [], blocks: 0 });
    expect(summarizePlan([block('M42', '2026-10-15T22:00:00Z', 1)])).toEqual({ objects: [], blocks: 0 });
  });
});

describe('evaluateClearNight', () => {
  const win = darkWindow(NIGHT, LAT, LON, TZ)!;
  const darkHours = Math.round(((win.end.getTime() - win.start.getTime()) / 3_600_000) * 10) / 10;

  it('counts the whole astronomical night when every hour is clear', () => {
    expect(win.start.toISOString().slice(0, 13)).toBe('2026-10-15T18');
    const r = evaluateClearNight(input(hours()))!;
    expect(r.clearHours).toBe(darkHours);
    expect(r.darkHours).toBe(darkHours);
    expect(r.longestStart).toBe(win.start.toISOString());
    expect(r.longestEnd).toBe(win.end.toISOString());
    expect(r.seeing).toBe(2);
    expect(r.moonIllumination).toBeLessThan(30); // a few days after new Moon
  });

  it('finds the longest clear stretch around a cloudy spell, and ignores rainy hours', () => {
    const cloudy = (iso: string) => (iso >= '2026-10-15T22' && iso < '2026-10-16T01' ? 90 : 5);
    const r = evaluateClearNight(input(hours(cloudy)))!;
    expect(r.clearHours).toBeCloseTo(darkHours - 3, 1);
    // Before the clouds (~18:40–22:00 UTC) is shorter than after (01:00–dawn ~04:20)? Pick whichever is longer.
    const before = Date.parse('2026-10-15T22:00:00Z') - win.start.getTime();
    const after = win.end.getTime() - Date.parse('2026-10-16T01:00:00Z');
    expect(r.longestStart).toBe(before >= after ? win.start.toISOString() : '2026-10-16T01:00:00.000Z');

    const rainy = evaluateClearNight(input(hours(() => 5, { precipProb: 60 })))!;
    expect(rainy.clearHours).toBe(0);
  });

  it('only counts the hours still ahead', () => {
    const r = evaluateClearNight(input(hours(), new Date('2026-10-16T00:00:00Z')))!;
    expect(r.longestStart).toBe('2026-10-16T00:00:00.000Z');
    expect(r.clearHours).toBe(Math.round(((win.end.getTime() - Date.parse('2026-10-16T00:00:00Z')) / 3_600_000) * 10) / 10);
  });

  it('has no dark window where the sky never gets dark', () => {
    expect(darkWindow('2026-06-21', 78, 15, 'Europe/Oslo')).toBeNull();
  });
});

describe('isClearNightCheckDue', () => {
  it('runs once the local check time has passed, once per night', () => {
    const at = (iso: string) => new Date(iso);
    expect(isClearNightCheckDue(at('2026-10-15T14:59:00Z'), '17:00', TZ, null)).toBe(false); // 16:59 Paris
    expect(isClearNightCheckDue(at('2026-10-15T15:00:00Z'), '17:00', TZ, null)).toBe(true);
    expect(isClearNightCheckDue(at('2026-10-15T15:00:00Z'), '17:00', TZ, '2026-10-15')).toBe(false);
    expect(isClearNightCheckDue(at('2026-10-15T15:00:00Z'), '17:00', TZ, '2026-10-14')).toBe(true);
  });
});

describe('the evening check', () => {
  let receiver: http.Server;
  let base: string;
  const received: string[] = [];

  beforeAll(async () => {
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { received.push(body); res.end(); });
    });
    await new Promise<void>(resolve => receiver.listen(0, resolve));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    const site = createSite({ name: 'Verrens-Arvey', latitude: LAT, longitude: LON, timezone: TZ });
    setActiveSite(site.id);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => receiver.close(() => resolve()));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const seed = (cloudAt?: (iso: string) => number) => {
    _clearForecastCache();
    setForecastCacheEntry({
      data: { hourly: hours(cloudAt), sources: { weather: 'open-meteo', seeing: '7timer' } },
      fetchedAt: Date.now(), lat: LAT, lon: LON,
    });
  };

  it('previews without sending', async () => {
    seed();
    const check = await runClearNightCheck(new Date('2026-10-15T15:00:00Z'), false);
    expect(check).toMatchObject({ night: NIGHT, reason: 'preview', sent: false, result: { siteName: 'Verrens-Arvey' } });
  });

  it("reads tonight's plan from the planner, and the dew from the forecast, for the preview", async () => {
    db.prepare('DELETE FROM plannedSessions').run();
    createPlanned({ objectId: 'M42', objectName: 'Orion Nebula', ra: 5.59, dec: -5.4, startTime: '2026-10-15T20:00:00Z', endTime: '2026-10-15T22:00:00Z' });
    createPlanned({ objectId: 'M31', objectName: 'Andromeda Galaxy', ra: 0.71, dec: 41.3, startTime: '2026-10-16T00:00:00Z', endTime: '2026-10-16T02:00:00Z' });
    // A block on another night must not be counted.
    createPlanned({ objectId: 'M33', objectName: 'Triangulum', ra: 1.56, dec: 30.6, startTime: '2026-10-20T20:00:00Z', endTime: '2026-10-20T22:00:00Z' });
    _clearForecastCache();
    setForecastCacheEntry({
      data: { hourly: hours(() => 5, { temperature: 4, dewPoint: 3 }), sources: { weather: 'open-meteo', seeing: '7timer' } },
      fetchedAt: Date.now(), lat: LAT, lon: LON,
    });
    const check = await runClearNightCheck(new Date('2026-10-15T15:00:00Z'), false);
    expect(check.result?.plan).toEqual({ objects: ['Orion Nebula', 'Andromeda Galaxy'], blocks: 2 });
    expect(check.result?.dew).toMatchObject({ level: 'likely', lowTempC: 4 });
    db.prepare('DELETE FROM plannedSessions').run();
    _clearForecastCache();
    setForecastCacheEntry({ data: { hourly: hours(), sources: { weather: 'open-meteo', seeing: '7timer' } }, fetchedAt: Date.now(), lat: LAT, lon: LON });
    expect((await runClearNightCheck(new Date('2026-10-15T15:00:00Z'), false)).result?.plan).toEqual({ objects: [], blocks: 0 });
  });

  it('holds back a night under the minimum', async () => {
    seed(iso => (iso >= '2026-10-15T20' ? 90 : 5)); // clouds from 22:00 local
    setAlertConfig({ clearNight: { minClearHours: 3 } });
    const check = await runClearNightCheck(new Date('2026-10-15T15:00:00Z'), true);
    expect(check).toMatchObject({ reason: 'not_clear_enough', sent: false });
  });

  it('sends once at the check time, then not again that night', async () => {
    seed();
    setAlertConfig({ language: 'fr', clearNight: { checkTime: '17:00', minClearHours: 3 } });
    createAlertChannel({ name: 'hook', kind: 'webhook', url: `${base}/h`, events: ['night.clear'] });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T15:05:00Z'));
    seed(); // fetchedAt under the fake clock, so the cache counts as fresh
    await _clearNightTickForTests();
    await _clearNightTickForTests();
    expect(received).toHaveLength(1);
    const body = JSON.parse(received[0]!);
    expect(body).toMatchObject({ event: 'night.clear', title: 'Nuit dégagée ce soir : Verrens-Arvey', data: { night: NIGHT } });
    expect(lastClearNightCheck()).toMatchObject({ night: NIGHT, sent: true, reason: 'sent' });
  });
});
