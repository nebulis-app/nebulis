import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import skyEventsJson from '../../server/data/sky-events.json';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { skyEventsRouter } from '../../server/routes/skyEvents';
import {
  SKY_EVENT_KINDS,
  listSkyEvents,
  nightKeyOf,
  withForecastScores,
  type SkyEvent,
  type SkySite,
} from '../../server/lib/skyEvents';

const PHOENIX: SkySite = { latitude: 33.45, longitude: -112.07, timezone: 'America/Phoenix' };
const SYDNEY: SkySite = { latitude: -33.87, longitude: 151.21, timezone: 'Australia/Sydney' };
const REYKJAVIK: SkySite = { latitude: 64.15, longitude: -21.94, timezone: 'Atlantic/Reykjavik' };

const FILE = skyEventsJson as unknown as {
  version: number; validFrom: string; validUntil: string;
  events: Array<{ id: string; kind: string; peak: string; start?: string; end?: string; bodies: string[]; positions: Array<{ ra: number; dec: number }>; details: Record<string, unknown> }>;
};

const whole = (site: SkySite, kinds?: string[]) =>
  listSkyEvents({ from: new Date('2026-01-01T00:00:00Z'), to: new Date('2036-12-31T23:59:59Z'), site,
                  kinds: kinds ? new Set(kinds as never) : undefined });

function one(site: SkySite, kind: string, day: string, bodies?: string): SkyEvent {
  const hit = whole(site, [kind]).find((e) => e.peak.startsWith(day) && (!bodies || e.bodies.join('+') === bodies));
  if (!hit) throw new Error(`No ${kind} event on ${day}`);
  return hit;
}

describe('sky-events.json', () => {
  it('is a version 1 file covering 2026 to 2036', () => {
    expect(FILE.version).toBe(1);
    expect(FILE.validFrom).toBe('2026-01-01');
    expect(FILE.validUntil).toBe('2036-12-31');
  });

  it('has unique ids, sorted by peak, inside the stated range, with every kind present', () => {
    const ids = new Set(FILE.events.map((e) => e.id));
    expect(ids.size).toBe(FILE.events.length);
    const peaks = FILE.events.map((e) => e.peak);
    expect(peaks).toEqual([...peaks].sort());
    for (const e of FILE.events) {
      expect(e.peak >= '2026-01-01' && e.peak <= '2036-12-31T23:59:59Z', e.id).toBe(true);
    }
    for (const kind of SKY_EVENT_KINDS) expect(FILE.events.some((e) => e.kind === kind), kind).toBe(true);
  });

  it('never holds a null: a missing figure is left out, not written as something that reads as zero', () => {
    expect(JSON.stringify(FILE)).not.toMatch(/:null/);
    for (const e of FILE.events.filter((x) => x.kind === 'solarEclipse')) {
      const type = e.details.type;
      expect('peakLatitude' in e.details, `${e.id} ${String(type)}`).toBe(type !== 'partial');
    }
  });

  it('carries sane positions: RA in hours, Dec in degrees', () => {
    for (const e of FILE.events) {
      expect(e.positions.length, e.id).toBeGreaterThan(0);
      for (const p of e.positions) {
        expect(p.ra, e.id).toBeGreaterThanOrEqual(0);
        expect(p.ra, e.id).toBeLessThan(24);
        expect(Math.abs(p.dec), e.id).toBeLessThanOrEqual(90);
      }
    }
  });

  // Anchors from published tables (NASA eclipse catalogue, the usual opposition and elongation tables), so a regenerated
  // file that drifted, say by a bad unit, fails here instead of quietly shipping wrong dates.
  it('matches published dates', () => {
    const near = (kind: string, title: RegExp, iso: string, days = 1) => {
      const want = Date.parse(iso);
      const hit = FILE.events.find((e) => e.kind === kind && title.test((e as unknown as { title: string }).title) && Math.abs(Date.parse(e.peak) - want) <= days * 86_400_000);
      expect(hit, `${kind} ${title} near ${iso}`).toBeDefined();
    };
    near('solarEclipse', /Total/, '2026-08-12T17:46:00Z');
    near('solarEclipse', /Total/, '2027-08-02T10:07:00Z');
    near('solarEclipse', /Total/, '2028-07-22T02:56:00Z');
    near('lunarEclipse', /Total/, '2026-03-03T11:33:00Z');
    near('opposition', /Jupiter/, '2026-01-10T08:00:00Z');
    near('opposition', /Saturn/, '2026-10-04T12:00:00Z');
    near('opposition', /Mars/, '2027-02-19T16:00:00Z');
    near('elongation', /Venus.*evening/, '2026-08-15T06:00:00Z');
    near('moonPhase', /New Moon/, '2026-10-10T15:50:00Z');
    near('season', /September equinox/, '2026-09-23T00:05:00Z');
  });
});

