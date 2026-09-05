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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-forecastroute-test-'));
  _process.env.DATA_DIR = dir;
  return dir;
});

const buildForecastCalls = vi.hoisted(() => ({ n: 0, empty: false }));
vi.mock('../../server/lib/forecastCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/forecastCache')>();
  return {
    ...actual,
    buildForecast: async (lat: number, lon: number) => {
      buildForecastCalls.n++;
      if (buildForecastCalls.empty) {
        // Open-Meteo unreachable: no hourly data, no weather source.
        return { location: { lat, lon }, hourly: [], sources: { weather: null, seeing: null }, call: buildForecastCalls.n };
      }
      // A usable forecast (non-empty hourly + a weather source): the route only
      // caches these.
      return {
        location: { lat, lon },
        hourly: [{ time: '2026-01-15T20:00:00.000Z', cloudCover: 10 }],
        sources: { weather: 'open-meteo', seeing: null },
        call: buildForecastCalls.n,
      };
    },
  };
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { forecastRouter } from '../../server/routes/forecast';
import { _clearForecastCache } from '../../server/lib/forecastCache';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
  app.use('/forecast', forecastRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  buildForecastCalls.n = 0;
  buildForecastCalls.empty = false;
  _clearForecastCache();
});

describe('GET /forecast — refresh throttling (FC-1)', () => {
  it('collapses a burst of ?refresh=1 into a single upstream fetch', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/forecast?lat=40&lon=-105&refresh=1`);
      expect(res.status).toBe(200);
    }
    // First is a genuine cache miss; the next four are ignored because the
    // entry is only seconds old.
    expect(buildForecastCalls.n).toBe(1);
  });

  it('serves different sites from their own cache entries', async () => {
    await fetch(`${baseUrl}/forecast?lat=40&lon=-105`);
    await fetch(`${baseUrl}/forecast?lat=51.5&lon=-0.12`);
    await fetch(`${baseUrl}/forecast?lat=40&lon=-105`); // cache hit, no refetch
    expect(buildForecastCalls.n).toBe(2);
  });
});

describe('GET /forecast — empty upstream result is not cached', () => {
  it('re-fetches on the next request instead of pinning an empty forecast', async () => {
    buildForecastCalls.empty = true;
    const first = await (await fetch(`${baseUrl}/forecast?lat=40&lon=-105`)).json();
    expect(first.data.hourly).toEqual([]);

    // A normal follow-up request must re-run buildForecast, not serve the empty
    // entry from cache.
    buildForecastCalls.empty = false;
    const second = await (await fetch(`${baseUrl}/forecast?lat=40&lon=-105`)).json();
    expect(buildForecastCalls.n).toBe(2);
    expect(second.data.hourly.length).toBe(1);
  });

  it('honours ?refresh=1 immediately when the cached entry is empty', async () => {
    buildForecastCalls.empty = true;
    await fetch(`${baseUrl}/forecast?lat=40&lon=-105`);

    // Entry is only seconds old, so REFRESH_MIN_AGE_MS would normally block
    // this — but an unusable entry is refreshed regardless of age.
    buildForecastCalls.empty = false;
    const res = await (await fetch(`${baseUrl}/forecast?lat=40&lon=-105&refresh=1`)).json();
    expect(buildForecastCalls.n).toBe(2);
    expect(res.data.hourly.length).toBe(1);
  });
});
