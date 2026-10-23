import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-skycoalesce-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { prefetchSkyImage } from '../../server/lib/skyImage';

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// Real incident (2026-10-07): CDS's image endpoint hung, and the same objects
// (NGC1647, SH2-274, HD279230) timed out again and again, each under a
// different request id within seconds. Every request for an uncached image
// started its own slow fetch. Callers for one object now share a single fetch.

const COORDS = { ra: 83.8, dec: -5.4 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** A fetch whose response the test releases by hand, counting every call. */
function controllableFetch() {
  const calls: string[] = [];
  const releases: Array<(r: 'ok' | 'timeout') => void> = [];
  const fn = vi.fn((url: string) => {
    calls.push(String(url));
    return new Promise<Response>((resolve, reject) => {
      releases.push(r => {
        if (r === 'ok') resolve(new Response(JPEG, { status: 200 }));
        else reject(new Error('The operation was aborted due to timeout'));
      });
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn, releaseAll: (r: 'ok' | 'timeout') => releases.splice(0).forEach(rel => rel(r)) };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('prefetchSkyImage — concurrent requests share one fetch', () => {
  it('starts a single CDS request for simultaneous callers and gives all of them the result', async () => {
    const f = controllableFetch();

    const callers = Array.from({ length: 5 }, () => prefetchSkyImage('CoalesceOk1', COORDS));
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    f.releaseAll('ok');
    const results = await Promise.all(callers);

    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(results[0]).toBeTruthy();
    expect(new Set(results).size).toBe(1);
    expect(fs.existsSync(results[0]!)).toBe(true);
  });

  it('shares a failure too, instead of timing out once per caller', async () => {
    const f = controllableFetch();

    const callers = Array.from({ length: 5 }, () => prefetchSkyImage('CoalesceFail1', COORDS));
    // One fetch for all five callers, tried against each CDS mirror in turn
    // (3 hosts), not once per caller per host.
    for (let host = 1; host <= 3; host++) {
      await vi.waitFor(() => expect(f.calls.length).toBe(host));
      f.releaseAll('timeout');
    }
    const results = await Promise.all(callers);

    expect(f.fn).toHaveBeenCalledTimes(3);
    expect(new Set(f.calls.map(u => new URL(u).host)).size).toBe(3);
    expect(results).toEqual([null, null, null, null, null]);
  });

  it('falls back to the next CDS mirror when the first never answers', async () => {
    const f = controllableFetch();

    const p = prefetchSkyImage('MirrorFallback1', COORDS);
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    f.releaseAll('timeout');
    await vi.waitFor(() => expect(f.calls.length).toBe(2));
    f.releaseAll('ok');

    const saved = await p;
    expect(typeof saved).toBe('string');
    expect(fs.existsSync(saved!)).toBe(true);
    expect(new URL(f.calls[0]).host).not.toBe(new URL(f.calls[1]).host);
  });

  it('treats spacing and case in the id as the same object', async () => {
    const f = controllableFetch();

    const a = prefetchSkyImage('NGC 7000', COORDS);
    const b = prefetchSkyImage('ngc7000', COORDS);
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    f.releaseAll('ok');
    await Promise.all([a, b]);

    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it('keeps different objects separate', async () => {
    const f = controllableFetch();

    const a = prefetchSkyImage('CoalesceA', COORDS);
    const b = prefetchSkyImage('CoalesceB', COORDS);
    await vi.waitFor(() => expect(f.calls.length).toBe(2));
    f.releaseAll('ok');
    await Promise.all([a, b]);

    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('lets a force refresh run its own fetch rather than joining one in progress', async () => {
    const f = controllableFetch();

    const normal = prefetchSkyImage('CoalesceForce', COORDS);
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    const forced = prefetchSkyImage('CoalesceForce', { ...COORDS, force: true });
    await vi.waitFor(() => expect(f.calls.length).toBe(2));
    f.releaseAll('ok');
    await Promise.all([normal, forced]);

    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('forgets a finished fetch, so a later forced refresh fetches again', async () => {
    const f = controllableFetch();

    const first = prefetchSkyImage('CoalesceDone', COORDS);
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    f.releaseAll('ok');
    await first;

    const again = prefetchSkyImage('CoalesceDone', { ...COORDS, force: true });
    await vi.waitFor(() => expect(f.calls.length).toBe(2));
    f.releaseAll('ok');
    await again;

    expect(f.fn).toHaveBeenCalledTimes(2);
  });
});