describe('nightKeyOf', () => {
  it('puts the small hours with the evening before and the daytime with the evening after', () => {
    expect(nightKeyOf(new Date('2026-10-09T09:00:00Z'), 'America/Phoenix')).toBe('2026-10-08'); // 02:00 on the 9th
    expect(nightKeyOf(new Date('2026-10-09T05:00:00Z'), 'America/Phoenix')).toBe('2026-10-08'); // 22:00 on the 8th
    expect(nightKeyOf(new Date('2026-10-08T21:00:00Z'), 'America/Phoenix')).toBe('2026-10-08'); // 14:00 on the 8th
  });
});

describe('judging events from a site', () => {
  it('rates the Perseids from the north and writes them off from the far south', () => {
    const north = one(PHOENIX, 'meteorShower', '2026-08-12');
    expect(north.local.altitudeDeg).toBeGreaterThan(40);
    expect(north.local.bestTime).toBeDefined();
    expect(north.local.moonInterference).toBe('none'); // new Moon that week
    expect(north.local.verdict).toBe('good');
    expect(north.gearNeeds).toContain('wideLens');

    const south = one(SYDNEY, 'meteorShower', '2026-08-12');
    expect(south.local.verdict).toBe('poor');
    expect(south.local.altitudeDeg ?? -1).toBeLessThan(15);
  });

  it('never calls a shower good while a bright Moon is up, and finds some such nights', () => {
    const showers = whole(PHOENIX, ['meteorShower']);
    const severe = showers.filter((e) => e.local.moonInterference === 'severe');
    expect(severe.length).toBeGreaterThan(0);
    for (const e of severe) expect(e.local.verdict, e.id).not.toBe('good');
  });

  it('puts Saturn high at its opposition from Phoenix', () => {
    const e = one(PHOENIX, 'opposition', '2026-10-04');
    expect(e.local.verdict).toBe('good');
    expect(e.local.altitudeDeg).toBeGreaterThanOrEqual(45);
    expect(e.gearNeeds).toContain('planetaryMode');
  });

  it('asks a Moon-free sky for the faint planets and not for the bright ones', () => {
    const neptune = one(PHOENIX, 'opposition', '2026-09-26');
    expect(neptune.gearNeeds).not.toContain('planetaryMode');
    const saturn = one(PHOENIX, 'opposition', '2026-10-04');
    expect(saturn.local.moonInterference).toBe('none');
  });

  it('says whether the Moon is up for a lunar eclipse', () => {
    const phoenix = one(PHOENIX, 'lunarEclipse', '2026-08-28');
    expect(phoenix.local.verdict).not.toBe('poor');
    const sydney = one(SYDNEY, 'lunarEclipse', '2026-08-28');
    expect(sydney.local.verdict).toBe('poor');
    expect(sydney.local.reason).toMatch(/below the horizon/);
  });

  it('only judges a solar eclipse by Sun and distance, and always asks for a solar filter', () => {
    const iceland = one(REYKJAVIK, 'solarEclipse', '2026-08-12');
    expect(iceland.local.verdict).toBe('marginal');
    expect(iceland.local.reason).toMatch(/km from the point of greatest eclipse/);
    expect(iceland.gearNeeds).toContain('solarFilter');
    expect(iceland.tips.join(' ')).toMatch(/solar filter/);
    expect(one(SYDNEY, 'solarEclipse', '2026-08-12').local.verdict).toBe('poor'); // 03:45 there
  });

  it('does not measure a partial eclipse from latitude 0, longitude 0', () => {
    // 2029-01-14 is a partial eclipse with no central point. Phoenix has the Sun up at 17:13 UTC.
    const e = one(PHOENIX, 'solarEclipse', '2029-01-14');
    expect(e.local.verdict).toBe('unknown');
    expect(e.local.reason).not.toMatch(/\bkm\b/);
    expect(e.gearNeeds).toContain('solarFilter');
  });

  it('states the night length at a solstice, and which one is long depends on the hemisphere', () => {
    const e = one(PHOENIX, 'season', '2026-12-21');
    const hours = Number(/([\d.]+) hours/.exec(e.local.reason)?.[1]);
    expect(hours).toBeGreaterThan(13);
    expect(hours).toBeLessThan(15);
    expect(e.tips.join(' ')).toMatch(/longest night/);
    expect(one(SYDNEY, 'season', '2026-12-21').tips.join(' ')).toMatch(/shortest night/);
  });

  it('leaves Moon phases as information, not a verdict', () => {
    const e = one(PHOENIX, 'moonPhase', '2026-10-10');
    expect(e.local.verdict).toBe('unknown');
    expect(e.tips.join(' ')).toMatch(/deep-sky/);
  });

  it('does not call a faint planet good under a Moon that is nearly full and up', () => {
    const uranus = one(PHOENIX, 'opposition', '2026-11-25');
    expect(uranus.local.moonInterference).toBe('severe');
    expect(uranus.local.verdict).toBe('marginal');
    expect(uranus.local.reason).toMatch(/Moon is up then/);
  });

  it('does not call a shower Moon-free when the Moon only sets as dawn arrives', () => {
    // The Ursids peak two nights before a full Moon here: the radiant tops out at dawn, just as the Moon drops away.
    const ursids = one(PHOENIX, 'meteorShower', '2026-12-22');
    expect(ursids.local.moonIllumination).toBeGreaterThan(90);
    expect(ursids.local.verdict).toBe('marginal');
    expect(ursids.local.moonFreeHours ?? 99).toBeLessThan(1);
    expect(ursids.local.reason).toMatch(/Moon-free/);
  });

  it('reports how far apart a pairing is when it is judged, not the separation at the peak minute', () => {
    // 16:00 in Phoenix: daylight. The pair is judged at the closest dark moment and says how far apart they are then.
    const e = one(PHOENIX, 'conjunction', '2026-11-02', 'Moon+Jupiter');
    const sep = Number(/([\d.]+)° apart/.exec(e.local.reason)?.[1]);
    expect(sep).toBeGreaterThan(Number(e.details.separationDeg));
    expect(e.local.bestTime).toBeDefined();
    expect(new Date(e.local.bestTime!).getTime()).not.toBe(new Date(e.peak).getTime());
  });

  it('counts the hours the Moon is up, not the hours it is not', () => {
    const e = one(PHOENIX, 'meteorShower', '2026-10-21'); // Orionids, a 77% Moon that sets in the small hours
    const up = Number(/Moon is up for ([\d.]+) hours/.exec(e.local.reason)?.[1]);
    expect(up).toBeGreaterThan(1);
    // Moon-up plus Moon-free is the whole dark window, about nine and a half hours in October.
    expect(up + (e.local.moonFreeHours ?? 0)).toBeGreaterThan(8.5);
    expect(up + (e.local.moonFreeHours ?? 0)).toBeLessThan(11);
  });

  it('picks the highest moment for two planets, since their separation never changes', () => {
    // Mars and Jupiter are 1.2 degrees apart all night. The time to look is when they stand highest, not a random sample.
    const e = one(PHOENIX, 'conjunction', '2026-11-16', 'Mars+Jupiter');
    expect(e.local.verdict).toBe('good');
    expect(Number(/at least (\d+)° up/.exec(e.local.reason)?.[1])).toBeGreaterThanOrEqual(65);
  });

  it('never claims a body is "at least 0° up"', () => {
    for (const e of whole(PHOENIX)) expect(e.local.reason, e.id).not.toMatch(/at least 0°|reaches 0°|reaches -/);
  });

  it('keeps a body that never rises from being called visible', () => {
    // Pole-ward of 90 - dec the radiant never clears the horizon, whatever the date.
    for (const e of whole(SYDNEY, ['meteorShower']).filter((s) => s.title.startsWith('Perseids'))) {
      expect(e.local.verdict, e.id).toBe('poor');
    }
  });
});

