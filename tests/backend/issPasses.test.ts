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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-iss-test-'));
  process.env.DATA_DIR = dir;
  process.env.NEBULIS_PHONE_ALERTS = '1';
  return dir;
});
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_MIN_ALTITUDE, PassCalculator, estimateMagnitude, isSunlit, sunPositionKm, tleEpoch,
} from '../../server/lib/iss/passes';
import { REFRESH_MS, STALE_MS, _resetIssTleForTests, getIssTle } from '../../server/lib/iss/tle';
import { _setRetryDelayForTests } from '../../server/lib/alerts/delivery';
import { issPassDue, runIssPassAlerts, _resetIssPassAlertsForTests } from '../../server/lib/alerts/issPass';
import { formatAlert } from '../../server/lib/alerts/messages';
import {
  deleteAlertDevice, getAlertState, listAlertChannels, deleteAlertChannel, listAlertDevices, registerAlertDevice, updateAlertDevice,
} from '../../server/lib/alerts/store';
import { createSite, setActiveSite } from '../../server/lib/observingSites';

/**
 * The reference: Skyfield 1.55 on the same TLE from the same site (2.35° E, 48.85° N, 35 m), 26 to 29 November 2026.
 * Rise, culmination and set at 0° and 10° (geometric), whether the station is sunlit at each, the Sun's altitude, and
 * the instant each evening pass enters Earth's shadow. See the fixture for the TLE.
 */
const REF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'iss', 'skyfield-iss-paris-2026-11-26.json'), 'utf8')) as {
  tle: string[];
  site: { latitude: number; longitude: number; elevationM: number };
  from: string;
  to: string;
  events: { minAlt: number; event: 'rise' | 'culminate' | 'set'; t: string; alt: number; az: number; sunlit: boolean; sunAlt: number }[];
  shadowEntries: { rise: string; shadowEntry: string }[];
};
const LINE1 = REF.tle[1];
const LINE2 = REF.tle[2];
const ms = (iso: string) => Date.parse(iso);
/** The issue asks for ±10 s against a reference; this holds well inside it. */
const TOLERANCE_S = 1;

function refPasses(minAlt: number) {
  const ev = REF.events.filter(e => e.minAlt === minAlt);
  const out = [];
  for (let i = 0; i + 2 < ev.length; i += 3) out.push({ rise: ev[i], peak: ev[i + 1], set: ev[i + 2] });
  return out;
}

describe('ISS passes against Skyfield', () => {
  const calc = new PassCalculator(LINE1, LINE2, REF.site);

  it.each([0, 10])('finds the same passes above %i°, to the second', (minAlt) => {
    const ours = calc.passes(new Date(REF.from), new Date(REF.to), minAlt);
    const ref = refPasses(minAlt);
    expect(ours).toHaveLength(ref.length);
    ours.forEach((p, i) => {
      expect(Math.abs(ms(p.rise.t) - ms(ref[i].rise.t)) / 1000).toBeLessThanOrEqual(TOLERANCE_S);
      expect(Math.abs(ms(p.peak.t) - ms(ref[i].peak.t)) / 1000).toBeLessThanOrEqual(TOLERANCE_S);
      expect(Math.abs(ms(p.set.t) - ms(ref[i].set.t)) / 1000).toBeLessThanOrEqual(TOLERANCE_S);
      expect(p.peak.alt).toBeCloseTo(ref[i].peak.alt, 1);
      // The azimuth swings fastest at the top of a high pass, so a tenth of a second there is most of a degree.
      expect(Math.abs(((p.peak.az - ref[i].peak.az + 540) % 360) - 180)).toBeLessThan(1);
    });
  });

  it("says a pass is visible only in a dark sky with the station lit, and when it fades into Earth's shadow", () => {
    const ours = calc.passes(new Date(REF.from), new Date(REF.to), DEFAULT_MIN_ALTITUDE);
    const ref = refPasses(DEFAULT_MIN_ALTITUDE);
    ours.forEach((p, i) => {
      const r = ref[i];
      const darkSomewhere = [r.rise, r.peak, r.set].some(e => e.sunAlt < -6 && e.sunlit);
      if (r.rise.sunAlt > -6 && r.set.sunAlt > -6) expect(p.visible).toBeNull(); // daylight or twilight throughout
      if (darkSomewhere) expect(p.visible).not.toBeNull();
      expect(p.endsInShadow).toBe(p.visible !== null && r.rise.sunlit && !r.set.sunlit);
    });
    expect(ours.filter(p => p.visible).length).toBeGreaterThan(3);
  });

  it("enters the shadow when Skyfield says it does, within two seconds", () => {
    const ours = calc.passes(new Date(REF.from), new Date(REF.to), DEFAULT_MIN_ALTITUDE);
    for (const entry of REF.shadowEntries) {
      const pass = ours.find(p => Math.abs(ms(p.rise.t) - ms(entry.rise)) < 2000)!;
      expect(pass.endsInShadow).toBe(true);
      expect(Math.abs(ms(pass.visible!.end.t) - ms(entry.shadowEntry)) / 1000).toBeLessThanOrEqual(2);
    }
  });

  it('gives a magnitude only to a visible pass, brighter high and close than low and far', () => {
    const ours = calc.passes(new Date(REF.from), new Date(REF.to), DEFAULT_MIN_ALTITUDE);
    for (const p of ours) expect(p.magnitude === null).toBe(p.visible === null);
    const visible = ours.filter(p => p.visible);
    const high = visible.reduce((a, b) => (b.visible!.peak.alt > a.visible!.peak.alt ? b : a));
    const low = visible.reduce((a, b) => (b.visible!.peak.alt < a.visible!.peak.alt ? b : a));
    expect(high.magnitude!).toBeLessThan(low.magnitude!);
    expect(high.magnitude!).toBeGreaterThan(-5);
  });
});

