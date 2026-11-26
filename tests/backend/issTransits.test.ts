import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// Its own DATA_DIR (the kept TLE, the alert store), and phone alerts on, before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-isstransit-test-'));
  process.env.DATA_DIR = dir;
  process.env.NEBULIS_PHONE_ALERTS = '1';
  return dir;
});

import express from 'express';
import fs from 'fs';
import path from 'path';
import { moonPosition } from '../../server/lib/iss/moon';
import { TransitFinder, bearingDeg, distanceKm, type IssTransit } from '../../server/lib/iss/transits';
import { tleEpoch } from '../../server/lib/iss/passes';
import { _resetIssTleForTests, getIssTle } from '../../server/lib/iss/tle';
import { _setRetryDelayForTests } from '../../server/lib/alerts/delivery';
import { findTold, runIssTransitAlerts, transitStageDue, _resetIssTransitAlertsForTests } from '../../server/lib/alerts/issTransit';
import { formatAlert } from '../../server/lib/alerts/messages';
import { deleteAlertDevice, listAlertChannels, deleteAlertChannel, listAlertDevices, registerAlertDevice, updateAlertDevice } from '../../server/lib/alerts/store';
import { createSite, setActiveSite } from '../../server/lib/observingSites';

const FIX = path.join(__dirname, '..', 'fixtures', 'iss');
/** Skyfield 1.55 with DE421: the Moon's geocentric position in SGP4's TEME frame at five instants, 2024 to 2030. */
const MOON = JSON.parse(fs.readFileSync(path.join(FIX, 'skyfield-moon.json'), 'utf8')) as { t: string; distanceKm: number; xyzTeme: number[] }[];
/**
 * Skyfield 1.55, DE421 and SGP4 on a real ISS TLE: two real transits, the Moon on 2 December 2026 (centre line over
 * south-east Spain) and the Sun on 26 November 2026 (over Austria). For each: a site a few kilometres off the centre
 * line, the centre line every second for two minutes, its closest point to the site and when, the band half-width,
 * the duration on the centre line, and the body's altitude there. Computed independently: the centre line is where the
 * line from the body's centre through the station meets the WGS84 ellipsoid.
 */
const REF = JSON.parse(fs.readFileSync(path.join(FIX, 'skyfield-iss-transits.json'), 'utf8')) as {
  tle: string[];
  events: {
    body: 'moon' | 'sun';
    site: { latitude: number; longitude: number };
    nearest: { t: string; lat: number; lon: number; distanceKm: number };
    bodyAlt: number;
    bandHalfWidthKm: number;
    durationSec: number;
    centerline: { t: string; lat: number; lon: number }[];
  }[];
};
const LINE1 = REF.tle[1];
const LINE2 = REF.tle[2];
/** How close the centre line has to be, km: the Moon's position is good to a few arc seconds, the Sun's to 0.01°. */
const LINE_TOLERANCE_KM = { moon: 0.1, sun: 0.4 } as const;

function findAround(e: (typeof REF.events)[number], radiusKm = 50, site = { lat: e.site.latitude, lon: e.site.longitude }) {
  const at = Date.parse(e.nearest.t);
  return new TransitFinder(LINE1, LINE2, site).find(e.body, new Date(at - 3_600_000), new Date(at + 3_600_000), radiusKm);
}

describe("the Moon's position", () => {
  it.each(MOON.map(m => [m.t, m] as const))('agrees with DE421 at %s, in the ISS frame, within 10"', (_t, ref) => {
    const m = moonPosition(new Date(ref.t));
    const v = ref.xyzTeme;
    const cos = (m.x * v[0] + m.y * v[1] + m.z * v[2]) / (m.distanceKm * Math.hypot(v[0], v[1], v[2]));
    expect(Math.acos(Math.min(1, cos)) * 180 / Math.PI * 3600).toBeLessThan(10);
    expect(Math.abs(m.distanceKm - ref.distanceKm)).toBeLessThan(5);
  });
});

