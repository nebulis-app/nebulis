/**
 * /api and /api/v1 are the same API. The web app calls /api, the Android and
 * Apple clients call /api/v1, and index.ts mounts one router at both. This
 * runs the real server and checks that nothing differs between the prefixes:
 * every mount, the auth rules, the rate limit counter, and the headers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startServer, type RunningServer } from './helpers/serverProcess';

let server: RunningServer;
let token = '';

const PREFIXES = ['/api/v1', '/api'] as const;

/** Every `v1.use('/x', ...)` mount in server/index.ts, so a new router is covered without editing this test. */
function mountedPrefixes(): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
  return [...source.matchAll(/^v1\.use\('(\/[^']+)',/gm)].map(m => m[1]);
}

const call = (prefix: string, p: string, init: RequestInit = {}) =>
  fetch(`${server.url}${prefix}${p}`, init);

beforeAll(async () => {
  server = await startServer();
  const res = await call('/api/v1', '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse' }),
  });
  token = ((await res.json()) as { data: { token: string } }).data.token;
}, 90_000);

afterAll(() => server?.cleanup());

const authed = () => ({ headers: { Authorization: `Bearer ${token}` } });

describe('both prefixes serve the same API', () => {
  it('has the mounts the test is built from', () => {
    expect(mountedPrefixes().length).toBeGreaterThan(20);
  });

  it('every mount answers identically under /api and /api/v1', async () => {
    const differences: string[] = [];
    for (const mount of mountedPrefixes()) {
      const [v1, legacy] = await Promise.all(PREFIXES.map(p => call(p, `${mount}/`, authed())));
      if (v1.status !== legacy.status) differences.push(`${mount}: /api/v1 ${v1.status}, /api ${legacy.status}`);
      await v1.arrayBuffer();
      await legacy.arrayBuffer();
    }
    expect(differences).toEqual([]);
  });

  it('serves the same endpoints with the same shape, including health and the OpenAPI spec', async () => {
    for (const p of ['/health', '/auth/status', '/meta/version', '/openapi.json']) {
      const [a, b] = await Promise.all(PREFIXES.map(prefix => call(prefix, p, authed())));
      expect(a.status, p).toBe(200);
      expect(b.status, p).toBe(200);
      const [ja, jb] = [await a.json() as { data?: object }, await b.json() as { data?: object }];
      expect(Object.keys(ja.data ?? ja).sort(), p).toEqual(Object.keys(jb.data ?? jb).sort());
    }
  });

  it('404s unknown routes the same way', async () => {
    const [a, b] = await Promise.all(PREFIXES.map(p => call(p, '/definitely-not-a-route', authed())));
    expect(a.status).toBe(b.status);
  });

  it('requires a login on both prefixes and accepts the same token on both', async () => {
    for (const prefix of PREFIXES) {
      expect((await call(prefix, '/settings')).status, `${prefix} without a token`).toBe(401);
      expect((await call(prefix, '/settings', authed())).status, `${prefix} with a token`).toBe(200);
    }
  });

  it('keeps admin-only routes admin-only on both prefixes', async () => {
    for (const prefix of PREFIXES) {
      const res = await call(prefix, '/system-log');
      expect(res.status, prefix).toBe(401);
    }
  });

  it('counts both prefixes against one rate limit', async () => {
    const remaining = async (prefix: string) =>
      Number((await call(prefix, '/health')).headers.get('ratelimit-remaining'));
    const first = await remaining('/api/v1');
    const second = await remaining('/api');
    const third = await remaining('/api/v1');
    expect(second).toBe(first - 1);
    expect(third).toBe(second - 1);
  });

  it('marks neither prefix deprecated: the web app depends on /api', async () => {
    for (const prefix of PREFIXES) {
      const res = await call(prefix, '/health');
      for (const header of ['deprecation', 'sunset', 'link']) {
        expect(res.headers.get(header), `${prefix} ${header}`).toBeNull();
      }
    }
  });
});
