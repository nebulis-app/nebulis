import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertdew-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { _setRetryDelayForTests } from '../../server/lib/alerts/delivery';
import { dewWarningDue, observingNight, runDewWarnings, _resetDewWarningsForTests } from '../../server/lib/alerts/dewWarning';
import {
  createAlertChannel, deleteAlertChannel, deleteAlertDevice, getAlertState, listAlertChannels, listAlertDevices, registerAlertDevice, setAlertConfig,
  updateAlertDevice,
} from '../../server/lib/alerts/store';
import { _clearForecastCache, setForecastCacheEntry, type ForecastHour } from '../../server/lib/forecastCache';
import { createSite, setActiveSite } from '../../server/lib/observingSites';
import type { DewForecast } from '../../server/lib/alerts/types';

const LAT = 35.9, LON = -86.9;
/** The 20th's night in Chicago: dark from about 19:35 CDT, dew forecast from 02:00 CDT (07:00Z) on the 21st. */
const ONSET = '2026-10-21T07:00:00Z';

let relay: http.Server;
let relayBase: string;
let calls: { url: string; body: Record<string, unknown> }[] = [];
let replies: number[] = [];

beforeAll(async () => {
  _setRetryDelayForTests(5);
  relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url ?? '', body: JSON.parse(body || '{}') });
      res.statusCode = replies.shift() ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: res.statusCode === 200 }));
    });
  });
  await new Promise<void>(r => relay.listen(0, r));
  relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  process.env.NEBULIS_PUSH_RELAY_URL = relayBase;
});