describe('transits against Skyfield', () => {
  it.each(REF.events.map(e => [e.body, e] as const))('finds the %s transit at the right time and place', (body, e) => {
    const found = findAround(e);
    expect(found).toHaveLength(1);
    const tr = found[0];
    expect(tr.body).toBe(body);
    // To the tenth of a second, which is what the issue asks for.
    expect(Math.abs(Date.parse(tr.time) - Date.parse(e.nearest.t)) / 1000).toBeLessThanOrEqual(0.1);
    expect(distanceKm(tr.nearest, e.nearest)).toBeLessThan(LINE_TOLERANCE_KM[body]);
    expect(Math.abs(tr.nearest.distanceKm - e.nearest.distanceKm)).toBeLessThan(LINE_TOLERANCE_KM[body]);
    expect(tr.bandHalfWidthKm).toBeCloseTo(e.bandHalfWidthKm, 1);
    expect(Math.abs(tr.durationSec - e.durationSec) / e.durationSec).toBeLessThan(0.05);
    expect(tr.bodyAltitude).toBeCloseTo(e.bodyAlt, 1);
    expect(tr.siteInBand).toBe(e.nearest.distanceKm <= e.bandHalfWidthKm);
  });

  it.each(REF.events.map(e => [e.body, e] as const))('draws the %s centre line where Skyfield does, second by second', (body, e) => {
    const finder = new TransitFinder(LINE1, LINE2, { lat: e.site.latitude, lon: e.site.longitude });
    for (const p of e.centerline) {
      const g = finder.groundPoint(body, Date.parse(p.t));
      expect(g).not.toBeNull();
      expect(distanceKm(g!, p)).toBeLessThan(LINE_TOLERANCE_KM[body]);
    }
  });

  it('says how far and which way the centre line is from a site outside the band, and leaves out what is past the radius', () => {
    const e = REF.events.find(x => x.body === 'moon')!;
    // 30 km north-west of the reference site: outside a band a few kilometres wide.
    const site = { lat: e.site.latitude + 0.19, lon: e.site.longitude - 0.24 };
    const [tr] = findAround(e, 50, site);
    expect(tr.siteInBand).toBe(false);
    expect(tr.nearest.distanceKm).toBeGreaterThan(5);
    expect(tr.nearest.distanceKm).toBeLessThan(50);
    expect(tr.nearest.bearingDeg).toBeCloseTo(bearingDeg(site, tr.nearest), 0);
    expect(findAround(e, Math.floor(tr.nearest.distanceKm) - 1, site)).toEqual([]);
  });
});

describe('ground geometry', () => {
  it('measures distances and bearings on the sphere', () => {
    const paris = { lat: 48.8566, lon: 2.3522 };
    const lyon = { lat: 45.764, lon: 4.8357 };
    expect(distanceKm(paris, lyon)).toBeCloseTo(392, -1);
    expect(bearingDeg(paris, lyon)).toBeGreaterThan(140);
    expect(bearingDeg(paris, lyon)).toBeLessThan(160);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
  });
});

