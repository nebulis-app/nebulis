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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertroutes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { alertsRouter, maskUrl } from '../../server/routes/alerts';
import { getAlertChannel } from '../../server/lib/alerts/store';
import { _setRetryDelayForTests } from '../../server/lib/alerts/delivery';

let server: http.Server;
let baseUrl: string;
let role = 'admin';

/** A receiver standing in for ntfy / Discord / a webhook. */
let receiver: http.Server;
let receiverUrl: string;
let received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let replyStatus = 200;

beforeAll(async () => {
  _setRetryDelayForTests(10);
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    (req as unknown as { userRole: string }).userRole = role;
    next();
  });
  app.use('/alerts', alertsRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.statusCode = replyStatus;
      res.end(replyStatus === 200 ? 'ok' : 'nope');
    });
  });
  await new Promise<void>(resolve => receiver.listen(0, resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => receiver.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  role = 'admin';
  received = [];
  replyStatus = 200;
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/alerts${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('alerts routes', () => {
  it('is admin only', async () => {
    role = 'viewer';
    expect((await call('GET', '/')).status).toBe(403);
  });

  it('creates a channel without ever returning its URL or secret', async () => {
    const created = await call('POST', '/channels', {
      name: 'Home Assistant', kind: 'webhook', url: `${receiverUrl}/api/webhook/abcd1234`, secret: 's3cret', events: ['night.clear'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Home Assistant', kind: 'webhook', hasSecret: true, enabled: true, events: ['night.clear'] });
    expect(created.body.data.urlPreview).toBe(`${receiverUrl}/…1234`);
    expect(JSON.stringify(created.body)).not.toContain('s3cret');
    expect(JSON.stringify(created.body)).not.toContain('abcd1234');

    // Stored encrypted, read back whole.
    const stored = getAlertChannel(created.body.data.id);
    expect(stored).toMatchObject({ url: `${receiverUrl}/api/webhook/abcd1234`, secret: 's3cret' });

    const list = await call('GET', '/');
    expect(list.body.data.channels.map((c: { id: string }) => c.id)).toContain(created.body.data.id);
    expect(list.body.data.config).toMatchObject({ language: 'en', clearNight: { checkTime: '17:00' } });
  });

  it('keeps the URL and secret on an update that leaves them out, and clears the secret on null', async () => {
    const { body } = await call('POST', '/channels', { name: 'A', kind: 'webhook', url: `${receiverUrl}/x`, secret: 'k', events: [] });
    const id = body.data.id;
    const renamed = await call('PUT', `/channels/${id}`, { name: 'B', events: ['import.finished'], enabled: false });
    expect(renamed.body.data).toMatchObject({ name: 'B', enabled: false, hasSecret: true, events: ['import.finished'] });
    expect(getAlertChannel(id)?.url).toBe(`${receiverUrl}/x`);
    expect((await call('PUT', `/channels/${id}`, { secret: null })).body.data.hasSecret).toBe(false);
    expect((await call('DELETE', `/channels/${id}`)).status).toBe(200);
    expect((await call('DELETE', `/channels/${id}`)).status).toBe(404);
  });

  it('rejects URLs that are not http(s) and unknown events', async () => {
    expect((await call('POST', '/channels', { name: 'A', kind: 'ntfy', url: 'file:///etc/passwd', events: [] })).status).toBe(422);
    expect((await call('POST', '/channels', { name: 'A', kind: 'ntfy', url: `${receiverUrl}/t`, events: ['bogus'] })).status).toBe(422);
    expect((await call('POST', '/channels', { name: 'A', kind: 'telegram', url: `${receiverUrl}/t`, events: [] })).status).toBe(422);
  });

  it('sends a test alert and records the outcome on the channel', async () => {
    const { body } = await call('POST', '/channels', { name: 'Phone', kind: 'ntfy', url: `${receiverUrl}/nebulis-topic`, events: [] });
    const ok = await call('POST', `/channels/${body.data.id}/test`);
    expect(ok.body.data).toMatchObject({ ok: true, status: 200, error: null, channel: { lastStatus: 'ok' } });
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toContain('/nebulis-topic?title=Nebulis+test+alert');
    expect(received[0]!.body).toBe('If you can read this, alerts to this channel work.');

    replyStatus = 404;
    const failed = await call('POST', `/channels/${body.data.id}/test`);
    expect(failed.body.data).toMatchObject({ ok: false, status: 404, error: 'HTTP 404: nope', channel: { lastStatus: 'error', lastError: 'HTTP 404: nope' } });
  });

  it('stores the options and checks them', async () => {
    const saved = await call('PUT', '/config', { language: 'fr', clearNight: { checkTime: '18:30', minClearHours: 4 } });
    expect(saved.body.data).toEqual({ language: 'fr', clearNight: { checkTime: '18:30', minClearHours: 4, maxCloudCover: 30 } });
    expect((await call('PUT', '/config', { clearNight: { checkTime: '25:00' } })).status).toBe(422);
    // The check treats the local calendar date as the night, so after-midnight times are refused.
    expect((await call('PUT', '/config', { clearNight: { checkTime: '01:00' } })).status).toBe(422);
    expect((await call('PUT', '/config', { clearNight: { checkTime: '11:59' } })).status).toBe(422);
    expect((await call('PUT', '/config', { clearNight: { checkTime: '12:00' } })).status).toBe(200);
    expect((await call('PUT', '/config', { language: 'it' })).status).toBe(422);
    await call('PUT', '/config', { language: 'en', clearNight: { checkTime: '17:00', minClearHours: 3 } });
  });

  it('tells the page when the evening check runs next, in the active site\'s time zone', async () => {
    const overview = (await call('GET', '/')).body.data;
    expect(overview.nextClearNightCheck).toMatchObject({ when: expect.stringMatching(/^(now|today|tomorrow)$/), timeZone: expect.any(String) });
    expect(Number.isNaN(Date.parse(overview.nextClearNightCheck.at))).toBe(false);
  });

  it('keeps a dew-warning lead time per channel: one hour to begin with, 15 minutes to 6 hours, whole minutes', async () => {
    const made = await call('POST', '/channels', { name: 'Ntfy', kind: 'ntfy', url: `${receiverUrl}/t`, events: ['night.dew'] });
    expect(made.body.data.details.dewLeadMinutes).toBe(60);
    expect(made.body.data.events).toEqual(['night.dew']);
    const id = made.body.data.id;
    expect((await call('PUT', `/channels/${id}`, { details: { dewLeadMinutes: 120 } })).body.data.details.dewLeadMinutes).toBe(120);
    // Changing something else leaves it; changing the switches leaves it too.
    expect((await call('PUT', `/channels/${id}`, { details: { dew: true } })).body.data.details).toEqual({ dew: true, plan: false, dewLeadMinutes: 120 });
    for (const bad of [14, 361, 90.5, '60', null]) {
      expect((await call('PUT', `/channels/${id}`, { details: { dewLeadMinutes: bad } })).status).toBe(422);
    }
    expect((await call('PUT', `/channels/${id}`, { details: { dewLeadMinutes: 15 } })).body.data.details.dewLeadMinutes).toBe(15);
    expect((await call('PUT', `/channels/${id}`, { details: { dewLeadMinutes: 360 } })).body.data.details.dewLeadMinutes).toBe(360);
  });

  it('keeps the extra clear-night lines on each channel, one switch at a time', async () => {
    const made = await call('POST', '/channels', { name: 'Ntfy', kind: 'ntfy', url: `${receiverUrl}/t`, events: ['night.clear'], details: { plan: true } });
    expect(made.status).toBe(201);
    expect(made.body.data.details).toEqual({ dew: false, plan: true, dewLeadMinutes: 60 });
    const id = made.body.data.id;
    // Turning one on never turns the other off, and an unrelated change leaves both as they are.
    expect((await call('PUT', `/channels/${id}`, { details: { dew: true } })).body.data.details).toEqual({ dew: true, plan: true, dewLeadMinutes: 60 });
    expect((await call('PUT', `/channels/${id}`, { name: 'Renamed' })).body.data.details).toEqual({ dew: true, plan: true, dewLeadMinutes: 60 });
    expect((await call('PUT', `/channels/${id}`, { details: { plan: false } })).body.data.details).toEqual({ dew: true, plan: false, dewLeadMinutes: 60 });
    expect((await call('PUT', `/channels/${id}`, { details: { dew: 'yes' } })).status).toBe(422);
    // A channel made without any reads as off, which is how every existing one behaves.
    const plain = await call('POST', '/channels', { name: 'Plain', kind: 'ntfy', url: `${receiverUrl}/p`, events: [] });
    expect(plain.body.data.details).toEqual({ dew: false, plan: false, dewLeadMinutes: 60 });
  });
});

describe('maskUrl', () => {
  it('keeps the host and the last characters only', () => {
    expect(maskUrl('https://discord.com/api/webhooks/123/abcdefXYZ9')).toBe('https://discord.com/…XYZ9');
    expect(maskUrl('https://ntfy.sh/')).toBe('https://ntfy.sh');
    expect(maskUrl('not a url')).toBe('');
  });
});
