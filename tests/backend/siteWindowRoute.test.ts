import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { sitesRouter } from '../../server/routes/sites';
import { createSite, getSite } from '../../server/lib/observingSites';

describe('the site routes keep the imaging window', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = 'admin'; next(); });
    app.use('/api/v1/sites', sitesRouter);
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  it('saves the window on PUT, returns it, and keeps it on a later edit that does not mention it', async () => {
    const site = createSite({ name: 'Window route test', latitude: 35.9, longitude: -86.8 });
    const put = await send('PUT', `/sites/${site.id}`, { name: 'Window route test', minAlt: 20, darkness: 'nautical', windowStartOffsetMin: 60, windowEndOffsetMin: 20 });
    expect(put.data).toMatchObject({ darkness: 'nautical', windowStartOffsetMin: 60, windowEndOffsetMin: 20 });
    expect(getSite(site.id)).toMatchObject({ darkness: 'nautical', windowStartOffsetMin: 60, windowEndOffsetMin: 20 });

    // An edit that never names the window (the Planner's sky mask, say) must not reset it.
    await send('PUT', `/sites/${site.id}`, { minAlt: 25 });
    expect(getSite(site.id)).toMatchObject({ minAlt: 25, darkness: 'nautical', windowStartOffsetMin: 60, windowEndOffsetMin: 20 });
  });

  it('creates a site with a window, and refuses one out of range', async () => {
    const created = await send('POST', '/sites', { name: 'Window route test 2', latitude: 35.9, longitude: -86.8, windowStartOffsetMin: 45 });
    expect(created.data.windowStartOffsetMin).toBe(45);
    const bad = await send('PUT', `/sites/${created.data.id}`, { windowEndOffsetMin: 9999 });
    expect(bad.ok).toBe(false);
  });
});
