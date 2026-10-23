import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads (mirrors plannerRoutes.test.ts).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-plannertonightdate-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { plannerRouter } from '../../server/routes/planner';

// GET /planner/tonight?date= used to validate only the YYYY-MM-DD shape, so a
// calendar-invalid date like 2026-13-40 reached zonedDateTimeToUtc, rolled over
// to 2027-02-09, and returned a 200 plan for the wrong night.

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
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

async function getTonight(date: string): Promise<{ status: number; code: unknown }> {
  const res = await fetch(`${baseUrl}/planner/tonight?date=${encodeURIComponent(date)}&lat=40&lon=-74`);
  const body: unknown = await res.json();
  const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return { status: res.status, code };
}

describe('GET /planner/tonight — date must be a real calendar date', () => {
  it.each(['2026-13-40', '2026-02-30', '2026-00-10', 'not-a-date'])('rejects %s with 422 VALIDATION_ERROR', async date => {
    const { status, code } = await getTonight(date);
    expect(status).toBe(422);
    expect(code).toBe('VALIDATION_ERROR');
  });

  it('does not reject a real date (2024-02-29, a leap day) at validation', async () => {
    const { code } = await getTonight('2024-02-29');
    expect(code).not.toBe('VALIDATION_ERROR');
  });
});
