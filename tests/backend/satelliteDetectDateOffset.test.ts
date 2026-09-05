import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors routeDecoding.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-satdetect-offset-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { satelliteRouter } from '../../server/routes/satellite';
import { satelliteCatalog } from '../../server/lib/satelliteCatalog';
import { LIBRARY_DIR } from '../../server/lib/paths';

// Same header-card builder used by fitsParser.test.ts.
function buildFitsBuffer(entries: Record<string, string | number | boolean>): Buffer {
  const cards: string[] = [];
  for (const [key, val] of Object.entries(entries)) {
    let card = key.padEnd(8);
    if (typeof val === 'boolean') {
      card += `= ${(val ? 'T' : 'F').padStart(20)}`;
    } else if (typeof val === 'number') {
      card += `= ${String(val).padStart(20)}`;
    } else {
      card += `= '${val}'`.padEnd(22);
    }
    cards.push(card.padEnd(80));
  }
  cards.push('END'.padEnd(80));
  const totalChars = cards.join('').length;
  const remainder = totalChars % 2880;
  let padded = cards.join('');
  if (remainder !== 0) padded += ' '.repeat(2880 - remainder);
  return Buffer.from(padded, 'ascii');
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  fs.mkdirSync(path.join(LIBRARY_DIR, 'M42'), { recursive: true });
  fs.writeFileSync(
    path.join(LIBRARY_DIR, 'M42', 'frame.fits'),
    buildFitsBuffer({
      // A numeric UTC offset, not 'Z' — the exact shape CODE_AUDIT.md Finding
      // 22 says the route mangled: appending 'Z' onto this produces
      // "...+02:00Z", an invalid ISO string, so obsDate became Invalid Date.
      'DATE-OBS': '2026-06-03T02:18:04+02:00',
      EXPTIME: 10,
      RA: 10.5,
      DEC: 20.0,
      'OBS-LAT': 40.0,
      'OBS-LONG': -74.0,
    }),
  );

  // Avoid a real Celestrak network fetch: with no cache on disk, loadCatalog
  // would otherwise try to hit the internet. Also lets the test capture
  // exactly what Date the route computed and handed to the catalog lookup.
  vi.spyOn(satelliteCatalog, 'loadCatalogForDate').mockResolvedValue([]);
  vi.spyOn(satelliteCatalog, 'loadCatalog').mockResolvedValue([]);

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = 'admin';
    next();
  });
  app.use('/', satelliteRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// CODE_AUDIT.md Finding 22: POST /detect naively appended 'Z' to DATE-OBS
// unless it already ended in 'Z'. A DATE-OBS with a numeric UTC offset (which
// normalizeObservationTimestamp's own doc comment says firmware sometimes
// writes) produced an invalid ISO string and an Invalid Date, poisoning the
// TLE archive lookup date and every candidate's duringExposure flag. The fix
// routes both call sites through normalizeObservationTimestamp instead.
describe('POST /detect — DATE-OBS with a numeric UTC offset', () => {
  it('normalizes the offset correctly instead of producing an Invalid Date', async () => {
    const res = await fetch(`${baseUrl}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'M42/frame.fits', identifyOnly: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    // +02:00 subtracted correctly: 02:18:04+02:00 == 00:18:04Z.
    expect(body.data.exposureStart).toBe('2026-06-03T00:18:04.000Z');
    expect(body.data.missingHeaders).toBeUndefined();
    expect(body.data.locationRequired).toBeUndefined();

    // The catalog lookup received a valid Date derived from the same
    // corrected instant, not NaN — this is what silently broke every
    // duringExposure check for offset-carrying headers before the fix.
    expect(satelliteCatalog.loadCatalogForDate).toHaveBeenCalledTimes(1);
    const obsDateArg = (satelliteCatalog.loadCatalogForDate as ReturnType<typeof vi.fn>).mock.calls[0][0] as Date;
    expect(Number.isNaN(obsDateArg.getTime())).toBe(false);
    expect(obsDateArg.toISOString()).toBe('2026-06-03T00:18:04.000Z');
  });
});
