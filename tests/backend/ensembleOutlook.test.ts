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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-ensemble-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import {
  computeOutlook,
  ensembleUrl,
  parseEnsemble,
  _clearEnsembleCache,
  type EnsembleData,
} from '../../server/lib/ensembleOutlook';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { forecastRouter } from '../../server/routes/forecast';

const SITE = { lat: 45.66, lon: 6.3, timeZone: 'Europe/Paris' };
const NOW = new Date('2026-10-31T15:00:00Z'); // 16:00 in Paris, the night of the 31st
const START = Date.parse('2026-10-31T00:00:00Z');
const HOURS = 16 * 24;
const times = Array.from({ length: HOURS }, (_, i) => START + i * 3_600_000);

/** Open-Meteo-shaped JSON: several models, keys suffixed with the model id. */
function multiModelJson(member: (model: string, m: number, i: number) => number | null) {
  const hourly: Record<string, unknown> = { time: times.map(t => t / 1000) };
  for (const [model, count] of [['ecmwf_ifs025_ensemble', 4], ['gem_global_ensemble', 2], ['ncep_gefs_seamless', 2]] as const) {
    for (let m = 0; m < count; m++) {
      const key = m === 0 ? `cloud_cover_${model}` : `cloud_cover_member${String(m).padStart(2, '0')}_${model}`;
      hourly[key] = times.map((_, i) => member(model, m, i));
    }
  }
  return { latitude: 45.66, longitude: 6.3, hourly };
}

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('parseEnsemble', () => {
  it('reads members from a multi-model response', () => {
    const data = parseEnsemble(multiModelJson(() => 10));
    expect(data.times[0]).toBe(START);
    expect(data.members.map(m => `${m.model}#${m.member}`)).toEqual([
      'ecmwf_ifs025_ensemble#0', 'ecmwf_ifs025_ensemble#1', 'ecmwf_ifs025_ensemble#2', 'ecmwf_ifs025_ensemble#3',
      'gem_global_ensemble#0', 'gem_global_ensemble#1', 'ncep_gefs_seamless#0', 'ncep_gefs_seamless#1',
    ]);
  });

  it('reads a single-model response, ISO times, and ignores what it does not know', () => {
    const data = parseEnsemble({
      hourly: {
        time: ['2026-10-31T00:00', '2026-10-31T01:00'],
        cloud_cover: [5, null],
        cloud_cover_member01: [50, 60],
        cloud_cover_member01_some_other_model: [1, 1],
        temperature_2m: [3, 4],
      },
    }, 'ncep_gefs_seamless');
    expect(data.times).toEqual([START, START + 3_600_000]);
    expect(data.members).toEqual([
      { model: 'ncep_gefs_seamless', member: 0, values: [5, null] },
      { model: 'ncep_gefs_seamless', member: 1, values: [50, 60] },
    ]);
    expect(() => parseEnsemble({})).toThrow();
  });

  it('asks for the three long-range ensembles over 16 days, in UTC unix time', () => {
    const url = new URL(ensembleUrl(45.66, 6.3));
    expect(url.host).toBe('ensemble-api.open-meteo.com');
    expect(url.searchParams.get('models')).toBe('ecmwf_ifs025_ensemble,gem_global_ensemble,ncep_gefs_seamless');
    expect(url.searchParams.get('forecast_days')).toBe('16');
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
  });
});

