/**
 * Observing location from the GPS a DWARF 3 writes into `stacked.jpg`, for
 * linked folders, and the 50 m match to a saved observing site.
 *
 * Coordinates are made up: real stacked.jpg files carry the observer's position.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-exifgps-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import { commitSource, rescanSource } from '../../server/lib/library/librarySources';
import { getLocalObservationDetail, getObservationLocations, reassignSessionSite } from '../../server/lib/library/observations';
import {
  sessionLocation, distanceMeters, nearestSiteWithin, SITE_MATCH_RADIUS_M,
} from '../../server/lib/library/sessionLocation';
import { readJpegGps, parseExifGps } from '../../server/lib/library/exifGps';
import { createSite, deleteSite, listSites } from '../../server/lib/observingSites';
import { geotaggedJpeg, exifTiff } from '../fixtures/geotaggedJpeg';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true };

/** Where the fixture DWARF stood: 41°30'00" N, 2°15'00" W, 900 m. */
const GPS = { lat: 41.5, lon: -2.25, altM: 900 };
/** The default site, far away. */
const HOME = { lat: 36.0, lon: -5.0 };

const OBJECT_ID = 'IC5146';
const NIGHT = '2026-10-31';
const FOLDER = 'DWARF_RAW_TELE_C 19_EXP_30_GAIN_60_2026-10-31-23-02-46-765';

/** Metres → degrees of latitude, close enough for fixtures. */
const northOf = (lat: number, metres: number) => lat + metres / 111_195;

const roots: string[] = [];
const tmpFiles: string[] = [];

afterAll(() => {
  vi.unstubAllGlobals();
  for (const r of [...roots, ...tmpFiles]) fs.rmSync(r, { recursive: true, force: true });
  // The database file stays open until the worker exits, so on Windows its
  // folder cannot be removed here; .test-tmp is swept between runs.
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* EBUSY on Windows */ }
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  for (const t of ['libraryObjects', 'libraryFiles', 'librarySources', 'librarySessions', 'notes']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  for (const s of listSites()) deleteSite(s.id);
  db.prepare('DELETE FROM observingSites').run();
  createSite({ name: 'Home', latitude: HOME.lat, longitude: HOME.lon, isDefault: true });
  ensureLibraryDir();
});

/** A DWARF FITS header as the telescope writes it: no SITELAT/SITELONG. */
function dwarfFits(extra: Array<[string, string]> = []): Buffer {
  const card = (key: string, value: string) => (key.padEnd(8) + '= ' + value.padStart(20)).padEnd(80);
  const cards = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', '16'), card('NAXIS2', '16'),
    card('TELESCOP', "'DWARF 3 '"),
    ...extra.map(([k, v]) => card(k, v)),
    'END'.padEnd(80),
  ].join('');
  return Buffer.from(cards.padEnd(Math.ceil(cards.length / 2880) * 2880), 'ascii');
}

/** A linked root holding one DWARF observation folder, laid out like the device's. */
function makeDwarfRoot(opts: { jpeg?: Buffer | null; folder?: string; fitsExtra?: Array<[string, string]> } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-dwarf-gps-'));
  roots.push(root);
  addDwarfFolder(root, opts);
  return root;
}

function addDwarfFolder(root: string, opts: { jpeg?: Buffer | null; folder?: string; fitsExtra?: Array<[string, string]> } = {}): string {
  const dir = path.join(root, OBJECT_ID, opts.folder ?? FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (opts.folder ?? FOLDER).match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/)!;
  const ts = `${stamp[1]}${stamp[2]}${stamp[3]}-${stamp[4]}${stamp[5]}${stamp[6]}000`;
  fs.writeFileSync(path.join(dir, `stacked-16_C 19_30s60_Duo-Band_${ts}.fits`), dwarfFits(opts.fitsExtra));
  fs.writeFileSync(path.join(dir, 'shotsInfo.json'), JSON.stringify({ target: 'C 19', exp: '30', gain: 60, ir: 'Duo-Band' }));
  const jpeg = opts.jpeg === undefined ? geotaggedJpeg(GPS) : opts.jpeg;
  if (jpeg) fs.writeFileSync(path.join(dir, 'stacked.jpg'), jpeg);
  return dir;
}

