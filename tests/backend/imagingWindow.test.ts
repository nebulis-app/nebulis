import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-imagingwindow-test-'));
  _process.env.DATA_DIR = dir;
  return dir;
});

// Tonight's twilight for the forecast stub: astronomical 19:02 → 05:38, nautical 18:27 → 06:13 (UTC, any day).
const TWILIGHT = {
  astronomicalTwilightEnd: '2026-11-03T18:02:00.000Z',
  astronomicalTwilightStart: '2026-11-04T04:38:00.000Z',
  nauticalTwilightEnd: '2026-11-03T17:27:00.000Z',
  nauticalTwilightStart: '2026-11-04T05:13:00.000Z',
};
vi.mock('../../server/lib/forecastCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/forecastCache')>();
  return {
    ...actual,
    buildForecast: async (lat: number, lon: number) => ({
      location: { lat, lon },
      hourly: [{ time: '2026-11-03T20:00:00.000Z', cloudCover: 10 }],
      tonight: { ...TWILIGHT },
      sources: { weather: 'open-meteo', seeing: null },
    }),
  };
});

import fs from 'fs';
import { resolveWindow, resolveWindowFromIso, windowPrefsOf } from '../../server/lib/imagingWindow';
import { createSite, getSite, updateSite } from '../../server/lib/observingSites';
import { darkWindow } from '../../server/lib/alerts/clearNight';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { forecastRouter } from '../../server/routes/forecast';
import { sitesRouter } from '../../server/routes/sites';

const d = (s: string) => new Date(s);
const NIGHT = {
  astronomicalDusk: d(TWILIGHT.astronomicalTwilightEnd), astronomicalDawn: d(TWILIGHT.astronomicalTwilightStart),
  nauticalDusk: d(TWILIGHT.nauticalTwilightEnd), nauticalDawn: d(TWILIGHT.nauticalTwilightStart),
};

describe('resolveWindow', () => {
  it('is the astronomical night by default', () => {
    expect(resolveWindow(NIGHT)).toEqual({ start: NIGHT.astronomicalDusk, end: NIGHT.astronomicalDawn, darkness: 'astronomical' });
  });

  it('starts from the nautical night when asked, and moves either end by the offsets', () => {
    const w = resolveWindow(NIGHT, { darkness: 'nautical', startOffsetMin: 30, endOffsetMin: 60 })!;
    expect(w.darkness).toBe('nautical');
    expect(w.start.toISOString()).toBe('2026-11-03T17:57:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-04T04:13:00.000Z');
    // A negative offset moves the end the other way: past dawn.
    expect(resolveWindow(NIGHT, { darkness: 'astronomical', startOffsetMin: -15, endOffsetMin: -30 })!.end.toISOString())
      .toBe('2026-11-04T05:08:00.000Z');
  });

  it('falls back to nautical where it never gets astronomically dark, and gives nothing when the offsets leave nothing', () => {
    const summer = { ...NIGHT, astronomicalDusk: null, astronomicalDawn: null };
    expect(resolveWindow(summer)!.darkness).toBe('nautical');
    expect(resolveWindow(NIGHT, { darkness: 'astronomical', startOffsetMin: 360, endOffsetMin: 360 })).toBeNull();
  });

  it('reads the forecast\'s ISO times and a site\'s stored settings, defaulting what is missing or out of range', () => {
    expect(resolveWindowFromIso(TWILIGHT)!.start.toISOString()).toBe(TWILIGHT.astronomicalTwilightEnd);
    expect(windowPrefsOf({ darkness: 'civil', windowStartOffsetMin: 9999, windowEndOffsetMin: 'x' }))
      .toEqual({ darkness: 'astronomical', startOffsetMin: 360, endOffsetMin: 0 });
  });
});

describe('a site\'s window settings', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
    app.use('/forecast', forecastRouter);
    app.use('/sites', sitesRouter);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('are stored, default to the astronomical night, and are refused out of range', async () => {
    const site = createSite({ name: 'Garden', latitude: 45.65, longitude: 6.32, timezone: 'Europe/Paris' });
    expect(site).toMatchObject({ darkness: 'astronomical', windowStartOffsetMin: 0, windowEndOffsetMin: 0 });
    const put = await fetch(`${baseUrl}/sites/${site.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ darkness: 'nautical', windowStartOffsetMin: 30, windowEndOffsetMin: 60 }),
    });
    expect(put.status).toBe(200);
    expect(getSite(site.id)).toMatchObject({ darkness: 'nautical', windowStartOffsetMin: 30, windowEndOffsetMin: 60 });
    const bad = await fetch(`${baseUrl}/sites/${site.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ darkness: 'civil', windowStartOffsetMin: 1000 }),
    });
    expect(bad.status).toBe(422);
  });

  it('shape tonight\'s window in the forecast, per site, and in the clear-night alert', async () => {
    const plain = createSite({ name: 'Plain', latitude: 45.65, longitude: 6.32, timezone: 'Europe/Paris' });
    const narrow = createSite({ name: 'Narrowband', latitude: 45.65, longitude: 6.32, timezone: 'Europe/Paris' });
    updateSite(narrow.id, { darkness: 'nautical', windowStartOffsetMin: 30, windowEndOffsetMin: 60 });

    const get = async (id: string) => ((await (await fetch(`${baseUrl}/forecast?siteId=${id}`)).json()) as { data: { tonight: { imagingWindow: unknown } } }).data.tonight.imagingWindow;
    expect(await get(plain.id)).toEqual({ start: TWILIGHT.astronomicalTwilightEnd, end: TWILIGHT.astronomicalTwilightStart, darkness: 'astronomical', startOffsetMin: 0, endOffsetMin: 0 });
    // Same grid cell, so the second request is served from the cache: the window is still the site's own.
    expect(await get(narrow.id)).toEqual({ start: '2026-11-03T17:57:00.000Z', end: '2026-11-04T04:13:00.000Z', darkness: 'nautical', startOffsetMin: 30, endOffsetMin: 60 });

    const night = '2026-11-03';
    const base = darkWindow(night, 45.65, 6.32, 'Europe/Paris')!;
    const moved = darkWindow(night, 45.65, 6.32, 'Europe/Paris', windowPrefsOf(getSite(narrow.id)))!;
    // Nautical starts about 35 minutes before astronomical here; 30 more minutes later, so it opens about 5 minutes earlier.
    expect((base.start.getTime() - moved.start.getTime()) / 60_000).toBeGreaterThan(0);
    expect((base.start.getTime() - moved.start.getTime()) / 60_000).toBeLessThan(15);
    expect(moved.end.getTime()).toBeLessThan(base.end.getTime());
  });
});
