import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db from '../../server/lib/db';
import sharp from '../../server/lib/sharp-optional';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { updateSettingsData } from '../../server/lib/telescopes';
import { activeSiteTimeZone } from '../../server/lib/siteTimeZone';
import { captureInstant, fitsInstant, getAnnotations, getSolarSystem } from '../../server/lib/annotate/annotateService';
import { NOTABLE_OBJECTS, notableInFrame } from '../../server/lib/annotate/notableObjects';
import {
  LIMIT_MAGNITUDE, SkybotError, _resetSkybotForTests, fieldCone, julianDate, parseSkybotResponse, sexagesimal,
  skybotQueryUrl, solarSystemMarks,
} from '../../server/lib/annotate/skybot';
import { approximateWcs } from '../../server/lib/annotate/wcs';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'skybot');
/** A real SkyBoT answer: 2024-03-10 02:00 UT, 1200″ around RA 148.67°, Dec +16.3838° (the service's own example field). */
const CONE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'conesearch-2024-03-10T020000-ra148.67-dec16.3838-r1200s.json'), 'utf8')) as unknown;
/** A real SkyBoT failure: HTTP 200 with flag -1 (message shortened). */
const FAILURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'error-flag-minus1.json'), 'utf8')) as unknown;

const FIELD = { raDeg: 148.67, decDeg: 16.3838 };

describe('notable objects', () => {
  const threeC273 = NOTABLE_OBJECTS.find(o => o.id === '3c273')!;

  it('marks a notable object inside the frame', () => {
    const wcs = approximateWcs({ raDeg: threeC273.raDeg + 0.1, decDeg: threeC273.decDeg, width: 1200, height: 800, longSideDeg: 1 });
    const found = notableInFrame(wcs);
    expect(found.map(a => a.id)).toEqual(['notable:3c273']);
    expect(found[0]).toMatchObject({ layer: 'notable', typeCode: 'quasar', label: '3C 273', designation: null });
    expect(found[0].x).toBeGreaterThan(600); // west of centre, so right of it with north up
  });

  it('leaves out what is outside the frame', () => {
    const wcs = approximateWcs({ raDeg: threeC273.raDeg + 1, decDeg: threeC273.decDeg, width: 1200, height: 800, longSideDeg: 1 });
    expect(notableInFrame(wcs)).toEqual([]);
  });

  it('has unique ids and positions on the sky', () => {
    expect(new Set(NOTABLE_OBJECTS.map(o => o.id)).size).toBe(NOTABLE_OBJECTS.length);
    for (const o of NOTABLE_OBJECTS) {
      expect(o.raDeg).toBeGreaterThanOrEqual(0);
      expect(o.raDeg).toBeLessThan(360);
      expect(Math.abs(o.decDeg)).toBeLessThanOrEqual(90);
    }
  });
});

