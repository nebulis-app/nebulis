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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-plannedoutcome-routes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { plannedSessionsRouter } from '../../server/routes/plannedSessions';
import db from '../../server/lib/db';

let server: http.Server;
let baseUrl: string;

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
  app.use('/planned-sessions', plannedSessionsRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM plannedSessions').run();
});

async function createBlock(startTime: string, endTime: string) {
  const res = await fetch(`${baseUrl}/planned-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objectId: 'M42', objectName: 'Orion Nebula', ra: 5.588, dec: -5.391, startTime, endTime }),
  });
  return (await res.json()).data;
}

describe('GET /planned-sessions — outcomes', () => {
  it('attaches an outcome to each session, and omits it with ?outcomes=0', async () => {
    const past = await createBlock('2020-01-01T20:00:00.000Z', '2020-01-01T22:00:00.000Z');
    const future = await createBlock('2099-01-01T20:00:00.000Z', '2099-01-01T21:00:00.000Z');

    const range = '?from=2019-12-31T00:00:00.000Z&to=2100-01-01T00:00:00.000Z';
    const list = (await (await fetch(`${baseUrl}/planned-sessions${range}`)).json()).data;
    const byId = new Map(list.map((s: { id: number }) => [s.id, s]));
    expect(byId.get(past.id)).toMatchObject({ outcome: { status: 'missed', plannedSec: 7200, achievedSec: 0, frames: 0 } });
    expect(byId.get(future.id)).toMatchObject({ outcome: { status: 'upcoming', plannedSec: 3600 } });

    const bare = (await (await fetch(`${baseUrl}/planned-sessions${range}&outcomes=0`)).json()).data;
    expect(bare[0]).not.toHaveProperty('outcome');
  });

  it('marks and unmarks a block as skipped through PATCH', async () => {
    const past = await createBlock('2020-01-01T20:00:00.000Z', '2020-01-01T22:00:00.000Z');
    const patch = (skipped: boolean) => fetch(`${baseUrl}/planned-sessions/${past.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped }),
    });
    expect((await (await patch(true)).json()).data.skipped).toBe(1);
    let list = (await (await fetch(`${baseUrl}/planned-sessions`)).json()).data;
    expect(list[0].outcome.status).toBe('skipped');

    expect((await (await patch(false)).json()).data.skipped).toBe(0);
    list = (await (await fetch(`${baseUrl}/planned-sessions`)).json()).data;
    expect(list[0].outcome.status).toBe('missed');
  });
});

describe('GET /planned-sessions/nights', () => {
  it('returns one summary per object and night within the range', async () => {
    await createBlock('2020-01-01T20:00:00.000Z', '2020-01-01T21:00:00.000Z');
    await createBlock('2020-01-01T22:00:00.000Z', '2020-01-01T23:00:00.000Z');
    await createBlock('2020-01-05T20:00:00.000Z', '2020-01-05T21:00:00.000Z');
    const res = await fetch(`${baseUrl}/planned-sessions/nights?from=2020-01-01&to=2020-01-03`);
    expect(res.status).toBe(200);
    const nights = (await res.json()).data;
    expect(nights).toHaveLength(1);
    expect(nights[0]).toMatchObject({ objectId: 'M42', blocks: 2, plannedSec: 7200, status: 'missed' });
  });

  it('rejects malformed ranges', async () => {
    expect((await fetch(`${baseUrl}/planned-sessions/nights?from=2020-01-05&to=2020-01-01`)).status).toBe(422);
    expect((await fetch(`${baseUrl}/planned-sessions/nights?from=yesterday&to=2020-01-01`)).status).toBe(422);
  });
});
