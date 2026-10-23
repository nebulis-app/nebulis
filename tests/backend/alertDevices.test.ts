import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertdevices-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { alertsRouter } from '../../server/routes/alerts';
import { dispatchAlert, pushRelayUrl, _setRetryDelayForTests } from '../../server/lib/alerts/delivery';
import {
  deviceIdFor, getAlertDevice, getAlertState, hasAlertListener, listAlertChannels, listAlertDevices, deleteAlertDevice, deleteAlertChannel, setAlertConfig,
} from '../../server/lib/alerts/store';
import type { AlertEvent } from '../../server/lib/alerts/types';
import { _clearForecastCache, setForecastCacheEntry, type ForecastHour } from '../../server/lib/forecastCache';
import { createSite, setActiveSite } from '../../server/lib/observingSites';
import { lastClearNightCheck } from '../../server/lib/alerts/clearNight';

const TOKEN = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const CREDENTIAL = 'v1.credential-one';

let app: http.Server;
let base: string;
let role = 'admin';

let relay: http.Server;
let relayBase: string;
let relayCalls: { url: string; method: string; body: Record<string, unknown> }[] = [];
let relayReplies: number[] = [];

beforeAll(async () => {
  _setRetryDelayForTests(10);
  relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      relayCalls.push({ url: req.url ?? '', method: req.method ?? '', body: JSON.parse(body || '{}') });
      res.statusCode = relayReplies.shift() ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: res.statusCode === 200 }));
    });
  });
  await new Promise<void>(resolve => relay.listen(0, resolve));
  relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  process.env.NEBULIS_PUSH_RELAY_URL = relayBase;

  const server = express();
  server.use(express.json());
  server.use(apiEnvelope);
  server.use((req, _res, next) => { (req as unknown as { userRole: string }).userRole = role; next(); });
  server.use('/alerts', alertsRouter);
  app = http.createServer(server);
  await new Promise<void>(resolve => app.listen(0, resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.NEBULIS_PUSH_RELAY_URL;
  await new Promise<void>(resolve => app.close(() => resolve()));
  await new Promise<void>(resolve => relay.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  role = 'admin';
  relayCalls = [];
  relayReplies = [];
  for (const d of listAlertDevices()) deleteAlertDevice(d.id);
  for (const c of listAlertChannels()) deleteAlertChannel(c.id);
  setAlertConfig({ language: 'en' });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/alerts${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}
const json = (r: { text: string }) => JSON.parse(r.text).data;
const register = (over: Record<string, unknown> = {}) =>
  call('POST', '/devices', { token: TOKEN, env: 'production', credential: CREDENTIAL, name: "Brent's iPhone", ...over });

const clearNight: AlertEvent = {
  type: 'night.clear', occurredAt: new Date().toISOString(),
  data: {
    siteName: 'Backyard', night: '2026-10-18', timeZone: 'America/Chicago', clearHours: 5, darkHours: 8,
    longestStart: '2026-10-19T03:00:00Z', longestEnd: '2026-10-19T08:00:00Z', maxCloudCover: 30, seeing: 2,
    moonIllumination: 20, moonDownHours: 5, moonRise: null, moonSet: null,
  },
};

describe('registering a phone', () => {
  it('adds it on the default events, then refreshes the same row when it registers again', async () => {
    const first = await register();
    expect(first.status).toBe(201);
    const d = json(first);
    expect(d).toMatchObject({ id: deviceIdFor(TOKEN), name: "Brent's iPhone", apnsEnv: 'production', enabled: true, events: ['night.clear', 'import.finished', 'import.failed'] });

    // The admin narrows it and switches it off; the phone then registers again with a new credential.
    await call('PUT', `/devices/${d.id}`, { events: ['night.clear'], enabled: false });
    const again = await register({ credential: 'v1.credential-two', name: 'New name' });
    expect(again.status).toBe(200);
    expect(json(again)).toMatchObject({ id: d.id, name: 'New name', enabled: false, events: ['night.clear'] });
    expect(listAlertDevices()).toHaveLength(1);
    expect(getAlertDevice(d.id)!.credential).toBe('v1.credential-two');
  });

  it('never gives the Apple token or the credential back, in any response', async () => {
    const responses = [await register(), await call('GET', '/'), await call('PUT', `/devices/${deviceIdFor(TOKEN)}`, { name: 'x' })];
    for (const r of responses) {
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain(CREDENTIAL);
    }
    expect(json(responses[1]!).devices).toHaveLength(1);
  });

  it('stores the token and the credential encrypted', async () => {
    await register();
    const row = db.prepare('SELECT token, credential FROM alertDevices').get() as { token: string; credential: string };
    expect(row.token).not.toContain(TOKEN);
    expect(row.credential).not.toContain(CREDENTIAL);
  });

  it('refuses bad input and anyone who is not an administrator', async () => {
    expect((await register({ token: 'short' })).status).toBe(422);
    expect((await register({ token: 'zz'.repeat(32) })).status).toBe(422);
    expect((await register({ env: 'staging' })).status).toBe(422);
    expect((await register({ credential: '' })).status).toBe(422);
    expect((await register({ name: '   ' })).status).toBe(422);
    role = 'viewer';
    expect((await register()).status).toBe(403);
    expect(listAlertDevices()).toHaveLength(0);
  });

  it('answers where the relay is, for the phone to register with', async () => {
    const info = json(await call('GET', '/push-info'));
    expect(info.relayUrl).toBe(relayBase);
    expect(info.defaultEvents).toEqual(['night.clear', 'import.finished', 'import.failed']);
  });
});

describe('a phone asking whether the server still knows it', () => {
  it('gets its row while it is there and a 404 once an administrator removed it', async () => {
    const id = json(await register()).id;
    const known = await call('GET', `/devices/${id}`);
    expect(known.status).toBe(200);
    expect(known.text).not.toContain(TOKEN);
    expect(json(known)).toMatchObject({ id, enabled: true });
    await call('DELETE', `/devices/${id}`);
    expect((await call('GET', `/devices/${id}`)).status).toBe(404);
  });
});

describe('managing a phone', () => {
  it('edits, tests and removes it, and 404s for one that is not there', async () => {
    const id = json(await register()).id;
    expect(json(await call('PUT', `/devices/${id}`, { name: 'Kitchen phone', events: ['import.failed'] }))).toMatchObject({ name: 'Kitchen phone', events: ['import.failed'] });
    expect((await call('PUT', `/devices/${id}`, { events: ['nonsense'] })).status).toBe(422);

    const tested = json(await call('POST', `/devices/${id}/test`));
    expect(tested).toMatchObject({ ok: true, removed: false });
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.body).toMatchObject({ token: TOKEN, credential: CREDENTIAL, threadId: 'test', ttlSeconds: 300 });

    expect(json(await call('DELETE', `/devices/${id}`))).toEqual({ deleted: true });
    for (const r of [await call('DELETE', `/devices/${id}`), await call('PUT', `/devices/${id}`, { name: 'x' }), await call('POST', `/devices/${id}/test`)]) {
      expect(r.status).toBe(404);
    }
  });
});

describe('sending tonight to the phones from the settings page', () => {
  const LAT = 35.9, LON = -86.9;

  /** Hourly forecast around now, so tonight exists whenever the test runs. */
  const seedForecast = () => {
    const hourly: ForecastHour[] = [];
    const start = Math.floor((Date.now() - 36 * 3_600_000) / 3_600_000) * 3_600_000;
    for (let t = start; t < start + 96 * 3_600_000; t += 3_600_000) {
      hourly.push({
        time: new Date(t).toISOString(), cloudCover: 5, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, seeing: 2, transparency: 3,
        humidity: 60, temperature: 4, dewPoint: 3, wind: 5, visibility: null, precipProb: 0, jetStream: null, cape: null,
      });
    }
    _clearForecastCache();
    setForecastCacheEntry({ data: { hourly, sources: { weather: 'open-meteo', seeing: '7timer' } }, fetchedAt: Date.now(), lat: LAT, lon: LON });
  };

  beforeEach(() => {
    const site = createSite({ name: 'Franklin, TN', latitude: LAT, longitude: LON, timezone: 'America/Chicago' });
    setActiveSite(site.id);
    seedForecast();
  });

  it('sends the real alert to each switched-on phone, with the lines that phone chose', async () => {
    const first = json(await register()).id;
    await register({ token: OTHER, name: 'Second' });
    await call('PUT', `/devices/${first}`, { details: { dew: true, plan: true } });
    const res = json(await call('POST', '/clear-night/send-to-phones'));
    expect(res).toMatchObject({ sent: 2, failed: [], phones: 2 });
    expect(relayCalls).toHaveLength(2);
    const mine = relayCalls.find(c => c.body.token === TOKEN)!.body;
    const theirs = relayCalls.find(c => c.body.token === OTHER)!.body;
    expect(String(mine.title)).toBe('Clear tonight: Franklin, TN');
    expect(mine.subtitle).toBeTruthy();
    expect(String(mine.body)).toContain('Dew');
    expect(String(mine.body)).toContain('Nothing planned. Tap to plan.');
    expect(mine.link).toBe('nebulis://planner');
    expect(String(theirs.body)).not.toContain('Dew');
    expect(theirs.link).toBe('nebulis://sky');
  });

  it('skips a phone that is switched off, does nothing with no phone, and says so', async () => {
    const id = json(await register()).id;
    await call('PUT', `/devices/${id}`, { enabled: false });
    expect(json(await call('POST', '/clear-night/send-to-phones'))).toMatchObject({ sent: 0, phones: 0 });
    expect(relayCalls).toHaveLength(0);
  });

  it('does not count as tonight having been alerted, so the real evening alert still goes', async () => {
    await register();
    const before = lastClearNightCheck();
    await call('POST', '/clear-night/send-to-phones');
    expect(lastClearNightCheck()).toEqual(before);
  });

  it('reports a phone the relay refused, by name and with the reason', async () => {
    await register();
    relayReplies = [403];
    const res = json(await call('POST', '/clear-night/send-to-phones'));
    expect(res.sent).toBe(0);
    expect(res.failed).toEqual([{ name: "Brent's iPhone", error: expect.stringMatching(/register again/i) }]);
  });

  it('sends a sample dew warning only to phones that asked for them, using tonight\'s real dew when there is some', async () => {
    const asked = json(await register()).id;
    await register({ token: OTHER, name: 'Second' });          // never asked for dew warnings
    await call('PUT', `/devices/${asked}`, { events: ['night.dew'], details: { dewLeadMinutes: 120 } });
    const res = json(await call('POST', '/dew/send-to-phones'));
    expect(res).toMatchObject({ sent: 1, failed: [], phones: 1, sample: false });
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.body).toMatchObject({ token: TOKEN, threadId: 'night.dew', link: 'nebulis://sky' });
    expect(String(relayCalls[0]!.body.title)).toBe('Dew warning: Franklin, TN');
    expect(String(relayCalls[0]!.body.subtitle)).toMatch(/^Dew (likely|possible) from \d\d:\d\d$/);
  });

  it('with no dew expected tonight, still sends the layout with example times, and says it was a sample', async () => {
    const id = json(await register()).id;
    await call('PUT', `/devices/${id}`, { events: ['night.dew'] });
    const hourly: ForecastHour[] = [];
    const start = Math.floor((Date.now() - 36 * 3_600_000) / 3_600_000) * 3_600_000;
    for (let t = start; t < start + 96 * 3_600_000; t += 3_600_000) {
      hourly.push({
        time: new Date(t).toISOString(), cloudCover: 5, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, seeing: 2, transparency: 3,
        humidity: 40, temperature: 15, dewPoint: 2, wind: 5, visibility: null, precipProb: 0, jetStream: null, cape: null,
      });
    }
    _clearForecastCache();
    setForecastCacheEntry({ data: { hourly, sources: { weather: 'open-meteo', seeing: '7timer' } }, fetchedAt: Date.now(), lat: LAT, lon: LON });
    const res = json(await call('POST', '/dew/send-to-phones'));
    expect(res).toMatchObject({ sent: 1, sample: true });
    expect(String(relayCalls[0]!.body.subtitle)).toMatch(/^Dew likely from/);
  });

  it('sends nothing, and says so, when no phone has asked for dew warnings', async () => {
    await register();
    expect(json(await call('POST', '/dew/send-to-phones'))).toMatchObject({ sent: 0, phones: 0 });
    expect(relayCalls).toHaveLength(0);
  });

  it('does not count a sample as tonight\'s dew warning having gone', async () => {
    const id = json(await register()).id;
    await call('PUT', `/devices/${id}`, { events: ['night.dew'] });
    await call('POST', '/dew/send-to-phones');
    expect(getAlertState(`dew.sent.${id}`)).toBeNull();
  });

  it('says why when the active site has no location to build the alert from', async () => {
    await register();
    setActiveSite(createSite({ name: 'Somewhere' }).id);
    const res = json(await call('POST', '/clear-night/send-to-phones'));
    expect(res.sent).toBe(0);
    expect(res.check.result).toBeNull();
    expect(res.check.reason).toBe('no_site');
    expect(relayCalls).toHaveLength(0);
  });
});

describe('the extra lines of a clear night, chosen for each phone', () => {
  const withExtras: AlertEvent = {
    ...clearNight,
    data: { ...(clearNight.data as object), dew: { level: 'likely', from: '2026-10-19T06:00:00Z', lowTempC: 3 }, plan: { objects: ['M42', 'M31'], blocks: 2 } },
  } as AlertEvent;

  it('merges switches one at a time and refuses anything that is not a switch', async () => {
    const id = json(await register()).id;
    expect(json(await call('PUT', `/devices/${id}`, { details: { plan: true } })).details).toEqual({ dew: false, plan: true, dewLeadMinutes: 60 });
    expect(json(await call('PUT', `/devices/${id}`, { details: { dew: true } })).details).toEqual({ dew: true, plan: true, dewLeadMinutes: 60 });
    expect(json(await call('PUT', `/devices/${id}`, { name: 'Kitchen' })).details).toEqual({ dew: true, plan: true, dewLeadMinutes: 60 });
    expect(json(await call('PUT', `/devices/${id}`, { details: { dew: false } })).details).toEqual({ dew: false, plan: true, dewLeadMinutes: 60 });
    expect((await call('PUT', `/devices/${id}`, { details: { plan: 1 } })).status).toBe(422);
  });

  it('a phone chooses its own dew-warning lead time, and the warning is not on until asked for', async () => {
    const id = json(await register()).id;
    expect(getAlertDevice(id)?.events).not.toContain('night.dew');
    expect(json(await call('PUT', `/devices/${id}`, { events: ['night.dew'], details: { dewLeadMinutes: 180 } }))).toMatchObject({
      events: ['night.dew'], details: { dewLeadMinutes: 180 },
    });
    expect((await call('PUT', `/devices/${id}`, { details: { dewLeadMinutes: 5 } })).status).toBe(422);
    // Registering again (a new token from Apple, a renamed phone) keeps what was chosen.
    await register({ name: 'Renamed' });
    expect(getAlertDevice(id)).toMatchObject({ events: ['night.dew'], details: { dewLeadMinutes: 180 } });
  });

  it('a new phone starts with none, and a phone registering again keeps the ones that were set', async () => {
    const id = json(await register()).id;
    expect(getAlertDevice(id)?.details).toEqual({ dew: false, plan: false, dewLeadMinutes: 60 });
    await call('PUT', `/devices/${id}`, { details: { plan: true } });
    await register({ name: 'Renamed on the phone' });
    expect(getAlertDevice(id)?.details).toEqual({ dew: false, plan: true, dewLeadMinutes: 60 });
  });

  it('sends each phone the lines it asked for, and the planner link only to the one with the plan line', async () => {
    const first = json(await register()).id;
    await register({ token: OTHER, name: 'Second' });
    await call('PUT', `/devices/${first}`, { details: { plan: true, dew: true } });
    await dispatchAlert(withExtras);
    const mine = relayCalls.find(c => c.body.token === TOKEN)!.body;
    const theirs = relayCalls.find(c => c.body.token === OTHER)!.body;
    expect(mine.body).toContain('Planned: M42, M31');
    expect(mine.body).toContain('Dew likely');
    expect(mine.link).toBe('nebulis://planner');
    expect(String(theirs.body)).not.toContain('Planned');
    expect(String(theirs.body)).not.toContain('Dew');
    expect(theirs.link).toBe('nebulis://sky');
  });
});

describe('sending to a phone', () => {
  it('sends the alert through the relay with its token, credential, text, link and lifetime', async () => {
    await register();
    await dispatchAlert(clearNight);
    expect(relayCalls).toHaveLength(1);
    const { url, method, body } = relayCalls[0]!;
    expect([method, url]).toEqual(['POST', '/v1/push']);
    expect(body).toMatchObject({
      token: TOKEN, env: 'production', credential: CREDENTIAL, threadId: 'night.clear', collapseId: 'night.clear',
      link: 'nebulis://sky', ttlSeconds: 4 * 3600,
    });
    expect(String(body.title)).toContain('Backyard');
    expect(getAlertDevice(deviceIdFor(TOKEN))).toMatchObject({ lastStatus: 'ok', lastError: null });
  });

  it('skips a phone that is switched off or not subscribed to the event', async () => {
    const id = json(await register()).id;
    await call('PUT', `/devices/${id}`, { events: ['import.failed'] });
    await dispatchAlert(clearNight);
    await call('PUT', `/devices/${id}`, { events: ['night.clear'], enabled: false });
    await dispatchAlert(clearNight);
    expect(relayCalls).toHaveLength(0);
  });

  it("writes the message in the phone's own language, else the alert options' language", async () => {
    await register({ language: 'fr' });
    await register({ token: OTHER, language: null, name: 'Second' });
    setAlertConfig({ language: 'de' });
    await dispatchAlert(clearNight);
    const byToken = Object.fromEntries(relayCalls.map(c => [String(c.body.token), String(c.body.title)]));
    expect(byToken[TOKEN]).toMatch(/nuit/i);
    expect(byToken[OTHER]).toMatch(/Nacht/i);
  });

  it('retries a busy relay once, and gives up after a second failure with a plain reason', async () => {
    const id = deviceIdFor((await register(), TOKEN));
    relayReplies = [503, 200];
    await dispatchAlert(clearNight);
    expect(relayCalls).toHaveLength(2);
    expect(getAlertDevice(id)!.lastStatus).toBe('ok');

    relayCalls = [];
    relayReplies = [503, 503];
    await dispatchAlert(clearNight);
    expect(relayCalls).toHaveLength(2);
    expect(getAlertDevice(id)).toMatchObject({ lastStatus: 'error', lastError: 'Apple is not accepting pushes right now.' });
  });

  it('keeps the phone but says to open the app when the relay refuses its credential, without retrying', async () => {
    const id = deviceIdFor((await register(), TOKEN));
    relayReplies = [403];
    await dispatchAlert(clearNight);
    expect(relayCalls).toHaveLength(1);
    expect(getAlertDevice(id)).toMatchObject({ lastStatus: 'error', lastError: 'The phone needs to register again: open Nebulis on it.' });
  });

  it('forgets a phone Apple says is gone', async () => {
    const id = deviceIdFor((await register(), TOKEN));
    relayReplies = [410];
    await dispatchAlert(clearNight);
    expect(getAlertDevice(id)).toBeNull();

    // The same through the Test button.
    await register();
    relayReplies = [410];
    expect(json(await call('POST', `/devices/${id}/test`)).removed).toBe(true);
    expect(getAlertDevice(id)).toBeNull();
  });

  it('counts a phone as a listener, so the evening check runs for phones alone', async () => {
    expect(hasAlertListener('night.clear')).toBe(false);
    const id = json(await register()).id;
    expect(hasAlertListener('night.clear')).toBe(true);
    await call('PUT', `/devices/${id}`, { enabled: false });
    expect(hasAlertListener('night.clear')).toBe(false);
  });
});

describe('the relay address', () => {
  it('takes https, or http on this machine, and falls back to the Nebulis relay for anything else', () => {
    const original = process.env.NEBULIS_PUSH_RELAY_URL;
    try {
      process.env.NEBULIS_PUSH_RELAY_URL = 'https://relay.example.org/';
      expect(pushRelayUrl()).toBe('https://relay.example.org');
      process.env.NEBULIS_PUSH_RELAY_URL = 'http://localhost:8787';
      expect(pushRelayUrl()).toBe('http://localhost:8787');
      for (const bad of ['http://relay.example.org', 'ftp://x', 'not a url']) {
        process.env.NEBULIS_PUSH_RELAY_URL = bad;
        expect(pushRelayUrl()).toBe('https://push.nebulis.app');
      }
      delete process.env.NEBULIS_PUSH_RELAY_URL;
      expect(pushRelayUrl()).toBe('https://push.nebulis.app');
    } finally {
      process.env.NEBULIS_PUSH_RELAY_URL = original;
    }
  });
});