describe('SkyBoT answers', () => {
  it('reads sexagesimal hours and degrees, including a negative zero degree', () => {
    expect(sexagesimal('09 54 30.7951')).toBeCloseTo(9.908554, 5);
    expect(sexagesimal('+16 21 28.033')).toBeCloseTo(16.357787, 5);
    expect(sexagesimal('-0 05 12.1')).toBeCloseTo(-0.086694, 5);
    expect(sexagesimal('nonsense')).toBeNull();
  });

  it('parses a real cone search', () => {
    const bodies = parseSkybotResponse(CONE);
    expect(bodies).toHaveLength(53);
    expect(bodies[0]).toMatchObject({ name: '2022 SQ81', number: null, bodyClass: 'MB>Inner', vmag: 22.7 });
    expect(bodies[0].raDeg).toBeCloseTo((9 + 54 / 60 + 33.1033 / 3600) * 15, 6);
    const numbered = bodies.find(b => b.number === 17684)!;
    expect(numbered.link).toBe('https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=17684');
    expect(numbered.motionArcsecPerHour).toBeCloseTo(Math.hypot(-23.9102, 6.6484), 4);
  });

  it('reads an empty field as no bodies, and a reported failure as an error', () => {
    expect(parseSkybotResponse([])).toEqual([]);
    expect(() => parseSkybotResponse(FAILURE)).toThrow(SkybotError);
    expect(() => parseSkybotResponse(FAILURE)).toThrow(/computeEphemeris/);
  });

  it('asks for an instant as a Julian date and the field as a radius in degrees', () => {
    const epoch = new Date('2024-03-10T02:00:00Z');
    expect(julianDate(new Date(0))).toBe(2440587.5);
    expect(julianDate(epoch)).toBeCloseTo(2460379.583333, 6);
    const url = new URL(skybotQueryUrl(epoch, FIELD.raDeg, FIELD.decDeg, 0.3333));
    expect(url.searchParams.get('-ep')).toBe('2460379.583333');
    expect(url.searchParams.get('-rd')).toBe('0.3333');
    expect(url.searchParams.get('-mime')).toBe('json');
  });

  it('draws the bodies bright enough to be in an amateur picture and counts the rest', () => {
    const wcs = approximateWcs({ ...FIELD, width: 1200, height: 800, longSideDeg: 0.6 });
    const { annotations, fainter } = solarSystemMarks(wcs, parseSkybotResponse(CONE));
    expect(annotations.length).toBeGreaterThan(0);
    expect(fainter).toBeGreaterThan(annotations.length);
    for (const a of annotations) {
      expect(a.layer).toBe('solarSystem');
      expect(a.magnitude ?? 0).toBeLessThanOrEqual(LIMIT_MAGNITUDE);
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(1200);
    }
    const mags = annotations.map(a => a.magnitude ?? 99);
    expect([...mags].sort((x, y) => x - y)).toEqual(mags);
    expect(annotations.find(a => a.id === 'sso:17684')?.label).toBe('(17684) 1997 AS16');
  });

  it("asks about the picture's half-diagonal", () => {
    const wcs = approximateWcs({ ...FIELD, width: 1200, height: 800, longSideDeg: 0.6 });
    const cone = fieldCone(wcs)!;
    expect(cone.raDeg).toBeCloseTo(FIELD.raDeg, 6);
    expect(cone.radiusDeg).toBeCloseTo(Math.hypot(0.6, 0.4) / 2, 3);
  });
});

describe('capture instant', () => {
  it('reads DATE-OBS as UTC unless it carries its own offset', () => {
    expect(fitsInstant('2024-03-10T02:00:00')?.toISOString()).toBe('2024-03-10T02:00:00.000Z');
    expect(fitsInstant('2024-03-10T03:00:00+01:00')?.toISOString()).toBe('2024-03-10T02:00:00.000Z');
    expect(fitsInstant('2024-03-10')).toBeNull();
    expect(fitsInstant(42)).toBeNull();
  });

  it('prefers the FITS twin, then the file name time in the site zone', () => {
    const file = { captureDate: '2024-03-10', captureTime: '030000' };
    expect(captureInstant({ 'DATE-OBS': '2024-03-10T01:30:00' }, file, 'Europe/Paris'))
      .toEqual({ epoch: new Date('2024-03-10T01:30:00Z'), source: 'fits' });
    expect(captureInstant(null, file, 'Europe/Paris'))
      .toEqual({ epoch: new Date('2024-03-10T02:00:00Z'), source: 'file' });
  });

  it('has no instant for a picture without a time', () => {
    expect(captureInstant(null, { captureDate: '2024-03-10', captureTime: null }, 'Europe/Paris')).toBeNull();
    expect(captureInstant(null, undefined, 'Europe/Paris')).toBeNull();
  });
});