describe('the pieces', () => {
  it('reads the TLE epoch', () => {
    expect(Math.abs(tleEpoch(LINE1)!.getTime() - Date.parse('2026-11-25T21:53:31.476Z'))).toBeLessThan(2);
    expect(tleEpoch('nonsense')).toBeNull();
  });

  it('puts the Sun where it is: in Sagittarius-Ophiuchus in late November, a little south of the equator', () => {
    const s = sunPositionKm(new Date('2026-11-26T12:00:00Z'));
    const r = Math.hypot(s.x, s.y, s.z);
    expect(r / 149_597_870.7).toBeCloseTo(0.987, 2);
    const dec = Math.asin(s.z / r) * 180 / Math.PI;
    expect(dec).toBeCloseTo(-21.0, 0);
  });

  it('is sunlit unless the Earth stands between it and the Sun', () => {
    const sun = { x: 1.5e8, y: 0, z: 0 };
    expect(isSunlit({ x: 6800, y: 0, z: 0 }, sun)).toBe(true); // day side
    expect(isSunlit({ x: -6800, y: 0, z: 0 }, sun)).toBe(false); // straight behind the Earth
    expect(isSunlit({ x: -6800, y: 6500, z: 0 }, sun)).toBe(true); // behind, but above the shadow
  });

  it('is the standard magnitude half lit at 1000 km, and brighter fully lit or closer', () => {
    expect(estimateMagnitude(1000, Math.PI / 2)).toBeCloseTo(-1.8, 6);
    expect(estimateMagnitude(1000, 0)).toBeLessThan(-1.8);
    expect(estimateMagnitude(500, Math.PI / 2)).toBeCloseTo(-1.8 + 5 * Math.log10(0.5), 6);
  });
});

describe('the ISS elements', () => {
  const epoch = tleEpoch(LINE1)!;
  const text = `ISS (ZARYA)\n${LINE1}\n${LINE2}\n`;

  beforeEach(() => _resetIssTleForTests());

  it('asks CelesTrak, keeps the answer, and does not ask again before a few hours', async () => {
    let asked = 0;
    const fetcher = async () => { asked++; return text; };
    const now = new Date(epoch.getTime() + 6 * 3_600_000);
    const tle = await getIssTle({ allowFetch: true, now, fetcher });
    expect(tle).toMatchObject({ source: 'iss', stale: false, epoch: epoch.toISOString(), ageHours: 6 });
    await getIssTle({ allowFetch: true, now: new Date(now.getTime() + REFRESH_MS - 60_000), fetcher });
    expect(asked).toBe(1);
    await getIssTle({ allowFetch: true, now: new Date(now.getTime() + REFRESH_MS + 60_000), fetcher });
    expect(asked).toBe(2);
  });

  it('flags elements older than three days instead of trusting them', async () => {
    const tle = await getIssTle({ allowFetch: true, now: new Date(epoch.getTime() + STALE_MS + 3_600_000), fetcher: async () => text });
    expect(tle?.stale).toBe(true);
  });

  it('keeps what it has when CelesTrak fails, and does not ask again at once', async () => {
    await getIssTle({ allowFetch: true, now: new Date(epoch.getTime()), fetcher: async () => text });
    let asked = 0;
    const failing = async () => { asked++; throw new Error('HTTP 503'); };
    const later = new Date(epoch.getTime() + REFRESH_MS + 60_000);
    expect((await getIssTle({ allowFetch: true, now: later, fetcher: failing }))?.source).toBe('iss');
    await getIssTle({ allowFetch: true, now: new Date(later.getTime() + 60_000), fetcher: failing });
    expect(asked).toBe(1);
  });
});

