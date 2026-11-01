import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-openapi-parity-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { telescopesRouter } from '../../server/routes/telescopes';
import { gearRouter } from '../../server/routes/gear';
import { journalRouter } from '../../server/routes/journal';
import { spec } from '../../server/routes/openapi';

/**
 * The published OpenAPI spec is the contract three native clients are built
 * against, and it is hand-assembled. Nothing used to compare it with the
 * routers, so it described endpoints that never existed and left the rest
 * (transports, optical configs, archive) out. Three audits in a row flagged it.
 *
 *   1. Every operation in the spec must be a real route. No allowlist: a spec
 *      entry for a route that does not exist sends clients to a 404.
 *   2. Every real route must be in the spec, or in the shrinking baseline of
 *      known gaps (fixtures/openapiUndocumented.json). A NEW route that is in
 *      neither fails here, so the gap can only close.
 *   3. A live telescope response must carry exactly the fields the spec says.
 *
 * After documenting routes, shrink the baseline:
 *   UPDATE_OPENAPI_BASELINE=1 npx vitest run tests/backend/openapiParity.test.ts
 */

const BASELINE_PATH = path.join(process.cwd(), 'tests', 'backend', 'fixtures', 'openapiUndocumented.json');
const INVENTORY_PATH = path.join(process.cwd(), 'tests', 'backend', 'fixtures', 'routeInventory.json');

/** `/library/{id}` and `/library/:objectId` are the same route. */
const normalize = (p: string) => p.replace(/\{[^}]+\}/g, ':_').replace(/:\w+/g, ':_');
const key = (method: string, p: string) => `${method.toUpperCase()} ${normalize(p)}`;

interface InventoryEntry { method: string; path: string }
const inventory: InventoryEntry[] = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
const realRoutes = new Set(inventory.filter(e => !e.path.startsWith('/openapi.json')).map(e => key(e.method, e.path)));

/** Mounted on the app itself, outside the /api/v1 routers the inventory walks. */
const OUTSIDE_V1_ROUTERS = ['GET /health'];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const documented = new Map<string, string>(); // normalized key -> as written in the spec
for (const [specPath, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
  for (const method of HTTP_METHODS) {
    if (ops[method]) documented.set(key(method, specPath), `${method.toUpperCase()} ${specPath}`);
  }
}

describe('OpenAPI spec matches the routers', () => {
  it('documents no operation that does not exist', () => {
    const phantom = [...documented].filter(([k]) => !realRoutes.has(k) && !OUTSIDE_V1_ROUTERS.includes(k)).map(([, written]) => written).sort();
    expect(phantom).toEqual([]);
  });

  const undocumented = [...realRoutes].filter(k => !documented.has(k)).sort();

  it('documents every route, apart from the recorded baseline', () => {
    if (process.env.UPDATE_OPENAPI_BASELINE === '1') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(undocumented, null, 2)}\n`);
      return;
    }
    const baseline: string[] = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const newlyUndocumented = undocumented.filter(k => !baseline.includes(k));
    expect(
      newlyUndocumented,
      'These routes are in no part of the OpenAPI spec. Document them in server/routes/openapi.ts.',
    ).toEqual([]);
  });

  it('keeps the baseline honest: nothing in it is documented or gone', () => {
    if (process.env.UPDATE_OPENAPI_BASELINE === '1') return;
    const baseline: string[] = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const stale = baseline.filter(k => documented.has(k) || !realRoutes.has(k));
    expect(
      stale,
      'Remove these from fixtures/openapiUndocumented.json (UPDATE_OPENAPI_BASELINE=1 regenerates it).',
    ).toEqual([]);
  });
});

describe('telescope responses carry exactly the documented fields', () => {
  let server: http.Server;
  let baseUrl: string;
  const schemas = spec.components.schemas as Record<string, { properties: Record<string, unknown>; required?: string[] }>;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => {
      req.id = 'test-request';
      req.userId = 'test-user';
      req.userRole = 'admin';
      next();
    });
    app.use('/telescopes', telescopesRouter);
    app.use('/gear', gearRouter);
    app.use('/journal', journalRouter);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  const send = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (json.data == null) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
    return json.data;
  };
  const keysOf = (o: object) => Object.keys(o).sort();
  const documentedKeys = (name: string) => Object.keys(schemas[name].properties).sort();
  /** A response has every required field and nothing the schema does not list. */
  const expectMatchesSchema = (value: object, name: string) => {
    const actual = keysOf(value);
    expect(actual.filter(k => !documentedKeys(name).includes(k)), `${name}: fields missing from the spec`).toEqual([]);
    expect((schemas[name].required ?? []).filter(k => !actual.includes(k)), `${name}: documented fields the API did not send`).toEqual([]);
  };

  it('POST /telescopes returns the TelescopeProfile schema', async () => {
    const created = await send('POST', '/telescopes', { name: 'Parity scope', kind: 'seestar-s50', hostname: '10.0.0.5', shareName: 'EMMC Images' });
    expectMatchesSchema(created, 'TelescopeProfile');
  });

  it('GET /telescopes returns the TelescopeProfileListItem schema, nested shapes included', async () => {
    const list = await send('GET', '/telescopes');
    const profile = list[0];
    expectMatchesSchema(profile, 'TelescopeProfileListItem');
    expect(profile.transports.length).toBeGreaterThan(0);
    expectMatchesSchema(profile.transports[0], 'TelescopeTransport');
    expectMatchesSchema(profile.rig, 'TelescopeRig');

    const config = await send('POST', `/telescopes/${profile.id}/optical-configs`, {
      name: 'Native', focalLengthMm: 250, sensorWidthMm: 5.6, sensorHeightMm: 3.2,
    });
    expectMatchesSchema(config, 'TelescopeOpticalConfig');
  });

  it('gear and kit responses carry the documented fields', async () => {
    const item = await send('POST', '/gear', { kind: 'filter', name: 'L-eXtreme' });
    expectMatchesSchema(item, 'GearItem');
    const kit = await send('POST', '/gear/kits', { name: 'Dark site bag', itemIds: [item.id], extraItems: ['red torch'] });
    expectMatchesSchema(kit, 'GearKit');
    expectMatchesSchema((await send('GET', '/gear'))[0], 'GearItem');
  });

  it('journal entries carry the documented fields', async () => {
    const entry = await send('POST', '/journal', { night: '2026-10-08', title: 'Clear and cold', checklist: [{ text: 'Focus', done: true }] });
    expectMatchesSchema(entry, 'JournalEntry');
    expect(documentedKeys('JournalAttachment')).toContain('mimeType');
  });

  it('accepts every field the request schema documents', () => {
    const input = Object.keys(schemas.TelescopeProfileInput.properties);
    for (const field of ['syncCalibrationFrames', 'trackDeviceIdentity', 'pinnedTransportId', 'activeOpticalConfigId', 'connectionType']) {
      expect(input).toContain(field);
    }
  });
});