describe('computeOutlook', () => {
  it('gives the share of runs with a clear night, per night and per model', () => {
    // ECMWF clear, GEM and GFS overcast.
    const data = parseEnsemble(multiModelJson(model => (model === 'ecmwf_ifs025_ensemble' ? 10 : 90)));
    const nights = computeOutlook(data, SITE, NOW);
    expect(nights).toHaveLength(15);
    expect(nights[0]!.date).toBe('2026-10-31');
    expect(nights[14]!.date).toBe('2026-11-14');
    const first = nights[0]!;
    expect(first).toMatchObject({ members: 8, clearMembers: 4, clearProbability: 0.5, cloudMedian: 50 });
    expect(first.darkHours).toBeGreaterThan(10); // a long autumn night in Savoie
    expect(first.models).toEqual([
      { model: 'ecmwf_ifs025_ensemble', label: 'ECMWF', members: 4, clearMembers: 4, clearProbability: 1 },
      { model: 'gem_global_ensemble', label: 'GEM', members: 2, clearMembers: 0, clearProbability: 0 },
      { model: 'ncep_gefs_seamless', label: 'GFS', members: 2, clearMembers: 0, clearProbability: 0 },
    ]);
  });

  it('needs enough clear hours, not just a clear moment', () => {
    // Clear for two hours after dusk, then overcast: under the 3 h minimum.
    const data: EnsembleData = {
      times,
      members: [{ model: 'ncep_gefs_seamless', member: 0, values: times.map(t => (t >= Date.parse('2026-10-31T18:00:00Z') && t < Date.parse('2026-10-31T20:00:00Z') ? 0 : 100)) }],
    };
    expect(computeOutlook(data, SITE, NOW, { maxCloudCover: 30, minClearHours: 3 })[0]!.clearProbability).toBe(0);
    expect(computeOutlook(data, SITE, NOW, { maxCloudCover: 30, minClearHours: 1.5 })[0]!.clearProbability).toBe(1);
  });

  it('leaves a model out of the nights it no longer covers', () => {
    // GEM stops after 5 days: those nights are judged on ECMWF and GFS only.
    const cutoff = START + 5 * 24 * 3_600_000;
    const data = parseEnsemble(multiModelJson((model, _m, i) => (model === 'gem_global_ensemble' && times[i]! >= cutoff ? null : 10)));
    const nights = computeOutlook(data, SITE, NOW);
    expect(nights[0]!.members).toBe(8);
    expect(nights[10]).toMatchObject({ members: 6, clearProbability: 1 });
    expect(nights[10]!.models.find(m => m.model === 'gem_global_ensemble')).toMatchObject({ members: 0, clearProbability: null });
  });

  it('says nothing about a night no run covers', () => {
    const data: EnsembleData = { times: times.slice(0, 48), members: [{ model: 'ncep_gefs_seamless', member: 0, values: Array(48).fill(0) }] };
    const nights = computeOutlook(data, SITE, NOW);
    expect(nights[5]).toMatchObject({ members: 0, clearProbability: null, cloudMedian: null });
  });
});

describe('GET /forecast/outlook', () => {
  let server: http.Server;
  let baseUrl: string;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    const app = express();
    app.use(apiEnvelope);
    app.use('/forecast', forecastRouter);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    _clearEnsembleCache();
    fetchMock.mockReset();
  });

  // The route itself calls the mocked fetch for Open-Meteo; the test talks to
  // the server through Node's http module so it is not intercepted.
  const get = (path: string) => new Promise<{ status: number; body: { data?: unknown; error?: unknown } }>((resolve, reject) => {
    http.get(`${baseUrl}${path}`, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    }).on('error', reject);
  });

  it('returns 15 nights for the coordinates, and fetches once per site', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(multiModelJson(() => 10)), { status: 200 }));
    const first = await get('/forecast/outlook?lat=45.66&lon=6.3');
    expect(first.status).toBe(200);
    const data = first.body.data as { nights: unknown[]; models: { members: number }[]; thresholds: unknown };
    expect(data.nights.length).toBeGreaterThanOrEqual(14);
    expect(data.models.map(m => m.members)).toEqual([4, 2, 2]);
    expect(data.thresholds).toEqual({ maxCloudCover: 30, minClearHours: 3 });
    await get('/forecast/outlook?lat=45.66&lon=6.3&maxCloudCover=50');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says so when the ensemble cannot be had, with Open-Meteo\'s reason, and checks coordinates', async () => {
    fetchMock.mockResolvedValue(new Response('busy', { status: 503 }));
    const failed = await get('/forecast/outlook?lat=45.66&lon=6.3');
    expect(failed.status).toBe(502);
    _clearEnsembleCache();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: true, reason: 'Model gfs05 is not supported' }), { status: 400 }));
    expect(JSON.stringify((await get('/forecast/outlook?lat=45.66&lon=6.3')).body)).toContain('Model gfs05 is not supported');
    expect((await get('/forecast/outlook?lat=95&lon=6.3')).status).toBe(400);
  });
});