describe('GET /sky-events/iss-passes', () => {
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

  it('lists the visible passes with the age of the elements, and refuses half a coordinate', async () => {
    _resetIssTleForTests();
    // Elements kept a moment ago, so the route does not ask CelesTrak.
    await getIssTle({ allowFetch: true, fetcher: async () => `ISS (ZARYA)\n${LINE1}\n${LINE2}\n` });
    const res = await fetch(`${base}/sky-events/iss-passes?lat=48.85&lon=2.35&days=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tle).toMatchObject({ source: 'iss', epoch: tleEpoch(LINE1)!.toISOString() });
    expect(body.data.minAltitude).toBe(10);
    for (const p of body.data.passes) expect(p.visible).not.toBeNull();
    const all = await (await fetch(`${base}/sky-events/iss-passes?lat=48.85&lon=2.35&days=2&all=1`)).json();
    expect(all.data.passes.length).toBeGreaterThanOrEqual(body.data.passes.length);
    expect((await fetch(`${base}/sky-events/iss-passes?lat=48.85`)).status).toBe(400);
  });
});

describe('the ISS pass alert', () => {
  let relay: http.Server;
  let calls: { url: string; body: Record<string, unknown> }[] = [];
  const calc = new PassCalculator(LINE1, LINE2, REF.site);
  const visible = calc.passes(new Date(REF.from), new Date(REF.to), 10).filter(p => p.visible);
  const high = visible.find(p => p.visible!.peak.alt >= 45)!;
  const low = visible.find(p => p.visible!.peak.alt < 30)!;
  const tleSource = async () => ({
    record: { name: 'ISS (ZARYA)', line1: LINE1, line2: LINE2, noradId: 25544 },
    epoch: tleEpoch(LINE1)!.toISOString(), ageHours: 20, stale: false, source: 'iss' as const,
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
    _resetIssPassAlertsForTests();
    for (const d of listAlertDevices()) deleteAlertDevice(d.id);
    for (const c of listAlertChannels()) deleteAlertChannel(c.id);
    setActiveSite(createSite({ name: 'Paris', latitude: REF.site.latitude, longitude: REF.site.longitude, timezone: 'Europe/Paris' }).id);
  });

  const phone = (token: string, lead: number, minAlt: number) => {
    const { device } = registerAlertDevice({ token: token.repeat(32), apnsEnv: 'production', credential: `cred-${token}`, name: `Phone ${token}` });
    updateAlertDevice(device.id, { events: ['iss.pass'], details: { issLeadMinutes: lead, issMinAltitude: minAlt }, enabled: true });
    return device.id;
  };

  it('is due from the lead time before the pass becomes visible, high enough, until it starts', () => {
    const start = Date.parse(high.visible!.start.t);
    expect(issPassDue(new Date(start - 10 * 60_000 - 1000), high, 10, 30)).toBe(false);
    expect(issPassDue(new Date(start - 10 * 60_000), high, 10, 30)).toBe(true);
    expect(issPassDue(new Date(start + 1000), high, 10, 30)).toBe(false);
    expect(issPassDue(new Date(start - 60_000), low, 10, 30)).toBe(false); // too low for this destination
    expect(issPassDue(new Date(start - 60_000), { ...high, visible: null }, 10, 30)).toBe(false);
  });

  it('goes once per pass, to each destination at its own time and height', async () => {
    const early = phone('aa', 15, 30);
    const fussy = phone('bb', 15, 80); // nothing reaches 80°
    const now = new Date(Date.parse(high.visible!.start.t) - 12 * 60_000);
    expect(await runIssPassAlerts(now, tleSource)).toBe(1);
    expect(await runIssPassAlerts(new Date(now.getTime() + 60_000), tleSource)).toBe(0); // once per pass
    expect(getAlertState<string>(`iss.sent.${early}`)).toBe(high.visible!.start.t);
    expect(getAlertState<string>(`iss.sent.${fussy}`)).toBeNull();
    expect(calls.filter(c => c.url === '/v1/push')).toHaveLength(1);
  });

  it('says where to look and when, in the alert language', () => {
    const data = {
      siteName: 'Paris', timeZone: 'Europe/Paris', start: '2026-11-26T16:50:24.000Z', peak: '2026-11-26T16:53:39.000Z',
      end: '2026-11-26T16:56:55.000Z', startAz: 250, peakAz: 180, endAz: 100, maxAlt: 62.2, magnitude: -3.4,
      endsInShadow: true, leadMinutes: 10, staleDays: null,
    };
    const en = formatAlert({ type: 'iss.pass', occurredAt: data.start, data }, 'en');
    expect(en.title).toBe('ISS in 10 min: Paris');
    expect(en.body).toContain('From W at 17:50, highest 62° in the S at 17:53, then E at 17:56');
    expect(en.body).toContain("It fades into Earth's shadow before it sets.");
    const fr = formatAlert({ type: 'iss.pass', occurredAt: data.start, data: { ...data, staleDays: 4 } }, 'fr');
    expect(fr.body).toContain('Depuis le O à 17:50');
    expect(fr.body).toContain('vieilles de 4 jours');
  });
});
