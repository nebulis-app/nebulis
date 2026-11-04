import { describe, it, expect, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(root, 'nebulis-reports-routes-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { reportsRouter } from '../../../server/routes/reports';
import { LIBRARY_DIR } from '../../../server/lib/paths';
import { routeApp } from '../helpers/routeApp';

const app = routeApp(reportsRouter);

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

/** A FITS file that is only a header: one 2880-byte block of 80-character cards. */
function fitsHeader(cards: Record<string, string | number>): Buffer {
  const lines = Object.entries(cards).map(([k, v]) => `${k.padEnd(8)}= ${(typeof v === 'number' ? String(v) : `'${v}'`).padStart(20)}`.padEnd(80));
  lines.push('END'.padEnd(80));
  const block = Buffer.alloc(2880, ' ');
  Buffer.from(lines.join('')).copy(block);
  return block;
}

function writeFrames(objectId: string, frames: Array<{ name: string; cards: Record<string, string | number> }>) {
  const dir = path.join(LIBRARY_DIR, objectId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of frames) fs.writeFileSync(path.join(dir, f.name), fitsHeader(f.cards));
}

describe('GET /session/:objectId/:sessionDate', () => {
  it('renders a report for a known object with its name, constellation and the date, escaped, as HTML', async () => {
    const res = await request(app).get('/session/M31/2024-10-08');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<title>');
    expect(res.text).toContain('Andromeda');
    expect(res.text).toContain('2024-10-08');
    expect(res.text).toContain('Nebulis Report');
  });

  it('says so when the night has no sub-frames', async () => {
    const res = await request(app).get('/session/M31/2024-10-08');
    expect(res.text).toContain('No sub-frame data available for this session.');
    expect(res.text).not.toContain('Total Integration');
  });

  it('includes the moon illumination for a valid date', async () => {
    const res = await request(app).get('/session/M31/2024-10-08');
    expect(res.text).toMatch(/\d+% illuminated/);
  });

  it('sums exposure, frames, gain, temperature and every filter from the FITS headers of that night only', async () => {
    writeFrames('M42', [
      { name: 'Light_M42_10.0s_20241008-220000.fit', cards: { EXPTIME: 30, GAIN: 80, 'CCD-TEMP': -10, FILTER: 'Ha', 'DATE-OBS': '2024-10-08T22:00:00' } },
      { name: 'Light_M42_10.0s_20241008-220100.fit', cards: { EXPTIME: 30, GAIN: 80, 'CCD-TEMP': -10, FILTER: 'OIII' } },
      { name: 'Light_M42_10.0s_20241009-220000.fit', cards: { EXPTIME: 600, GAIN: 99, FILTER: 'SII' } },
    ]);
    const res = await request(app).get('/session/M42/2024-10-08');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Total Integration');
    expect(res.text).toMatch(/stat-value good">1m 0s</);
    expect(res.text).toMatch(/Total Frames<\/div>\s*<div class="stat-value">2</);
    expect(res.text).toMatch(/Gain<\/div><div class="stat-value">80</);
    expect(res.text).toMatch(/Sensor Temp<\/div><div class="stat-value">-10&deg;C/);
    expect(res.text).toMatch(/Filter<\/div><div class="stat-value">[^<]*Ha[^<]*OIII|Filter<\/div><div class="stat-value">[^<]*OIII[^<]*Ha/);
    expect(res.text).not.toContain('SII');
  });

  it('escapes markup in the object id and the date rather than echoing it into the page', async () => {
    const res = await request(app).get(`/session/${encodeURIComponent('<img src=x onerror=alert(1)>')}/${encodeURIComponent('"><script>1</script>')}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).not.toContain('<script>1</script>');
    expect(res.text).toContain('&lt;img src=x');
  });

  it('does not read outside the library for a traversal-shaped object id', async () => {
    const res = await request(app).get(`/session/${encodeURIComponent('../../etc')}/2024-10-08`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No sub-frame data available for this session.');
  });
});

describe('GET /integration/:objectId', () => {
  it('reports zero for an object with no folder', async () => {
    const res = await request(app).get('/integration/NGC-nothing-here');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ objectId: 'NGC-nothing-here', totalFrames: 0, totalExposureSec: 0, totalFormatted: '0s', sessions: [] });
  });

  it('totals frames and exposure per night, sorted by date, defaulting a missing exposure to 10 s', async () => {
    writeFrames('M45', [
      { name: 'Light_M45_10.0s_20241010-220000.fit', cards: { EXPTIME: 60 } },
      { name: 'Light_M45_10.0s_20241008-220000.fit', cards: { EXPTIME: 120 } },
      { name: 'Light_M45_10.0s_20241008-220100.fit', cards: { EXPTIME: 120 } },
      { name: 'Light_M45_10.0s_20241009-220000.fit', cards: { GAIN: 80 } },
    ]);
    const res = await request(app).get('/integration/M45');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ objectId: 'M45', totalFrames: 4, totalExposureSec: 310, totalFormatted: '5m 10s' });
    expect(res.body.data.sessions).toEqual([
      { date: '2024-10-08', frames: 2, exposureSec: 240 },
      { date: '2024-10-09', frames: 1, exposureSec: 10 },
      { date: '2024-10-10', frames: 1, exposureSec: 60 },
    ]);
  });

  it('serves a repeat request from cache, even after the files change', async () => {
    writeFrames('M13', [{ name: 'Light_M13_10.0s_20241008-220000.fit', cards: { EXPTIME: 30 } }]);
    const first = await request(app).get('/integration/M13');
    expect(first.body.data.totalExposureSec).toBe(30);
    writeFrames('M13', [{ name: 'Light_M13_10.0s_20241008-220100.fit', cards: { EXPTIME: 30 } }]);
    const second = await request(app).get('/integration/M13');
    expect(second.body.data.totalFrames).toBe(1);
  });

  it('refuses an object id that resolves outside the library', async () => {
    const res = await request(app).get(`/integration/${encodeURIComponent('../../..')}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OBJECT_ID');
  });
});
