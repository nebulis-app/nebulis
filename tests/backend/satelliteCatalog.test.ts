import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors the pattern used across tests/backend.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-tlecache-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// The catalog module fetches through undici's named `fetch` export, not the
// global, so that is what has to be mocked to keep the test off the network.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import fs from 'fs';
import path from 'path';
import { SatelliteCatalog, CelestrakError, type TLERecord } from '../../server/lib/satelliteCatalog';

const CATALOG_PATH = path.join(TEST_DATA_DIR, 'tle-catalog.json');
const STALE_RECORDS: TLERecord[] = [
  {
    name: 'ISS (ZARYA)',
    line1: '1 25544U 98067A   24001.00000000  .00000000  00000-0  00000-0 0  9990',
    line2: '2 25544  51.6400 000.0000 0000000   0.0000   0.0000 15.50000000000000',
    noradId: 25544,
  },
];

function writeStaleCache(): void {
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(STALE_RECORDS, null, 2), 'utf-8');
  // Backdate mtime past CACHE_MAX_AGE_MS (24h) so loadCatalog treats it as
  // stale and attempts a fresh fetch instead of just reading the cache.
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(CATALOG_PATH, old, old);
}

// CODE_AUDIT.md Finding 8: fetchFromCelestrak() swallowed every per-URL error
// and never threw, so a total offline failure unconditionally overwrote a
// good on-disk cache with `[]`. The fix: fetchFromCelestrak throws when the
// primary group fails or is empty, instead of writing it.
describe('SatelliteCatalog — a failed TLE refresh must not destroy the cache', () => {
  beforeEach(() => {
    writeStaleCache();
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(CATALOG_PATH, { force: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('fetchFromCelestrak throws and leaves the cache untouched when the request fails', async () => {
    mockFetch.mockRejectedValue(new Error('network down in tests'));
    const catalog = new SatelliteCatalog();

    await expect(catalog.fetchFromCelestrak()).rejects.toThrow(/network down/i);

    const onDisk = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    expect(onDisk).toEqual(STALE_RECORDS);
    // The request count is the whole point of the rewrite: one primary group,
    // not a ~20-URL sweep.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces CelesTrak\'s block reason from a non-200 body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('<html><body>Your IP has been blocked for excessive requests.</body></html>'),
    });
    const catalog = new SatelliteCatalog();

    await expect(catalog.fetchFromCelestrak()).rejects.toThrow(CelestrakError);
    await expect(catalog.fetchFromCelestrak()).rejects.toThrow(/HTTP 403.*blocked for excessive requests/i);
    expect(catalog.getLastFetchError()).toMatch(/HTTP 403/);
  });

  it('loadCatalog falls back to the stale cache when the refresh fails', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const catalog = new SatelliteCatalog();

    const result = await catalog.loadCatalog();

    expect(result).toEqual(STALE_RECORDS);
    expect(catalog.isUsingStaleFallback()).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    expect(onDisk).toEqual(STALE_RECORDS);
  });

  it('backs off after a failure instead of re-fetching on the next loadCatalog', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const catalog = new SatelliteCatalog();

    await catalog.loadCatalog();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(catalog.backoffRemainingMs()).toBeGreaterThan(0);

    // Second call within the backoff window must not touch the network.
    await catalog.loadCatalog();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bundled seed when there is no cache on disk at all', async () => {
    fs.rmSync(CATALOG_PATH, { force: true });
    mockFetch.mockRejectedValue(new Error('offline'));
    const catalog = new SatelliteCatalog();

    const result = await catalog.loadCatalog();

    expect(result.length).toBeGreaterThan(1000);
    expect(catalog.isUsingSeed()).toBe(true);
    expect(catalog.getLastFetch()).toBeNull();
  });

  it('a successful primary fetch writes the cache and clears the backoff', async () => {
    const tleBody = STALE_RECORDS.map(r => `${r.name}\n${r.line1}\n${r.line2}`).join('\n') + '\n';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(tleBody),
    });
    const catalog = new SatelliteCatalog();

    const records = await catalog.fetchFromCelestrak();

    expect(records).toEqual(STALE_RECORDS);
    expect(catalog.isUsingStaleFallback()).toBe(false);
    expect(catalog.backoffRemainingMs()).toBe(0);
    expect(JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'))).toEqual(STALE_RECORDS);
  });
});
