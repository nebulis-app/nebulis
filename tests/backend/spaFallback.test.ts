/**
 * Built-asset serving: cache policy and the production SPA fallback
 * (server/lib/staticAssets.ts, server/middleware/spaFallback.ts).
 *
 * Mounts the real handlers on a bare express app (no supertest, matching
 * routeDecoding.test.ts) so status codes, headers, and file resolution are
 * exercised, not just the path-matching helper.
 *
 * The behaviour under test is the fix for a reported failure: a browser holding
 * an index.html from an older build lazily loads a route whose chunk hash no
 * longer exists on the server. The fallback used to answer that with the HTML
 * shell, so the browser reported "Importing a module script failed" instead of a
 * clean 404.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import { setDistCacheHeaders } from '../../server/lib/staticAssets.js';
import { spaFallback } from '../../server/middleware/spaFallback.js';

const INDEX_MARKER = '<div id="root">shell</div>';
const CHUNK_MARKER = 'export const planner = 1;';
let server: http.Server;
let baseUrl: string;
let distDir: string;

beforeAll(async () => {
  // os.tmpdir(), not the repo's .test-tmp: the `send` library behind sendFile
  // refuses to serve anything under a dot-directory, so a dot path would 404
  // for the wrong reason.
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-spa-fallback-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), INDEX_MARKER);
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets', 'PlannerPage-abc123.js'), CHUNK_MARKER);

  const app = express();
  // Mirrors the order in server/index.ts: static first, then the fallback.
  app.use(express.static(distDir, { setHeaders: setDistCacheHeaders }));
  app.get('/{*splat}', spaFallback(distDir));

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('built asset serving', () => {
  it('serves the shell at the root, revalidating so a new build is picked up', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain(INDEX_MARKER);
  });

  it('serves the shell for a client route, also revalidating', async () => {
    const res = await fetch(`${baseUrl}/planner`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain(INDEX_MARKER);
  });

  it('caches a hashed chunk immutably', async () => {
    const res = await fetch(`${baseUrl}/assets/PlannerPage-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toContain(CHUNK_MARKER);
  });

  it('404s a missing chunk instead of answering it with the HTML shell', async () => {
    // The stale-chunk case: a hash from a build the server no longer has.
    const res = await fetch(`${baseUrl}/assets/PlannerPage-GONE.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).not.toContain(INDEX_MARKER);
  });

  it('404s a missing media file rather than serving the shell', async () => {
    const res = await fetch(`${baseUrl}/screenshots/missing.png`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(INDEX_MARKER);
  });

  it('steps aside for /api so the API routers keep their own 404s', async () => {
    const res = await fetch(`${baseUrl}/api/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(INDEX_MARKER);
  });
});