describe('GET /sky-events/iss-transits', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    const { apiEnvelope } = await import('../../server/middleware/apiEnvelope');
    const { skyEventsRouter } = await import('../../server/routes/skyEvents');
    const app = express();
    app.use(apiEnvelope);
    app.use('/sky-events', skyEventsRouter);
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

  it('answers with the elements, the radius, and transits sorted in time', async () => {
    _resetIssTleForTests();
    await getIssTle({ allowFetch: true, fetcher: async () => `ISS (ZARYA)\n${LINE1}\n${LINE2}\n` });
    const res = await fetch(`${base}/sky-events/iss-transits?lat=48.85&lon=2.35&radiusKm=100&days=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tle.epoch).toBe(tleEpoch(LINE1)!.toISOString());
    expect(body.data.radiusKm).toBe(100);
    const times = (body.data.transits as IssTransit[]).map(t => Date.parse(t.time));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const t of body.data.transits as IssTransit[]) expect(t.nearest.distanceKm).toBeLessThanOrEqual(100);
    expect((await fetch(`${base}/sky-events/iss-transits?lat=48.85&lon=2.35&radiusKm=1000`)).status).toBe(400);
  });
});

describe('the ISS transit alert', () => {
  let relay: http.Server;
  let calls: { url: string; body: Record<string, unknown> }[] = [];
  const moon = REF.events.find(e => e.body === 'moon')!;
  const transitAt = Date.parse(moon.nearest.t);
  const tleSource = async () => ({
    record: { name: 'ISS (ZARYA)', line1: LINE1, line2: LINE2, noradId: 25544 },
    epoch: tleEpoch(LINE1)!.toISOString(), ageHours: 30, stale: false, source: 'iss' as const,
  });

  beforeAll(async () => {
    _setRetryDelayForTests(5);
    relay = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        calls.push({ url: req.url ?? '', body: JSON.parse(body || '{}') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>(r => relay.listen(0, r));
    process.env.NEBULIS_PUSH_RELAY_URL = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.NEBULIS_PUSH_RELAY_URL;
    await new Promise<void>(r => relay.close(() => r()));
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    calls = [];
    _resetIssTransitAlertsForTests();
    for (const d of listAlertDevices()) deleteAlertDevice(d.id);
    for (const c of listAlertChannels()) deleteAlertChannel(c.id);
    setActiveSite(createSite({ name: 'Cartagena', latitude: moon.site.latitude, longitude: moon.site.longitude, timezone: 'Europe/Madrid' }).id);
  });

  const phone = (token: string, radiusKm: number) => {
    const { device } = registerAlertDevice({ token: token.repeat(32), apnsEnv: 'production', credential: `cred-${token}`, name: `Phone ${token}` });
    updateAlertDevice(device.id, { events: ['iss.transit'], details: { issTransitRadiusKm: radiusKm }, enabled: true });
    return device.id;
  };
  const pushes = () => calls.filter(c => c.url === '/v1/push');

  it('is due a day ahead, then two hours ahead, and not before or after', () => {
    const tr = { time: moon.nearest.t };
    expect(transitStageDue(new Date(transitAt - 25 * 3_600_000), tr)).toBeNull();
    expect(transitStageDue(new Date(transitAt - 23 * 3_600_000), tr)).toBe('day');
    expect(transitStageDue(new Date(transitAt - 90 * 60_000), tr)).toBe('final');
    expect(transitStageDue(new Date(transitAt + 1000), tr)).toBeNull();
    // A recomputation that moves it by seconds is the same transit; the other body at the same time is not.
    const told = [{ body: 'moon' as const, time: moon.nearest.t, stages: ['day' as const] }];
    expect(findTold(told, { body: 'moon', time: new Date(transitAt + 20_000).toISOString() })).toBeDefined();
    expect(findTold(told, { body: 'moon', time: new Date(transitAt - 9 * 60_000).toISOString() })).toBeDefined();
    expect(findTold(told, { body: 'sun', time: moon.nearest.t })).toBeUndefined();
    expect(findTold(told, { body: 'moon', time: new Date(transitAt + 90 * 60_000).toISOString() })).toBeUndefined();
  });

  it('sends the day notice once, then the final notice once, and nothing to a destination whose radius it misses', async () => {
    // A site about twenty kilometres from the Moon's centre line: in a 50 km radius, outside the 5 km minimum.
    const site = { lat: moon.site.latitude + 0.19, lon: moon.site.longitude - 0.24 };
    setActiveSite(createSite({ name: 'Inland', latitude: site.lat, longitude: site.lon, timezone: 'Europe/Madrid' }).id);
    phone('aa', 50);
    phone('bb', 5);
    // Around here the Sun is crossed too in the same day; count what the same search finds within 50 km.
    const finder = new TransitFinder(LINE1, LINE2, site);
    const dueAt = (now: Date) => ['moon', 'sun'].flatMap(b => finder.find(b as 'moon' | 'sun', now, new Date(now.getTime() + 25 * 3_600_000), 50))
      .filter(t => transitStageDue(now, t) !== null);

    const dayBefore = new Date(transitAt - 20 * 3_600_000);
    const firstRound = dueAt(dayBefore);
    const moonTransit = firstRound.find(t => t.body === 'moon')!;
    expect(moonTransit.nearest.distanceKm).toBeGreaterThan(5);
    expect(firstRound.every(t => t.nearest.distanceKm > 5)).toBe(true);
    expect(await runIssTransitAlerts(dayBefore, tleSource)).toBe(firstRound.length);
    expect(await runIssTransitAlerts(new Date(dayBefore.getTime() + 5 * 60_000), tleSource)).toBe(0); // once per notice

    const twoHours = new Date(transitAt - 100 * 60_000);
    const sent = await runIssTransitAlerts(twoHours, tleSource);
    expect(sent).toBeGreaterThanOrEqual(1); // at least the Moon's final notice
    expect(await runIssTransitAlerts(new Date(twoHours.getTime() + 5 * 60_000), tleSource)).toBe(0);
    // Every push went to the phone whose radius includes them.
    expect(pushes().every(c => String(c.body.token).startsWith('aa'))).toBe(true);
    expect(pushes()).toHaveLength(firstRound.length + sent);
  });

  it('says when, how long, where to stand, how old the data is, and warns about the Sun', () => {
    const data = {
      siteName: 'Cartagena', timeZone: 'Europe/Madrid', body: 'sun' as const, time: '2026-11-26T12:03:20.700Z', durationSec: 1.94,
      distanceKm: 12.3, bearingDeg: 315, siteInBand: false, bandHalfWidthKm: 4.95, stage: 'final' as const, tleAgeHours: 7.6,
    };
    const en = formatAlert({ type: 'iss.transit', occurredAt: '2026-11-26T10:33:20.000Z', data }, 'en');
    expect(en.title).toBe('ISS crosses the Sun in 90 min');
    expect(en.body).toContain('At 13:03:20.7, for 1.9 s.');
    expect(en.body).toContain('The centre line is 12.3 km to the NW: the band is 9.9 km wide.');
    expect(en.body).toContain('Worked out again with orbit data 8 h old.');
    expect(en.body).toContain('Solar filter');
    const fr = formatAlert({ type: 'iss.transit', occurredAt: '2026-11-25T13:03:20.000Z', data: { ...data, body: 'moon', siteInBand: true, distanceKm: 2.3, stage: 'day' } }, 'fr');
    expect(fr.title).toBe("L'ISS passe devant la Lune dans 23 h");
    expect(fr.body).toContain('Vous êtes dans la bande, à 2.3 km de la ligne centrale.');
    expect(fr.body).not.toContain('Filtre solaire');
  });
});
