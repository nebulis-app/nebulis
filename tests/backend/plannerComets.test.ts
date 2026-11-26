import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import db from '../../server/lib/db';
import { altAz } from '../../server/lib/astroCalc';
import {
  EPHEMERIS_DAYS, HorizonsError, _resetHorizonsForTests, ephemerisFor, horizonsCommand, horizonsQueryUrl,
  parseHorizonsResponse, positionAt, type EphemerisRow,
} from '../../server/lib/horizons';
import {
  MAX_WATCHLIST, SmallBodyInputError, aboveFloor, addToWatchlist, bodyNights, listSmallBodies, parseSmallBodyInput,
  removeFromWatchlist,
} from '../../server/lib/cometPlanner';
import { updateSettingsData } from '../../server/lib/telescopes';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'horizons');
const load = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
/** Real answers, from a site at 2.35° E, 48.85° N (Paris), hourly. */
const A3 = load('a3-3days.json'); // C/2023 A3 (Tsuchinshan-ATLAS), 2024-10-14 12:00 to 2024-10-17 12:00 UT
const VESTA = load('vesta-1day.json'); // (4) Vesta, 2026-11-26 12:00 to 2026-11-27 12:00 UT
const NOPE = load('nope.json'); // DES=C/2099 Z9: no such comet
const PARIS = { latitude: 48.85, longitude: 2.35 };

describe('Horizons answers', () => {
  it('reads a comet ephemeris: J2000 RA in hours, Dec, azimuth, elevation, total magnitude', () => {
    const rows = parseHorizonsResponse(A3);
    expect(rows).toHaveLength(73);
    expect(rows[6]).toEqual({ t: '2024-10-14T18:00:00.000Z', ra: 223.34130 / 15, dec: 0.15061, az: 256.653546, alt: 11.471502, mag: 6 });
  });

  it("reads an asteroid's apparent magnitude from its own column", () => {
    const rows = parseHorizonsResponse(VESTA);
    expect(rows[6]).toMatchObject({ t: '2026-11-26T18:00:00.000Z', mag: 7.241 });
    expect(rows[6].ra).toBeCloseTo(15.08576 / 15, 8);
  });

  it("agrees with the planner's own sky math: Horizons' elevation from its RA/Dec, within a degree", () => {
    // Horizons' elevation is apparent (precession to date, refraction); the planner's is J2000 without refraction.
    // A degree covers both at these heights, and would not cover a wrong unit or a swapped sign.
    for (const r of parseHorizonsResponse(VESTA).filter(row => row.alt > 20)) {
      expect(Math.abs(altAz(r.ra, r.dec, PARIS.latitude, PARIS.longitude, new Date(r.t)).alt - r.alt)).toBeLessThan(1);
    }
  });

  it('says when Horizons knows no such body, and when the answer is not an ephemeris', () => {
    expect(() => parseHorizonsResponse(NOPE)).toThrow(HorizonsError);
    try { parseHorizonsResponse(NOPE); } catch (err) { expect((err as HorizonsError).code).toBe('not-found'); }
    expect(() => parseHorizonsResponse({ error: 'Cannot read: bad COMMAND' })).toThrow(/bad COMMAND/);
    expect(() => parseHorizonsResponse({ result: 'nothing here' })).toThrow(HorizonsError);
  });

  it('asks for a comet by designation (latest apparition, no fragments) and an asteroid by number or name', () => {
    expect(horizonsCommand('C/2023 A3', 'comet')).toBe("'DES=C/2023 A3;CAP;NOFRAG'");
    expect(horizonsCommand('4', 'asteroid')).toBe("'4;'");
    const url = new URL(horizonsQueryUrl('12P', 'comet', { ...PARIS, elevationM: 50 }, new Date('2026-11-26T12:00:00Z'), new Date('2026-11-27T12:00:00Z')));
    expect(url.searchParams.get('SITE_COORD')).toBe("'2.3500,48.8500,0.050'");
    expect(url.searchParams.get('START_TIME')).toBe("'2026-11-26 12:00'");
    expect(url.searchParams.get('QUANTITIES')).toBe("'1,4,9'");
  });

  it('interpolates the position between two hours, across RA 0h too', () => {
    const rows = parseHorizonsResponse(A3);
    const half = positionAt(rows, new Date('2024-10-14T18:30:00Z'))!;
    expect(half.ra).toBeCloseTo((223.34130 + 223.55974) / 2 / 15, 8);
    expect(half.dec).toBeCloseTo((0.15061 + 0.17346) / 2, 8);
    expect(positionAt(rows, new Date('2020-01-01T00:00:00Z'))).toBeNull();
    const wrap: EphemerisRow[] = [
      { t: '2026-01-01T00:00:00.000Z', ra: 23.9, dec: 0, az: 0, alt: 0, mag: null },
      { t: '2026-01-01T01:00:00.000Z', ra: 0.1, dec: 0, az: 0, alt: 0, mag: null },
    ];
    expect(positionAt(wrap, new Date('2026-01-01T00:30:00Z'))!.ra).toBeCloseTo(0, 8);
  });
});

