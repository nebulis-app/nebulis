import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { createShutdown, createRequestTracker, DEFAULT_GRACE_MS } from '../../server/lib/shutdown';

const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

async function start(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function harness(over: Partial<Parameters<typeof createShutdown>[0]> & { servers: http.Server[] }) {
  const events: string[] = [];
  const shutdown = createShutdown({
    isBusy: () => false,
    closeDatabase: () => { events.push('db'); },
    exit: code => { events.push(`exit:${code}`); },
    log: m => { events.push(`log:${m}`); },
    pollMs: 5,
    flushMs: 0,
    graceMs: 400,
    ...over,
  });
  return { shutdown, events };
}

describe('createShutdown', () => {
  it('with nothing running: stops listening, closes the database, then exits 0, in that order', async () => {
    const { server, url } = await start((_q, r) => r.end('ok'));
    const { shutdown, events } = harness({ servers: [server] });
    const t0 = Date.now();
    await shutdown('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(events.filter(e => !e.startsWith('log:'))).toEqual(['db', 'exit:0']);
    await expect(fetch(url)).rejects.toThrow();
  });

  it('does not ask running work to stop when nothing is running', async () => {
    const { server } = await start((_q, r) => r.end());
    let stops = 0;
    const { shutdown } = harness({ servers: [server], requestStop: () => { stops++; } });
    await shutdown('SIGTERM');
    expect(stops).toBe(0);
  });

  it('lets an in-flight request finish and deliver its whole response', async () => {
    const tracker = createRequestTracker();
    const app = express();
    app.use(tracker.middleware);
    app.get('/slow', (_q, r) => { setTimeout(() => r.send('finished'), 150); });
    const { server, url } = await start(app);
    const { shutdown, events } = harness({ servers: [server], isBusy: () => tracker.active() > 0, onStart: tracker.markClosing });

    const pending = fetch(`${url}/slow`).then(r => r.text());
    await new Promise(r => setTimeout(r, 30)); // request is now in flight
    await shutdown('SIGTERM');

    expect(await pending).toBe('finished');
    expect(events.indexOf('db')).toBeLessThan(events.indexOf('exit:0'));
  });

  it('asks running work to stop once, waits for it, and does not cut it off when it stops in time', async () => {
    const { server } = await start((_q, r) => r.end());
    let busy = true;
    let stops = 0;
    const { shutdown, events } = harness({
      servers: [server],
      isBusy: () => busy,
      requestStop: () => { stops++; setTimeout(() => { busy = false; }, 60); },
    });
    await shutdown('SIGTERM');
    expect(stops).toBe(1);
    expect(events.some(e => e.includes('still running'))).toBe(false);
    expect(events.at(-1)).toBe('exit:0');
  });

  it('gives up after the grace period when work will not stop, and force-closes connections', async () => {
    const { server, url } = await start((_q, r) => { setTimeout(() => r.send('too late'), 5_000); });
    const { shutdown, events } = harness({ servers: [server], isBusy: () => true, graceMs: 120 });
    const hung = fetch(`${url}/`).then(r => r.text()).catch(() => 'aborted');
    await new Promise(r => setTimeout(r, 30));
    const t0 = Date.now();
    await shutdown('SIGTERM');
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(600);
    expect(events.some(e => e.includes('still running after the grace period'))).toBe(true);
    expect(await hung).toBe('aborted');
    expect(events.at(-1)).toBe('exit:0');
  });

  it('a second signal while shutting down does nothing extra', async () => {
    const { server } = await start((_q, r) => r.end());
    const { shutdown, events } = harness({ servers: [server] });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(events.filter(e => e === 'db')).toHaveLength(1);
    expect(events.filter(e => e === 'exit:0')).toHaveLength(1);
  });

  it('still exits when closing the database throws', async () => {
    const { server } = await start((_q, r) => r.end());
    const { shutdown, events } = harness({
      servers: [server],
      closeDatabase: () => { throw new Error('disk I/O error'); },
    });
    await shutdown('SIGTERM');
    expect(events.some(e => e.includes('Database close failed: disk I/O error'))).toBe(true);
    expect(events.at(-1)).toBe('exit:0');
  });

  it('still waits and exits when requestStop throws', async () => {
    const { server } = await start((_q, r) => r.end());
    let busy = true;
    const { shutdown, events } = harness({
      servers: [server],
      isBusy: () => busy,
      requestStop: () => { setTimeout(() => { busy = false; }, 30); throw new Error('nope'); },
    });
    await shutdown('SIGTERM');
    expect(events.some(e => e.includes('Could not ask running work to stop: nope'))).toBe(true);
    expect(events.at(-1)).toBe('exit:0');
  });

  it('keeps the default wait under launchd\'s 5 second exit timeout', () => {
    expect(DEFAULT_GRACE_MS).toBeLessThan(4_000);
  });
});

describe('createRequestTracker', () => {
  it('counts a request until its response is done, and only once', async () => {
    const tracker = createRequestTracker();
    const app = express();
    app.use(tracker.middleware);
    let seen = -1;
    app.get('/x', (_q, r) => { seen = tracker.active(); r.send('ok'); });
    const { url } = await start(app);
    expect(tracker.active()).toBe(0);
    await (await fetch(`${url}/x`)).text();
    await new Promise(r => setTimeout(r, 20));
    expect(seen).toBe(1);
    expect(tracker.active()).toBe(0);
  });

  it('releases the count when the client disconnects mid-request', async () => {
    const tracker = createRequestTracker();
    const app = express();
    app.use(tracker.middleware);
    app.get('/hang', () => { /* never answers */ });
    const { url } = await start(app);
    const ctl = new AbortController();
    const p = fetch(`${url}/hang`, { signal: ctl.signal }).catch(() => 'aborted');
    await waitUntil(() => tracker.active() === 1);
    ctl.abort();
    await p;
    await waitUntil(() => tracker.active() === 0);
  });

  it('asks keep-alive clients to disconnect once closing', async () => {
    const tracker = createRequestTracker();
    const app = express();
    app.use(tracker.middleware);
    app.get('/x', (_q, r) => r.send('ok'));
    const { url } = await start(app);
    expect((await fetch(`${url}/x`)).headers.get('connection')).not.toBe('close');
    tracker.markClosing();
    expect((await fetch(`${url}/x`)).headers.get('connection')).toBe('close');
  });
});

async function waitUntil(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
