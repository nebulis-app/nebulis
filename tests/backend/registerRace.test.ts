import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors routeDecoding.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-registerrace-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { authRouter } from '../../server/routes/auth';
import { getUserCount } from '../../server/lib/auth';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use('/', authRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function register(username: string) {
  return fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123', displayName: username }),
  });
}

// CODE_AUDIT.md Finding 10: getUserCount() > 0 and the eventual insert inside
// registerUser() were separated by an await (bcrypt.hash), so two concurrent
// first-registration requests could both observe count === 0 before either
// had inserted a row, and both succeed — leaving two admin accounts (or a
// race between a legitimate install and a LAN attacker racing to claim the
// account first). The fix serializes the whole check-then-register sequence
// through a process-local queue.
describe('POST /register — first-user race', () => {
  it('lets exactly one of two concurrent registrations through', async () => {
    expect(getUserCount()).toBe(0);

    const [resA, resB] = await Promise.all([register('racer-a'), register('racer-b')]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

    const outcomes = [
      { status: resA.status, body: bodyA },
      { status: resB.status, body: bodyB },
    ];
    const successes = outcomes.filter(o => o.status === 200);
    const rejections = outcomes.filter(o => o.status === 403);

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].body.error?.code).toBe('REGISTRATION_CLOSED');
    expect(getUserCount()).toBe(1);
  });
});