describe('listSkyEvents', () => {
  it('filters by kind and range, in date order, counting an eclipse span that overlaps the range', () => {
    const list = listSkyEvents({ from: new Date('2026-08-27T00:00:00Z'), to: new Date('2026-08-29T00:00:00Z'), site: PHOENIX, kinds: new Set(['lunarEclipse']) });
    expect(list.map((e) => e.id)).toHaveLength(1);
    expect(list[0].peak.startsWith('2026-08-28')).toBe(true);

    const mixed = listSkyEvents({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z'), site: PHOENIX });
    const peaks = mixed.map((e) => e.peak);
    expect(peaks).toEqual([...peaks].sort());
    expect(new Set(mixed.map((e) => e.kind)).has('moonPhase')).toBe(true);
  });
});

describe('withForecastScores', () => {
  it('attaches the score for the night an event belongs to, and nothing else', () => {
    const e = one(PHOENIX, 'meteorShower', '2026-08-12');
    const scored = withForecastScores([e], { nightRatings: [{ date: e.local.night, score: 77 }, { date: '2001-01-01', score: 1 }] });
    expect(scored[0].local.forecastScore).toBe(77);
    expect(withForecastScores([e], { nightRatings: [{ date: '2001-01-01', score: 1 }] })[0].local.forecastScore).toBeUndefined();
  });

  it('shrugs off a forecast that is not a forecast', () => {
    const e = one(PHOENIX, 'meteorShower', '2026-08-12');
    for (const junk of [null, 'x', {}, { nightRatings: 'no' }, { nightRatings: [null, { date: 3 }] }]) {
      expect(withForecastScores([e], junk)).toEqual([e]);
    }
  });
});

describe('GET /sky-events', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
    app.use('/sky-events', skyEventsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); vi.restoreAllMocks(); });

  const get = async (qs: string) => {
    const r = await fetch(`${base}/sky-events?${qs}`);
    return { status: r.status, body: await r.json() as { data?: { events: SkyEvent[]; site: { timezone: string }; from: string; to: string; validUntil: string }; error?: { code: string } } };
  };

  it('returns judged events for a place and range', async () => {
    const { status, body } = await get('lat=33.45&lon=-112.07&from=2026-08-01&to=2026-08-31');
    expect(status).toBe(200);
    expect(body.data!.site.timezone).toBe('America/Phoenix');
    expect(body.data!.validUntil).toBe('2036-12-31');
    const perseids = body.data!.events.find((e) => e.title === 'Perseids peak');
    expect(perseids?.local.verdict).toBe('good');
    expect(body.data!.events.every((e) => e.peak >= '2026-08-01' && e.peak <= '2026-09-01')).toBe(true);
  });

  it('narrows by kind', async () => {
    const { body } = await get('lat=33.45&lon=-112.07&from=2026-08-01&to=2026-12-31&kinds=opposition,lunarEclipse');
    const kinds = new Set(body.data!.events.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['lunarEclipse', 'opposition']);
  });

  it('rejects what it cannot answer', async () => {
    expect((await get('lat=33&lon=-112&kinds=comets')).body.error?.code).toBe('INVALID_KINDS');
    expect((await get('lat=33&lon=-112&from=2026-10-10&to=2026-10-01')).body.error?.code).toBe('INVALID_RANGE');
    expect((await get('lat=33&lon=-112&from=2026-01-01&to=2031-01-01')).body.error?.code).toBe('RANGE_TOO_LARGE');
    expect((await get('lat=33&lon=-112&from=tomorrow')).body.error?.code).toBe('INVALID_QUERY');
    expect((await get('lat=95&lon=-112')).body.error?.code).toBe('INVALID_QUERY');
    expect((await get('lat=33')).body.error?.code).toBe('INVALID_COORDS');
  });
});