describe('getSolarSystem and notable marks on a library picture', () => {
  const REL = 'M999/wimi-test/Stacked_M999.jpg';
  const DIR = path.join(getLibraryDir(), 'M999', 'wimi-test');

  async function picture({ solved, time }: { solved: boolean; time: boolean }) {
    const abs = path.join(getLibraryDir(), REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#000' } }).jpeg().toFile(abs);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, captureTime, importedAt)
       VALUES ('M999', ?, ?, ?, 'stacked', ?, ?, '2026-11-01T00:00:00Z')`,
    ).run(REL, path.basename(REL), path.basename(REL), time ? '2024-03-10' : null, time ? '030000' : null);
    if (solved) {
      const wcs = approximateWcs({ ...FIELD, width: 1200, height: 800, longSideDeg: 0.6 });
      db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, 'astap', ?, 'x')`)
        .run(REL, fs.statSync(abs).mtimeMs, JSON.stringify(wcs));
    }
  }

  beforeEach(() => {
    _resetSkybotForTests();
    updateSettingsData({ annotateSolarSystem: true });
  });

  afterEach(() => {
    updateSettingsData({ annotateSolarSystem: false });
    db.prepare('DELETE FROM libraryFiles WHERE relPath = ?').run(REL);
    db.prepare('DELETE FROM fileWcs WHERE relPath = ?').run(REL);
    db.prepare('DELETE FROM solarSystemCache WHERE relPath = ?').run(REL);
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('asks SkyBoT once per picture, at its capture time, and keeps the answer', async () => {
    await picture({ solved: true, time: true });
    const fetcher = vi.fn(async () => CONE);
    const first = await getSolarSystem(REL, fetcher);
    expect(first.status).toBe('ok');
    expect(first.epochSource).toBe('file');
    expect(first.annotations.length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL((fetcher.mock.calls[0] as unknown as [string])[0]);
    const expected = captureInstant(null, { captureDate: '2024-03-10', captureTime: '030000' }, activeSiteTimeZone())!;
    expect(Number(url.searchParams.get('-ep'))).toBeCloseTo(julianDate(expected.epoch), 5);

    const again = await getSolarSystem(REL, fetcher);
    expect(again.annotations).toEqual(first.annotations);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a failure without keeping it, so a later look asks again', async () => {
    await picture({ solved: true, time: true });
    const failing = vi.fn(async () => { throw new SkybotError('SkyBoT answered HTTP 503'); });
    const result = await getSolarSystem(REL, failing);
    expect(result).toMatchObject({ status: 'unavailable', message: 'SkyBoT answered HTTP 503', annotations: [] });
    const fetcher = vi.fn(async () => CONE);
    expect((await getSolarSystem(REL, fetcher)).status).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the setting is off, the picture is not solved, or it has no capture time', async () => {
    const fetcher = vi.fn(async () => CONE);
    await picture({ solved: false, time: true });
    expect((await getSolarSystem(REL, fetcher)).status).toBe('inexact');
    db.prepare('DELETE FROM libraryFiles WHERE relPath = ?').run(REL);
    fs.rmSync(DIR, { recursive: true, force: true });

    await picture({ solved: true, time: false });
    expect((await getSolarSystem(REL, fetcher)).status).toBe('no-time');
    updateSettingsData({ annotateSolarSystem: false });
    expect((await getSolarSystem(REL, fetcher)).status).toBe('disabled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('adds notable objects to a solved picture without any network', async () => {
    const twin = NOTABLE_OBJECTS.find(o => o.id === 'twinquasar')!;
    const abs = path.join(getLibraryDir(), REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#000' } }).jpeg().toFile(abs);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES ('M999', ?, ?, ?, 'stacked', 'x')`,
    ).run(REL, path.basename(REL), path.basename(REL));
    const wcs = approximateWcs({ raDeg: twin.raDeg, decDeg: twin.decDeg, width: 1200, height: 800, longSideDeg: 1 });
    db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, 'astap', ?, 'x')`)
      .run(REL, fs.statSync(abs).mtimeMs, JSON.stringify(wcs));
    const result = await getAnnotations(REL);
    expect(result.quality).toBe('solved');
    expect(result.annotations.find(a => a.layer === 'notable')?.id).toBe('notable:twinquasar');
  });
});