describe('ephemerisFor', () => {
  beforeEach(() => {
    _resetHorizonsForTests();
    db.prepare('DELETE FROM ephemerisCache').run();
  });

  it('asks once per body, day and site, from the hour before, and keeps the answer', async () => {
    const fetcher = vi.fn(async () => A3);
    const from = new Date('2024-10-14T12:20:00Z');
    const rows = await ephemerisFor('C/2023 A3', 'comet', PARIS, from, fetcher);
    expect(rows).toHaveLength(73);
    const url = new URL((fetcher.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get('START_TIME')).toBe("'2024-10-14 12:00'");
    expect(url.searchParams.get('STOP_TIME')).toBe(`'2024-10-${14 + EPHEMERIS_DAYS} 12:00'`);
    await ephemerisFor('C/2023 A3', 'comet', PARIS, from, fetcher);
    await ephemerisFor('C/2023 A3', 'comet', { latitude: 48.851, longitude: 2.351 }, from, fetcher); // same 0.1° cell
    expect(fetcher).toHaveBeenCalledTimes(1);
    await ephemerisFor('C/2023 A3', 'comet', { latitude: 43.6, longitude: 1.44 }, from, fetcher); // another site
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failure', async () => {
    await expect(ephemerisFor('C/2099 Z9', 'comet', PARIS, new Date(), async () => NOPE)).rejects.toThrow(HorizonsError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ephemerisCache').get()).toEqual({ n: 0 });
  });
});

describe('the night of a comet', () => {
  const rows = parseHorizonsResponse(A3);
  // The evening of 14 October 2024 in Paris: the comet sets in the west after dusk.
  const evening = { start: new Date('2024-10-14T17:00:00Z'), end: new Date('2024-10-15T04:00:00Z') };

  it('finds its best hour in the window, its height, its magnitude and the Moon then', () => {
    const [night] = bodyNights(rows, [evening], PARIS, 5);
    expect(night).toMatchObject({ bestTime: '2024-10-14T17:00:00.000Z', magnitude: 6, observable: true });
    expect(night.maxAlt).toBeGreaterThan(11.4);
    expect(night.moonIllumination).toBeGreaterThan(80); // full Moon on 17 October 2024
    expect(night.moonVerdict).not.toBeNull();
  });

  it('is not observable under a floor above its height, and has no best hour in a window it misses', () => {
    expect(bodyNights(rows, [evening], PARIS, 30)[0].observable).toBe(false);
    const missed = bodyNights(rows, [{ start: new Date('2030-01-01T00:00:00Z'), end: new Date('2030-01-01T06:00:00Z') }], PARIS, 5)[0];
    expect(missed).toMatchObject({ maxAlt: null, bestTime: null, observable: false, moonVerdict: null });
  });

  it('says from when to when it is above the floor', () => {
    expect(aboveFloor(rows, evening, 5)).toEqual({ risesAt: '2024-10-14T17:00:00.000Z', setsAt: '2024-10-14T18:00:00.000Z' });
    expect(aboveFloor(rows, evening, 40)).toEqual({ risesAt: null, setsAt: null });
  });
});

describe('the list of comets and asteroids', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM smallBodyWatchlist').run();
    db.prepare("DELETE FROM libraryObjects WHERE objectId IN ('C2023A3', '12P_Pons-Brooks')").run();
  });

  it('reads what the user typed as a comet, an asteroid number or an asteroid name', () => {
    expect(parseSmallBodyInput('C/2023 A3 (Tsuchinshan-ATLAS)')).toMatchObject({ designation: 'C/2023 A3', kind: 'comet' });
    expect(parseSmallBodyInput('12P/Pons-Brooks')).toMatchObject({ designation: '12P', kind: 'comet' });
    expect(parseSmallBodyInput('(4) Vesta')).toMatchObject({ designation: '4', kind: 'asteroid', label: '(4) Vesta' });
    expect(parseSmallBodyInput('Ceres')).toMatchObject({ designation: 'Ceres', kind: 'asteroid' });
    expect(() => parseSmallBodyInput('  ')).toThrow(SmallBodyInputError);
    expect(() => parseSmallBodyInput('NGC 7000; DROP')).toThrow(SmallBodyInputError);
  });

  it('adds once, removes, and caps the list', () => {
    addToWatchlist('C/2023 A3');
    addToWatchlist('c2023a3');
    expect(listSmallBodies().filter(b => b.source === 'watchlist')).toHaveLength(1);
    expect(removeFromWatchlist('comet', 'C/2023 A3')).toBe(true);
    expect(removeFromWatchlist('comet', 'C/2023 A3')).toBe(false);
    for (let i = 1; i <= MAX_WATCHLIST; i++) addToWatchlist(String(i));
    expect(() => addToWatchlist('Vesta')).toThrow(SmallBodyInputError);
  });

  it("includes the library's comets, linked to their object, once", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO libraryObjects (objectId, folderName, lastImport, objectType) VALUES ('C2023A3', 'C2023A3', ?, 'Comet')`).run(now);
    db.prepare(`INSERT INTO libraryObjects (objectId, folderName, lastImport) VALUES ('12P_Pons-Brooks', '12P_Pons-Brooks', ?)`).run(now);
    addToWatchlist('12P');
    const bodies = listSmallBodies();
    expect(bodies.find(b => b.designation === '12P')).toMatchObject({ source: 'watchlist', libraryObjectId: '12P_Pons-Brooks' });
    expect(bodies.find(b => b.designation === 'C/2023 A3')).toMatchObject({ source: 'library', libraryObjectId: 'C2023A3', kind: 'comet' });
    expect(bodies.filter(b => b.designation === '12P')).toHaveLength(1);
  });
});

describe('GET /planner/comets', () => {
  let server: http.Server;
  let base: string;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const { apiEnvelope } = await import('../../server/middleware/apiEnvelope');
    const { plannerRouter } = await import('../../server/routes/planner');
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use('/planner', plannerRouter);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    updateSettingsData({ cometEphemerides: false });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => {
    _resetHorizonsForTests();
    db.prepare('DELETE FROM ephemerisCache').run();
    db.prepare('DELETE FROM smallBodyWatchlist').run();
    db.prepare("DELETE FROM libraryObjects WHERE objectId IN ('C2023A3', '12P_Pons-Brooks')").run();
    addToWatchlist('C/2023 A3');
    addToWatchlist('C/2099 Y9');
  });

  /** Horizons answers from the recordings; every other request goes out as usual (to this test server). */
  function mockHorizons() {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://ssd.jpl.nasa.gov/')) return realFetch(input, init);
      calls.push(url);
      const body = url.includes('2099') ? NOPE : A3;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return calls;
  }

  const get = async (query: string) => (await realFetch(`${base}/planner/comets?${query}`)).json();

  it('asks nothing while the setting is off, and lists the bodies', async () => {
    updateSettingsData({ cometEphemerides: false });
    const calls = mockHorizons();
    const body = await get('lat=48.85&lon=2.35&date=2024-10-14');
    expect(body.data.enabled).toBe(false);
    expect(body.data.bodies.map((b: { status: string }) => b.status)).toEqual(['idle', 'idle']);
    expect(calls).toHaveLength(0);
  });

  it("gives tonight's target, the next nights, and says which body Horizons does not know", async () => {
    updateSettingsData({ cometEphemerides: true });
    const calls = mockHorizons();
    // In astronomical dark that evening the comet was already within 2° of the horizon: a floor of 1° keeps it.
    const body = await get('lat=48.85&lon=2.35&date=2024-10-14&minAlt=1');
    expect(body.data.enabled).toBe(true);
    const [a3, nope] = body.data.bodies;
    expect(nope).toMatchObject({ status: 'not-found', target: null });
    expect(a3.status).toBe('ok');
    expect(a3.target).toMatchObject({ id: 'C/2023 A3', type: 'Comet', majorAxisArcmin: null, magnitude: 6 });
    expect(a3.target.maxAlt).toBeGreaterThan(1);
    expect(a3.nights.length).toBeGreaterThan(0);
    expect(a3.tonight.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    // Asked again: kept, no new request for the known comet.
    await get('lat=48.85&lon=2.35&date=2024-10-14&minAlt=1');
    expect(calls.filter(u => u.includes('2023'))).toHaveLength(1);
  });
});
