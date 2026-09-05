import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads (mirrors routeDecoding.test.ts).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-plannerroutes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { plannerRouter } from '../../server/routes/planner';

// POST /planner/plan is called by both the web client (TS/JSON, which always
// sends an explicit `null` for an absent optional field) and the iOS client
// (Swift's JSONEncoder, which omits a nil optional property from the JSON
// entirely instead of sending null). A request body that only satisfies one
// of those two encodings is exactly the bug this file guards against: it
// shipped once already (magnitude/majorAxisArcmin/constellation were
// `.nullable()` without `.optional()`), and broke "Plan My Night" for any
// iOS target missing one of those fields.

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use('/planner', plannerRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function planRequestBody(target: Record<string, unknown>) {
  return {
    targets: [target],
    observerLat: 40,
    observerLon: -74,
    windowStart: '2026-01-01T02:00:00.000Z',
    windowEnd: '2026-01-01T04:00:00.000Z',
    slotMinutes: 60,
    maxObjects: 1,
    minAlt: 10,
    moonIllumination: 0,
    visibleSkyMap: null,
  };
}

const baseTarget = {
  id: 'ngc0001',
  name: 'Test Object',
  type: 'Galaxy',
  ra: 12,
  dec: 65,
  commonNames: [],
  isAlreadyImaged: false,
};

describe('POST /planner/plan — target schema tolerates both encodings of "absent"', () => {
  it('accepts a target with magnitude/majorAxisArcmin/constellation keys entirely missing (Swift JSONEncoder omits nil optionals)', async () => {
    const res = await fetch(`${baseUrl}/planner/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(planRequestBody(baseTarget)),
    });
    expect(res.status).toBe(200);
  });

  it('accepts a target with those keys explicitly null (web always sends the key)', async () => {
    const res = await fetch(`${baseUrl}/planner/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        planRequestBody({ ...baseTarget, magnitude: null, majorAxisArcmin: null, constellation: null }),
      ),
    });
    expect(res.status).toBe(200);
  });

  it('accepts a target with those keys present and populated', async () => {
    const res = await fetch(`${baseUrl}/planner/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        planRequestBody({ ...baseTarget, magnitude: 8.5, majorAxisArcmin: 12, constellation: 'Andromeda' }),
      ),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /planner/plan — visibleSkyMap tolerates an unconfigured site', () => {
  it('accepts an empty array (iOS sends [] rather than null when a site has no mask configured)', async () => {
    const res = await fetch(`${baseUrl}/planner/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...planRequestBody(baseTarget), visibleSkyMap: [] }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts a fully-configured 288-cell map', async () => {
    const res = await fetch(`${baseUrl}/planner/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...planRequestBody(baseTarget), visibleSkyMap: Array(288).fill(true) }),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /planner/verdict — same schema tolerances as /plan', () => {
  const verdictItem = { id: '1', ra: 12, dec: 65, start: '2026-01-01T02:00:00.000Z', end: '2026-01-01T03:00:00.000Z' };

  it('accepts an empty visibleSkyMap array', async () => {
    const res = await fetch(`${baseUrl}/planner/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [verdictItem], observerLat: 40, observerLon: -74, moonIllumination: 0, visibleSkyMap: [] }),
    });
    expect(res.status).toBe(200);
  });
});