afterAll(async () => {
  delete process.env.NEBULIS_PUSH_RELAY_URL;
  await new Promise<void>(r => relay.close(() => r()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/** Hourly forecast from noon UTC on the 20th for 48 hours. Dew from ONSET unless `dewFrom` is null; `spread` is how close it gets (°C). */
function seed(opts: { cloud?: number; dewFrom?: string | null; spread?: number } = {}) {
  const { cloud = 5, dewFrom = ONSET, spread = 0.5 } = opts;
  const hourly: ForecastHour[] = [];
  for (let t = Date.parse('2026-10-20T12:00:00Z'); t < Date.parse('2026-10-22T12:00:00Z'); t += 3_600_000) {
    const dewy = dewFrom !== null && t >= Date.parse(dewFrom);
    hourly.push({
      time: new Date(t).toISOString(), cloudCover: cloud, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, seeing: 2, transparency: 3,
      humidity: 70, temperature: dewy ? 4 : 12, dewPoint: dewy ? 4 - spread : 2, wind: 5, visibility: null, precipProb: 0, jetStream: null, cape: null,
    });
  }
  _clearForecastCache();
  setForecastCacheEntry({ data: { hourly, sources: { weather: 'open-meteo', seeing: '7timer' } }, fetchedAt: Date.now(), lat: LAT, lon: LON });
}

const phone = (token: string, lead: number, extra: { events?: ('night.dew' | 'night.clear')[]; enabled?: boolean } = {}) => {
  const { device } = registerAlertDevice({ token: token.repeat(32), apnsEnv: 'production', credential: `cred-${token}`, name: `Phone ${token}` });
  updateAlertDevice(device.id, { events: extra.events ?? ['night.dew'], details: { dewLeadMinutes: lead }, enabled: extra.enabled ?? true });
  return device.id;
};
const pushedTo = () => calls.filter(c => c.url === '/v1/push').map(c => String(c.body.token).slice(0, 2)).sort();

beforeEach(() => {
  calls = []; replies = [];
  _resetDewWarningsForTests();
  for (const d of listAlertDevices()) deleteAlertDevice(d.id);
  for (const c of listAlertChannels()) deleteAlertChannel(c.id);
  setAlertConfig({ language: 'en', clearNight: { minClearHours: 3, maxCloudCover: 30 } });
  setActiveSite(createSite({ name: 'Franklin, TN', latitude: LAT, longitude: LON, timezone: 'America/Chicago' }).id);
  seed();
});

describe('dewWarningDue', () => {
  const dew: DewForecast = { level: 'likely', from: ONSET, lowTempC: 3 };
  const at = (iso: string, lead: number, last: string | null = null, d: DewForecast | null = dew) => dewWarningDue(new Date(iso), d, lead, last, '2026-10-20');

  it('is due from the lead time before the dew, and not before', () => {
    expect(at('2026-10-21T05:59:00Z', 60)).toBe(false);
    expect(at('2026-10-21T06:00:00Z', 60)).toBe(true);
    expect(at('2026-10-21T04:00:00Z', 180)).toBe(true);
    expect(at('2026-10-21T03:59:00Z', 180)).toBe(false);
  });

  it('is not due twice for one night, with no dew, or with no forecast', () => {
    expect(at('2026-10-21T06:30:00Z', 60, '2026-10-20')).toBe(false);
    expect(at('2026-10-21T06:30:00Z', 60, '2026-10-19')).toBe(true);
    expect(at('2026-10-21T06:30:00Z', 60, null, { level: 'none', from: null, lowTempC: 9 })).toBe(false);
    expect(at('2026-10-21T06:30:00Z', 60, null, null)).toBe(false);
  });
});

describe('observingNight', () => {
  it('belongs after-midnight hours to the evening before', () => {
    expect(observingNight(new Date('2026-10-21T05:00:00Z'), 'America/Chicago')).toBe('2026-10-20');   // 00:00 on the 21st
    expect(observingNight(new Date('2026-10-21T16:59:00Z'), 'America/Chicago')).toBe('2026-10-20');   // 11:59
    expect(observingNight(new Date('2026-10-21T17:00:00Z'), 'America/Chicago')).toBe('2026-10-21');   // noon
    expect(observingNight(new Date('2026-10-21T23:00:00Z'), 'America/Chicago')).toBe('2026-10-21');   // evening
  });
});

describe('sending dew warnings', () => {
  it('sends each destination its own warning at its own lead time, and only the ones that are due', async () => {
    phone('aa', 60);
    phone('bb', 180);
    // Midnight in Chicago: three hours before the dew is within the 180-minute lead, but not the 60-minute one.
    expect(await runDewWarnings(new Date('2026-10-21T05:00:00Z'))).toBe(1);
    expect(pushedTo()).toEqual(['bb']);
    const sent = calls[0]!.body;
    expect(String(sent.title)).toBe('Dew warning: Franklin, TN');
    expect(sent.subtitle).toBe('Dew likely from 02:00');
    expect(sent.link).toBe('nebulis://sky');

    calls = [];
    expect(await runDewWarnings(new Date('2026-10-21T06:05:00Z'))).toBe(1);
    expect(pushedTo()).toEqual(['aa']);
  });

  it('sends one warning per destination per night, however often it checks', async () => {
    phone('aa', 60);
    expect(await runDewWarnings(new Date('2026-10-21T06:00:00Z'))).toBe(1);
    for (const t of ['2026-10-21T06:01:00Z', '2026-10-21T06:30:00Z', '2026-10-21T08:00:00Z']) expect(await runDewWarnings(new Date(t))).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('says "possible" when the air gets close but not very close', async () => {
    seed({ spread: 2.5 });
    phone('aa', 60);
    await runDewWarnings(new Date('2026-10-21T06:00:00Z'));
    expect(calls[0]!.body.subtitle).toBe('Dew possible from 02:00');
  });

  it('sends nothing on a cloudy night, a night with no dew risk, or to a destination that is off or has not asked', async () => {
    phone('aa', 60);
    seed({ cloud: 95 });
    expect(await runDewWarnings(new Date('2026-10-21T06:30:00Z'))).toBe(0);
    seed({ dewFrom: null });
    expect(await runDewWarnings(new Date('2026-10-21T06:30:00Z'))).toBe(0);
    seed();
    _resetDewWarningsForTests();
    for (const d of listAlertDevices()) deleteAlertDevice(d.id);
    phone('bb', 60, { enabled: false });
    phone('cc', 60, { events: ['night.clear'] });
    expect(await runDewWarnings(new Date('2026-10-21T06:30:00Z'))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does nothing without a location for the active site', async () => {
    phone('aa', 60);
    setActiveSite(createSite({ name: 'Somewhere' }).id);
    expect(await runDewWarnings(new Date('2026-10-21T06:30:00Z'))).toBe(0);
  });

  it('also warns a channel, in the same words, at the lead time chosen for it', async () => {
    const channel = createAlertChannel({ name: 'hook', kind: 'webhook', url: `${relayBase}/hook`, events: ['night.dew'], details: { dewLeadMinutes: 120 } });
    expect(await runDewWarnings(new Date('2026-10-21T04:59:00Z'))).toBe(0);
    expect(await runDewWarnings(new Date('2026-10-21T05:00:00Z'))).toBe(1);
    const hook = calls.find(c => c.url === '/hook')!.body;
    expect(hook).toMatchObject({ event: 'night.dew', title: 'Dew warning: Franklin, TN' });
    expect(String(hook.message)).toContain('Dew likely from 02:00');
    expect(getAlertState(`dew.sent.${channel.id}`)).toBe('2026-10-20');
  });

  it('picks up a lead time changed after the schedule was set', async () => {
    const id = phone('aa', 60);
    expect(await runDewWarnings(new Date('2026-10-21T05:00:00Z'))).toBe(0);
    updateAlertDevice(id, { details: { dewLeadMinutes: 180 } });
    expect(await runDewWarnings(new Date('2026-10-21T05:00:00Z'))).toBe(1);
  });

  it('keeps trying after a failure, but not every minute, and does not count a failed warning as sent', async () => {
    const id = phone('aa', 60);
    replies = [500, 500];                       // the attempt and its one retry
    expect(await runDewWarnings(new Date('2026-10-21T06:00:00Z'))).toBe(0);
    expect(getAlertState(`dew.sent.${id}`)).toBeNull();
    const before = calls.length;
    expect(await runDewWarnings(new Date('2026-10-21T06:01:00Z'))).toBe(0);
    expect(calls).toHaveLength(before);         // left alone for a while
    expect(await runDewWarnings(new Date('2026-10-21T06:20:00Z'))).toBe(1);
    expect(getAlertState(`dew.sent.${id}`)).toBe('2026-10-20');
  });

  it('warns again the next night', async () => {
    phone('aa', 60);
    expect(await runDewWarnings(new Date('2026-10-21T06:00:00Z'))).toBe(1);
    // The next night: dew from the same hour a day on.
    const hourly: ForecastHour[] = [];
    for (let t = Date.parse('2026-10-21T12:00:00Z'); t < Date.parse('2026-10-23T12:00:00Z'); t += 3_600_000) {
      const dewy = t >= Date.parse('2026-10-22T07:00:00Z');
      hourly.push({
        time: new Date(t).toISOString(), cloudCover: 5, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, seeing: 2, transparency: 3,
        humidity: 70, temperature: dewy ? 4 : 12, dewPoint: dewy ? 3.5 : 2, wind: 5, visibility: null, precipProb: 0, jetStream: null, cape: null,
      });
    }
    _clearForecastCache();
    setForecastCacheEntry({ data: { hourly, sources: { weather: 'open-meteo', seeing: '7timer' } }, fetchedAt: Date.now(), lat: LAT, lon: LON });
    calls = [];
    expect(await runDewWarnings(new Date('2026-10-22T06:00:00Z'))).toBe(1);
  });

  it('forgets a removed destination, so adding the same phone back tonight still warns it', async () => {
    const id = phone('aa', 60);
    expect(await runDewWarnings(new Date('2026-10-21T06:00:00Z'))).toBe(1);
    expect(getAlertState(`dew.sent.${id}`)).toBe('2026-10-20');
    deleteAlertDevice(id);
    expect(getAlertState(`dew.sent.${id}`)).toBeNull();
    phone('aa', 60);
    calls = [];
    expect(await runDewWarnings(new Date('2026-10-21T06:10:00Z'))).toBe(1);
  });
});
