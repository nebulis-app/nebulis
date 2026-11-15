import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-explore-test-'));
  _process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { exploreRouter } from '../../server/routes/explore';
import { getPlannerCatalog, getById, designationsFor } from '../../server/lib/dsoCatalog';
import { categoryOf, EXPLORE_CATEGORY_IDS } from '../../server/lib/explore/categories';
import { showpieceScore, SHOWPIECE_BOOSTS, isShowpiece } from '../../server/lib/explore/showpiece';
import { everVisible } from '../../server/lib/explore/visibility';
import { tonightRank } from '../../server/lib/explore/rank';

let server: http.Server;
let baseUrl: string;

// A mid-northern site (Denver-ish) and a mid-southern one, supplied as a
// transient override so no stored site is needed.
const NORTH = 'lat=40&lon=-105';
const SOUTH = 'lat=-35&lon=150';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
  app.use('/', exploreRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

interface Row {
  id: string;
  constellation: string | null;
  showpiece: number;
  isInWishlist: boolean;
  isImaged: boolean;
  visibility: { kind: string } | null;
  majorAxisArcmin: number | null;
  fit: { tag: string } | null;
}
interface Night { date: string; score: number; isBest: boolean; moonVerdict: string }
interface Payload {
  locationSet: boolean;
  total: number;
  results: Row[];
  constellation: { name: string; count: number } | null;
  categories: Array<{ id: string; total: number; visibleHere: number; goodTonight: number }>;
  nights: Night[];
}

async function get(path: string) {
  const r = await fetch(`${baseUrl}${path}`);
  const body = await r.json() as { data: Payload };
  return { status: r.status, data: body.data };
}

describe('showpiece ranking', () => {
  it('resolves every hand-picked id to a catalog object', () => {
    const missing = SHOWPIECE_BOOSTS.filter(id => !getById(id));
    expect(missing).toEqual([]);
  });

  it('puts the classic galaxies at the top of the galaxy list', () => {
    const top = getPlannerCatalog()
      .filter(e => categoryOf(e) === 'galaxies')
      .sort((a, b) => showpieceScore(b) - showpieceScore(a))
      .slice(0, 20)
      .map(e => e.id);
    for (const id of ['M31', 'M33', 'M51', 'M81', 'M101', 'M82']) expect(top).toContain(id);
  });

  it('keeps obscure faint galaxies out of the top 50', () => {
    const top = getPlannerCatalog()
      .filter(e => categoryOf(e) === 'galaxies')
      .sort((a, b) => showpieceScore(b) - showpieceScore(a))
      .slice(0, 50);
    // Nothing in the top 50 is both faint (>12.5) and tiny (<2').
    expect(top.filter(e => (e.magnitude ?? 0) > 12.5 && (e.majorAxisArcmin ?? 99) < 2)).toEqual([]);
  });

  it('keeps the Showpieces tile a short, hand-picked list', () => {
    const n = getPlannerCatalog().filter(isShowpiece).length;
    expect(n).toBeGreaterThan(40);
    expect(n).toBeLessThan(100);
  });
});

describe('Showpieces cover both hemispheres', () => {
  const all = getPlannerCatalog().filter(isShowpiece);

  it('lists about as many well-placed southern objects as northern ones', () => {
    const south = all.filter(e => e.dec < -20).length;
    const north = all.filter(e => e.dec > 20).length;
    expect(south).toBeGreaterThanOrEqual(30);
    expect(north).toBeGreaterThanOrEqual(30);
    // Neither side may dominate: the old list was 41 north to 10 south.
    expect(Math.abs(north - south)).toBeLessThanOrEqual(8);
  });

  it('gives a southern observer nearly as many showpieces as a northern one', () => {
    const visibleFrom = (lat: number) => all.filter(e => everVisible(e, { siteKey: 'x', lat, lon: 0, minAlt: 20 })).length;
    const sydney = visibleFrom(-33.87), newYork = visibleFrom(40.71);
    expect(sydney).toBeGreaterThanOrEqual(60);
    expect(Math.abs(sydney - newYork)).toBeLessThanOrEqual(10);
  });

  it('includes the southern classics people expect', () => {
    const ids = new Set(all.map(e => e.id));
    for (const id of ['NGC3372', 'NGC5139', 'NGC104', 'NGC292', 'ESO56-115', 'M83', 'NGC5128', 'NGC4755', 'NGC2070']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('puts the southern classics near the top of their categories', () => {
    const top = (cat: string, n: number) => getPlannerCatalog().filter(e => categoryOf(e) === cat).sort((a, b) => showpieceScore(b) - showpieceScore(a)).slice(0, n).map(e => e.id);
    expect(top('clusters', 25)).toEqual(expect.arrayContaining(['NGC5139', 'NGC104']));
    expect(top('emission-nebulae', 25)).toContain('NGC3372');
  });
});

describe('categories', () => {
  it('assigns the well-known objects to the expected bucket', () => {
    const cat = (id: string) => categoryOf(getById(id)!);
    expect(cat('M31')).toBe('galaxies');
    expect(cat('M42')).toBe('emission-nebulae');
    expect(cat('M57')).toBe('planetary-nebulae');
    expect(cat('M1')).toBe('supernova-remnants');
    expect(cat('M13')).toBe('clusters');
    expect(cat('M45')).toBe('clusters');
  });
});

describe('GET /categories', () => {
  it('counts every tile and shrinks "visible here" for a northern site', async () => {
    const { status, data } = await get(`/categories?${NORTH}`);
    expect(status).toBe(200);
    expect(data.locationSet).toBe(true);
    expect(data.categories.map((c) => c.id)).toEqual([...EXPLORE_CATEGORY_IDS]);
    const galaxies = data.categories.find((c) => c.id === 'galaxies');
    expect(galaxies.total).toBeGreaterThan(1000);
    expect(galaxies.visibleHere).toBeLessThan(galaxies.total);
    expect(galaxies.visibleHere).toBeGreaterThan(0);
    expect(galaxies.goodTonight).toBeLessThanOrEqual(galaxies.visibleHere);
  });

  it('reports the same totals but different visibility for a southern site', async () => {
    const n = (await get(`/categories?${NORTH}`)).data.categories.find((c) => c.id === 'galaxies');
    const s = (await get(`/categories?${SOUTH}`)).data.categories.find((c) => c.id === 'galaxies');
    expect(s.total).toBe(n.total);
    expect(s.visibleHere).not.toBe(n.visibleHere);
  });
});

describe('GET /browse sort=number', () => {
  const numbers = async (catalog: string, re: RegExp) => {
    const out: number[] = [];
    for (let offset = 0; offset < 400; offset += 100) {
      const { data } = await get(`/browse?catalog=${catalog}&sort=number&visibility=all&limit=100&offset=${offset}`);
      for (const r of data.results) {
        const entry = getById(r.id)!;
        const hit = [entry.id, ...designationsFor(entry)].map(d => re.exec(d)).find(Boolean);
        out.push(hit ? Number(hit[1]) : Infinity);
      }
      if (data.results.length < 100) break;
    }
    return out;
  };

  it('lists a catalog in its own numbering, not by name', async () => {
    const m = await numbers('messier', /^M(\d+)$/i);
    expect(m).toHaveLength(110);
    expect(m).toEqual(Array.from({ length: 110 }, (_, i) => i + 1));
    const c = await numbers('caldwell', /^C(\d+)$/i);
    expect(c).toEqual(Array.from({ length: 109 }, (_, i) => i + 1));
  });

  it('numbers IC objects by their IC number, even where another catalog owns the id', async () => {
    // A letter suffix (IC 5250A, IC 5250B) belongs to the same number, so it sorts right after it.
    const ic = await numbers('ic', /^IC(\d+)[A-Z]?$/i);
    expect(ic.length).toBeGreaterThan(100);
    expect([...ic].sort((a, b) => a - b)).toEqual(ic);
    expect(ic.every(Number.isFinite)).toBe(true);
  });

  it('is not the same order as sort=name', async () => {
    const byNumber = (await get('/browse?catalog=messier&sort=number&visibility=all&limit=4')).data.results.map(r => r.id);
    const byName = (await get('/browse?catalog=messier&sort=name&visibility=all&limit=4')).data.results.map(r => r.id);
    expect(byNumber).toEqual(['M1', 'M2', 'M3', 'M4']);
    expect(byName).not.toEqual(byNumber);
  });

  it('still answers without a catalog, in the order of the ids\' own numbers', async () => {
    const { status, data } = await get('/browse?sort=number&visibility=all&limit=5');
    expect(status).toBe(200);
    expect(data.results.length).toBe(5);
  });
});

describe('GET /categories catalogs', () => {
  it('counts each catalog the same way the catalog filter lists it', async () => {
    const raw = await (await fetch(`${baseUrl}/categories?${NORTH}`)).json() as { data: { catalogs: Array<{ id: string; total: number; visibleHere: number; goodTonight: number }> } };
    const catalogs = raw.data.catalogs;
    expect(catalogs.map(c => c.id)).toEqual(['messier', 'ngc', 'ic', 'caldwell', 'sharpless']);
    for (const c of catalogs) {
      expect(c.visibleHere).toBeLessThanOrEqual(c.total);
      expect(c.goodTonight).toBeLessThanOrEqual(c.visibleHere);
      const listed = (await get(`/browse?catalog=${c.id}&visibility=all&limit=1`)).data.total;
      expect(c.total, c.id).toBe(listed);
    }
    expect(catalogs.find(c => c.id === 'messier')!.total).toBe(110);
  });
});

describe('GET /browse', () => {
  it('lists the best galaxies first and only ones visible from here', async () => {
    const { data } = await get(`/browse?category=galaxies&limit=20&${NORTH}`);
    const ids = data.results.map((r) => r.id);
    expect(ids).toContain('M31');
    expect(ids.slice(0, 10)).toContain('M51');
    for (const row of data.results) {
      expect(row.visibility).not.toBeNull();
      expect(row.visibility.kind).not.toBe('never');
    }
    // Ranked by showpiece score, descending.
    const scores = data.results.map((r) => r.showpiece);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
  });

  it('pages without repeating objects', async () => {
    const a = (await get(`/browse?category=clusters&limit=10&offset=0&${NORTH}`)).data;
    const b = (await get(`/browse?category=clusters&limit=10&offset=10&${NORTH}`)).data;
    const seen = new Set(a.results.map((r) => r.id));
    expect(b.results.some((r) => seen.has(r.id))).toBe(false);
    expect(a.total).toBe(b.total);
  });

  it('drops objects that never rise when visibility=here, keeps them for all', async () => {
    const here = (await get(`/browse?category=galaxies&limit=1&visibility=here&${NORTH}`)).data.total;
    const all = (await get(`/browse?category=galaxies&limit=1&visibility=all&${NORTH}`)).data.total;
    expect(all).toBeGreaterThan(here);
  });

  it('tonight filter returns only objects that are up tonight', async () => {
    const { data } = await get(`/browse?category=all&visibility=tonight&sort=tonight&limit=15&${NORTH}`);
    expect(data.results.length).toBeGreaterThan(0);
    for (const row of data.results) expect(row.visibility.kind).toBe('tonight');
  });

  it('filters by constellation, case-insensitively', async () => {
    const { data } = await get(`/browse?constellation=orion&visibility=all&limit=50&${NORTH}`);
    expect(data.results.length).toBeGreaterThan(0);
    for (const row of data.results) expect((row.constellation ?? '').toLowerCase()).toBe('orion');
  });

  it('rejects an unknown category and bad paging', async () => {
    expect((await get('/browse?category=nope')).status).toBe(422);
    expect((await get('/browse?limit=0')).status).toBe(422);
  });

  it('works with no location: rows have no visibility and nothing is filtered out', async () => {
    const { data } = await get('/browse?category=galaxies&visibility=all&limit=5');
    // The test DB has no site coordinates.
    if (!data.locationSet) {
      for (const row of data.results) expect(row.visibility).toBeNull();
    }
    expect(data.results.length).toBe(5);
  });
});

describe('GET /browse?catalog=', () => {
  const ids = async (query: string) => (await get(`/browse?visibility=all&limit=100&${query}`)).data.results.map((r) => r.id);

  it('lists only IC objects for catalog=ic, and IC405 is one of them', async () => {
    const { data } = await get('/browse?catalog=ic&visibility=all&limit=100&sort=bright');
    expect(data.total).toBeGreaterThan(100);
    expect(data.results.length).toBeGreaterThan(0);
    // By designation, not storage id: M24 is stored as M24 and is also IC 4715, so it belongs here too.
    for (const row of data.results) {
      const entry = getById(row.id)!;
      expect([entry.id, ...designationsFor(entry)].some(d => /^IC\d/i.test(d)), row.id).toBe(true);
    }
    const flaming = await ids('catalog=ic&q=flaming+star');
    expect(flaming).toContain('IC405');
  });

  it('matches any designation, not just the storage id', async () => {
    // IC405 is stored under an IC id yet is Caldwell 31 and Sharpless 229; M31 is stored as M31 yet is NGC 224.
    expect(await ids('catalog=caldwell&q=IC405')).toContain('IC405');
    expect(await ids('catalog=sharpless&q=IC405')).toContain('IC405');
    expect(await ids('catalog=ngc&q=M31')).toContain('M31');
    expect(await ids('catalog=messier&q=M31')).toContain('M31');
  });

  it('keeps an object out of a catalog it is not in', async () => {
    expect(await ids('catalog=ic&q=M31')).not.toContain('M31');
    expect(await ids('catalog=messier&q=IC405')).not.toContain('IC405');
  });

  it('counts every Messier and Caldwell object', async () => {
    expect((await get('/browse?catalog=messier&visibility=all&limit=1')).data.total).toBe(110);
    expect((await get('/browse?catalog=caldwell&visibility=all&limit=1')).data.total).toBe(109);
  });

  it('combines with the other filters', async () => {
    const all = (await get(`/browse?catalog=ic&visibility=all&limit=1&${NORTH}`)).data.total;
    const here = (await get(`/browse?catalog=ic&visibility=here&limit=1&${NORTH}`)).data.total;
    expect(here).toBeLessThanOrEqual(all);
    const nebulae = (await get('/browse?catalog=ic&category=emission-nebulae&visibility=all&limit=1')).data.total;
    expect(nebulae).toBeGreaterThan(0);
    expect(nebulae).toBeLessThan((await get('/browse?catalog=ic&visibility=all&limit=1')).data.total);
  });

  it('changes nothing when no catalog is asked for, and rejects an unknown one', async () => {
    const plain = (await get('/browse?visibility=all&limit=1')).data.total;
    const star = (await get('/browse?catalog=ngc&visibility=all&limit=1')).data.total;
    expect(star).toBeLessThan(plain);
    expect((await get('/browse?catalog=nope')).status).toBe(422);
  });
});

describe('Fits my scope', () => {
  // A small smart scope: about 1.3 x 0.7 degrees.
  const FOV = 'fovW=1.3&fovH=0.7';

  it('marks each row with how it sits in the frame, and nothing without a field of view', async () => {
    const withFov = (await get(`/browse?category=galaxies&limit=40&${NORTH}&${FOV}`)).data.results;
    expect(withFov.every(r => r.majorAxisArcmin == null || r.fit !== null)).toBe(true);
    const m31 = withFov.find(r => r.id === 'M31');
    expect(m31?.fit?.tag).toBe('mosaic');
    const without = (await get(`/browse?category=galaxies&limit=5&${NORTH}`)).data.results;
    expect(without.every(r => r.fit === null)).toBe(true);
  });

  it('drops mosaic targets and specks, keeping only what one frame holds', async () => {
    const all = (await get(`/browse?category=galaxies&limit=1&${NORTH}&${FOV}`)).data.total;
    const { data } = await get(`/browse?category=galaxies&fitsScope=1&limit=100&${NORTH}&${FOV}`);
    expect(data.total).toBeLessThan(all);
    expect(data.results.length).toBeGreaterThan(0);
    for (const row of data.results) expect(['fits', 'tight']).toContain(row.fit?.tag);
    expect(data.results.map(r => r.id)).not.toContain('M31');
    expect(data.results.map(r => r.id)).toContain('M51');
  });

  it('ignores the filter when no field of view was sent', async () => {
    const a = (await get(`/browse?category=galaxies&limit=1&${NORTH}`)).data.total;
    const b = (await get(`/browse?category=galaxies&fitsScope=1&limit=1&${NORTH}`)).data.total;
    expect(b).toBe(a);
  });
});

describe('GET /search', () => {
  const first = async (q: string) => (await get(`/search?q=${encodeURIComponent(q)}&${NORTH}`)).data.results[0]?.id;

  it.each([
    ['M42', 'M42'],
    ['Messier 42', 'M42'],
    ['NGC 7000', 'NGC7000'],
    ['ngc7000', 'NGC7000'],
    ['Pelican', 'IC5070'],
    ['Andromeda', 'M31'],
    ['Whirlpool', 'M51'],
    ['C14', 'NGC869'],
    ['Caldwell 14', 'NGC869'],
  ])('finds %s -> %s', async (q, id) => {
    expect(await first(q)).toBe(id);
  });

  it('caps results at the limit and reports the full total', async () => {
    const { data } = await get(`/search?q=ngc&limit=5&${NORTH}`);
    expect(data.results.length).toBe(5);
    expect(data.total).toBeGreaterThan(5);
  });

  it('returns a constellation hint for a constellation name', async () => {
    const { data } = await get(`/search?q=Cygnus&${NORTH}`);
    expect(data.constellation?.name.toLowerCase()).toBe('cygnus');
    expect(data.constellation.count).toBeGreaterThan(10);
  });

  it('marks wishlist and library state on rows', async () => {
    const { data } = await get(`/search?q=M31&${NORTH}`);
    expect(data.results[0]).toMatchObject({ isInWishlist: false, isImaged: false });
  });

  it('422s on an empty query', async () => {
    expect((await get('/search?q=')).status).toBe(422);
  });
});

describe('GET /best-tonight', () => {
  it('returns rewarding targets that are up tonight', async () => {
    const { data } = await get(`/best-tonight?limit=10&${NORTH}`);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.length).toBeLessThanOrEqual(10);
    for (const row of data.results) {
      expect(row.visibility.kind).toBe('tonight');
      expect(row.showpiece).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('Best tonight is one definition everywhere', () => {
  it('orders the rail, the tonight sort and the planner payload the same way', async () => {
    const rail = (await get(`/best-tonight?limit=12&${NORTH}`)).data.results.map(r => r.id);
    const sorted = (await get(`/browse?visibility=tonight&sort=tonight&limit=100&${NORTH}`)).data.results.map(r => r.id);
    // The rail is the sorted list with the unremarkable tail cut, so each rail item keeps its relative order.
    const inSorted = rail.map(id => sorted.indexOf(id));
    expect(inSorted.every(i => i >= 0)).toBe(true);
    expect([...inSorted].sort((a, b) => a - b)).toEqual(inSorted);
  });

  it('exposes the blend on the planner payload: worth + conditions, weighted the same', () => {
    expect(tonightRank(1, 100)).toBeCloseTo(1, 10);
    expect(tonightRank(0, 0)).toBe(0);
    expect(tonightRank(0.5, 50)).toBeCloseTo(0.5 * 0.55 + 0.5 * 0.45, 10);
    // Worth is capped, so a hand-picked object can't outweigh conditions on its own.
    expect(tonightRank(0, 500)).toBeCloseTo(0.45, 10);
  });

  it('answers for another night when asked, and rejects a bad date', async () => {
    const tonight = (await get(`/browse?visibility=tonight&sort=tonight&limit=40&${NORTH}`)).data;
    const winter = (await get(`/browse?visibility=tonight&sort=tonight&limit=40&date=2027-01-15&${NORTH}`)).data;
    expect(winter.total).toBeGreaterThan(0);
    expect(winter.total).not.toBe(tonight.total);
    expect((await get(`/categories?date=2027-02-30&${NORTH}`)).status).toBe(422);
  });
});

describe('GET /next-good-nights/:id', () => {
  it('ranks upcoming nights and flags the best three', async () => {
    const { data } = await get(`/next-good-nights/M31?days=30&${NORTH}`);
    expect(data.locationSet).toBe(true);
    expect(data.nights.length).toBeGreaterThan(0);
    expect(data.nights.filter((n) => n.isBest).length).toBeLessThanOrEqual(3);
    const dates = data.nights.map((n) => n.date);
    expect([...dates].sort()).toEqual(dates);
    for (const n of data.nights) {
      expect(n.score).toBeGreaterThanOrEqual(0);
      expect(n.score).toBeLessThanOrEqual(1);
      expect(['ok', 'caution', 'warning']).toContain(n.moonVerdict);
    }
  });

  it('is empty for an object that never rises here, and 404s for an unknown id', async () => {
    const south = getPlannerCatalog().find(e => e.dec < -70 && !everVisible(e, { siteKey: 'x', lat: 40, lon: -105, minAlt: 20 }));
    expect(south).toBeDefined();
    const { data } = await get(`/next-good-nights/${encodeURIComponent(south!.id)}?${NORTH}`);
    expect(data.nights).toEqual([]);
    expect((await get('/next-good-nights/NOPE99999')).status).toBe(404);
  });
});