const cached = () => db
  .prepare<[string, string], { lat: number | null; lon: number | null; coordsResolved: number; coordsSource: string | null; elevationM: number | null }>(
    'SELECT lat, lon, coordsResolved, coordsSource, elevationM FROM librarySessions WHERE objectId = ? AND date = ?',
  )
  .get(OBJECT_ID, NIGHT);

describe('readJpegGps', () => {
  const write = (buf: Buffer) => {
    const p = path.join(os.tmpdir(), `nebulis-gps-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(p, buf);
    tmpFiles.push(p);
    return p;
  };

  it('reads a DWARF-style N/W position with altitude', () => {
    expect(readJpegGps(write(geotaggedJpeg(GPS)))).toEqual({ lat: 41.5, lon: -2.25, altM: 900 });
  });

  it('signs S and E correctly', () => {
    expect(readJpegGps(write(geotaggedJpeg({ lat: -33.75, lon: 151.25 })))).toMatchObject({ lat: -33.75, lon: 151.25 });
  });

  it('reads a big-endian (MM) TIFF block', () => {
    expect(readJpegGps(write(geotaggedJpeg({ ...GPS, bigEndian: true })))).toEqual({ lat: 41.5, lon: -2.25, altM: 900 });
  });

  it('keeps whole-second precision', () => {
    // 40°12'34" N, 3°41'05" W
    const got = readJpegGps(write(geotaggedJpeg({ lat: 40 + 12 / 60 + 34 / 3600, lon: -(3 + 41 / 60 + 5 / 3600) })))!;
    expect(got.lat).toBeCloseTo(40.209444, 6);
    expect(got.lon).toBeCloseTo(-3.684722, 6);
  });

  it('returns null for EXIF with no GPS IFD (older DWARF firmware)', () => {
    expect(readJpegGps(write(geotaggedJpeg(null)))).toBeNull();
  });

  it('returns null for the (0, 0) no-fix value', () => {
    expect(parseExifGps(exifTiff({ lat: 0, lon: 0 }))).toBeNull();
  });

  it('returns null for a truncated file, a non-JPEG and a missing file', () => {
    const full = geotaggedJpeg(GPS);
    expect(readJpegGps(write(full.subarray(0, 40)))).toBeNull();
    expect(readJpegGps(write(Buffer.from('not a jpeg at all')))).toBeNull();
    expect(readJpegGps(path.join(os.tmpdir(), 'nebulis-no-such-file.jpg'))).toBeNull();
  });
});

describe('linked DWARF folder: location from stacked.jpg', () => {
  it('a new link resolves the session to the GPS the DWARF recorded', async () => {
    await commitSource(makeDwarfRoot(), SETTINGS, { label: 'dwarf' });

    const loc = sessionLocation(OBJECT_ID, NIGHT);
    expect(loc).toMatchObject({
      lat: GPS.lat, lon: GPS.lon, source: 'exif', siteId: null,
      fileCoordsSource: 'exif', fileElevationM: 900, matchedSite: null,
    });
    expect(loc.site.isTransient).toBe(true);
    expect(cached()).toMatchObject({ lat: GPS.lat, lon: GPS.lon, coordsResolved: 1, coordsSource: 'exif', elevationM: 900 });
  });

  it('reaches the detail page and the world map', async () => {
    await commitSource(makeDwarfRoot(), SETTINGS, { label: 'dwarf' });

    const detail = getLocalObservationDetail(OBJECT_ID, NIGHT);
    expect(detail).toMatchObject({
      coordinates: { lat: GPS.lat, lon: GPS.lon },
      locationSource: 'exif',
      fileCoordinates: { lat: GPS.lat, lon: GPS.lon },
      fileCoordinatesSource: 'exif',
      fileElevationM: 900,
      matchedSite: null,
    });
    const onMap = getObservationLocations().find(o => o.objectId === OBJECT_ID && o.date === NIGHT);
    expect(onMap).toMatchObject({ lat: GPS.lat, lon: GPS.lon, source: 'fits' });
  });

  it('falls back to the default site for a stacked.jpg without GPS (older firmware)', async () => {
    await commitSource(makeDwarfRoot({ jpeg: geotaggedJpeg(null) }), SETTINGS, { label: 'dwarf' });
    expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({ lat: HOME.lat, lon: HOME.lon, source: 'site', fileCoords: null });
  });

  it('prefers a linked FITS SITELAT over the JPEG', async () => {
    const root = makeDwarfRoot({ fitsExtra: [['SITELAT', '45.25'], ['SITELONG', '7.5']] });
    await commitSource(root, SETTINGS, { label: 'dwarf' });
    expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({ lat: 45.25, lon: 7.5, source: 'fits', fileElevationM: null });
  });

  it('an explicit site tag still wins over the GPS', async () => {
    await commitSource(makeDwarfRoot(), SETTINGS, { label: 'dwarf' });
    const away = createSite({ name: 'Away', latitude: 10, longitude: 10 });
    reassignSessionSite(OBJECT_ID, NIGHT, away.id);
    expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({
      lat: 10, lon: 10, source: 'site', siteId: away.id, fileCoords: { lat: GPS.lat, lon: GPS.lon }, matchedSite: null,
    });
  });

  it('a refresh picks up a stacked.jpg that appeared after the link', async () => {
    const root = makeDwarfRoot({ jpeg: null });
    const { sourceId } = await commitSource(root, SETTINGS, { label: 'dwarf' });
    expect(sessionLocation(OBJECT_ID, NIGHT).source).toBe('site');
    expect(cached()).toMatchObject({ lat: null, coordsResolved: 1 });

    fs.writeFileSync(path.join(root, OBJECT_ID, FOLDER, 'stacked.jpg'), geotaggedJpeg(GPS));
    await rescanSource(sourceId, SETTINGS);

    await vi.waitFor(() => {
      expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({ source: 'exif', lat: GPS.lat, lon: GPS.lon });
    }, { timeout: 5000 });
  });

  it('does not cache "no location" while the linked drive is unreachable', async () => {
    const root = makeDwarfRoot();
    await commitSource(root, SETTINGS, { label: 'dwarf' });
    db.prepare('UPDATE librarySessions SET coordsResolved = 0, lat = NULL, lon = NULL').run();

    const parked = `${root}-offline`;
    fs.renameSync(root, parked);
    try {
      expect(sessionLocation(OBJECT_ID, NIGHT).source).toBe('site');
      expect(cached()).toMatchObject({ coordsResolved: 0 });
    } finally {
      fs.renameSync(parked, root);
    }
    expect(sessionLocation(OBJECT_ID, NIGHT).source).toBe('exif');
  });

  it('two folders of one night far apart: the first decides', async () => {
    const root = makeDwarfRoot();
    addDwarfFolder(root, {
      folder: 'DWARF_RAW_TELE_C 19_EXP_60_GAIN_60_2026-10-31-23-40-00-000',
      jpeg: geotaggedJpeg({ lat: 42.5, lon: -2.25, altM: 300 }),
    });
    await commitSource(root, SETTINGS, { label: 'dwarf' });
    expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({ lat: GPS.lat, lon: GPS.lon, source: 'exif' });
  });
});

describe('matching a saved observing site within 50 m', () => {
  it('measures distances sensibly', () => {
    expect(distanceMeters({ lat: 41.5, lon: -2.25 }, { lat: northOf(41.5, 30), lon: -2.25 })).toBeCloseTo(30, 0);
    expect(SITE_MATCH_RADIUS_M).toBe(50);
  });

  it('resolves to a saved site 30 m away, with its own settings', async () => {
    const obs = createSite({ name: 'Observatory', latitude: northOf(GPS.lat, 30), longitude: GPS.lon, bortleClass: 3 });
    await commitSource(makeDwarfRoot(), SETTINGS, { label: 'dwarf' });

    const loc = sessionLocation(OBJECT_ID, NIGHT);
    expect(loc).toMatchObject({
      source: 'site', siteId: null, lat: obs.latitude, lon: obs.longitude,
      fileCoords: { lat: GPS.lat, lon: GPS.lon }, fileCoordsSource: 'exif',
      matchedSite: { id: obs.id, name: 'Observatory' },
    });
    expect(loc.site.id).toBe(obs.id);
    expect(loc.site.isTransient).toBeFalsy();
    expect(loc.matchedSite!.distanceM).toBeGreaterThanOrEqual(29);
    expect(loc.matchedSite!.distanceM).toBeLessThanOrEqual(31);

    // Not written into siteId: a match stays the files' decision.
    const row = db.prepare('SELECT siteId FROM librarySessions WHERE objectId = ? AND date = ?').get(OBJECT_ID, NIGHT) as { siteId: string | null };
    expect(row.siteId).toBeNull();
    expect(getLocalObservationDetail(OBJECT_ID, NIGHT)).toMatchObject({ locationLabel: 'Observatory', siteId: null, matchedSite: { id: obs.id } });
    expect(getObservationLocations().find(o => o.objectId === OBJECT_ID)).toMatchObject({ source: 'fits' });
  });

  it('keeps the transient site when the nearest saved site is 70 m away', async () => {
    createSite({ name: 'Neighbour', latitude: northOf(GPS.lat, 70), longitude: GPS.lon });
    await commitSource(makeDwarfRoot(), SETTINGS, { label: 'dwarf' });
    expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({ source: 'exif', matchedSite: null, lat: GPS.lat });
  });

  it('picks the nearest of two sites within the radius', () => {
    createSite({ name: 'Far', latitude: northOf(GPS.lat, 45), longitude: GPS.lon });
    const near = createSite({ name: 'Near', latitude: northOf(GPS.lat, 10), longitude: GPS.lon });
    expect(nearestSiteWithin(GPS)?.site.id).toBe(near.id);
  });

  it('an explicit tag outranks the match', async () => {
    createSite({ name: 'Observatory', latitude: northOf(GPS.lat, 20), longitude: GPS.lon });
    await commitSource(makeDwarfRoot(), SETTINGS, { label: 'dwarf' });
    const away = createSite({ name: 'Away', latitude: 10, longitude: 10 });
    reassignSessionSite(OBJECT_ID, NIGHT, away.id);
    expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({ siteId: away.id, matchedSite: null, lat: 10 });
  });

  it('a site created after the link is picked up on the next read, no rescan', async () => {
    await commitSource(makeDwarfRoot(), SETTINGS, { label: 'dwarf' });
    expect(sessionLocation(OBJECT_ID, NIGHT).matchedSite).toBeNull();
    const later = createSite({ name: 'New observatory', latitude: northOf(GPS.lat, 15), longitude: GPS.lon });
    expect(sessionLocation(OBJECT_ID, NIGHT).matchedSite).toMatchObject({ id: later.id });
  });

  it('also matches FITS coordinates in the managed-library sense (any file source)', async () => {
    const obs = createSite({ name: 'Observatory', latitude: 45.25, longitude: 7.5 });
    await commitSource(makeDwarfRoot({ jpeg: null, fitsExtra: [['SITELAT', '45.2502'], ['SITELONG', '7.5']] }), SETTINGS, { label: 'dwarf' });
    expect(sessionLocation(OBJECT_ID, NIGHT)).toMatchObject({ matchedSite: { id: obs.id }, fileCoordsSource: 'fits' });
  });
});
