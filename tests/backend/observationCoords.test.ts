import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Mirrors nestedLayout.test.ts.
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-obscoords-test-'));
});

import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { getLocalObservationDetail, getObservationLocations } from '../../server/lib/library/observations';
import { sessionLocation } from '../../server/lib/library/sessionLocation';
import { setObjectLayout } from '../../server/lib/library/libraryLayout';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { createSite, deleteSite } from '../../server/lib/observingSites';

/** The observing site recorded in the FITS header: Destin, FL. */
const FITS_LAT = 30.3774;
const FITS_LON = -86.38;
/** The default site, deliberately somewhere else: Franklin, TN. */
const SITE_LAT = 35.9045;
const SITE_LON = -86.8317;

const OBJECT_ID = 'IC353';
const DATE = '2024-10-08';
const SESSION_FOLDER = '2024-10-08_00-00-00';
const FITS_NAME = 'Stacked_48_IC 353_10.0s_LP_20241009-062418.fit';

/** A minimal but genuinely parseable FITS primary header carrying an observing
 *  site. Written to disk so the coordinate readers do real file I/O. */
function fitsWithSite(lat: number, lon: number): Buffer {
  const card = (key: string, value: string) =>
    (key.padEnd(8) + '= ' + value.padStart(20)).padEnd(80);
  const cards = [
    card('SIMPLE', 'T'),
    card('BITPIX', '16'),
    card('NAXIS', '2'),
    card('NAXIS1', '1080'),
    card('NAXIS2', '1920'),
    card('SITELAT', String(lat)),
    card('SITELONG', String(lon)),
    'END'.padEnd(80),
  ].join('');
  // FITS headers are padded to a whole 2880-byte block.
  return Buffer.from(cards.padEnd(Math.ceil(cards.length / 2880) * 2880), 'ascii');
}

/**
 * A nested-layout object with one session, exactly as the importer lays it out:
 * the FITS file lives one level down, inside a session folder.
 */
function seedNestedSession(): void {
  const sessionDir = path.join(LIBRARY_DIR, OBJECT_ID, SESSION_FOLDER);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, FITS_NAME), fitsWithSite(FITS_LAT, FITS_LON));

  db.prepare(
    'INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 1, ?)',
  ).run(OBJECT_ID, OBJECT_ID, new Date().toISOString());
  setObjectLayout(OBJECT_ID, 'nested');
  db.prepare('INSERT OR IGNORE INTO librarySessions (objectId, date) VALUES (?, ?)').run(OBJECT_ID, DATE);
  recordLibraryFile({
    objectId: OBJECT_ID,
    folderName: OBJECT_ID,
    sessionFolder: SESSION_FOLDER,
    fileName: FITS_NAME,
    role: 'stacked',
    sessionDateOverride: DATE,
  });
}

describe('observation coordinates for a nested-layout object', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM librarySessions').run();
    db.prepare('DELETE FROM libraryObjects').run();
    db.prepare('DELETE FROM observingSites').run();
    fs.rmSync(path.join(LIBRARY_DIR, OBJECT_ID), { recursive: true, force: true });

    createSite({ name: 'Franklin, Tennessee', latitude: SITE_LAT, longitude: SITE_LON, isDefault: true });
    seedNestedSession();
  });

  it('reads the detail page location from the FITS header, not the default site', () => {
    const detail = getLocalObservationDetail(OBJECT_ID, DATE);
    expect(detail.coordinates).toEqual({ lat: FITS_LAT, lon: FITS_LON });
  });

  it('reads the map location from the FITS header, not the default site', () => {
    const entry = getObservationLocations().find(o => o.objectId === OBJECT_ID && o.date === DATE);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ lat: FITS_LAT, lon: FITS_LON, source: 'fits' });
  });

  it('caches the FITS coordinates on the session so the file is read once', () => {
    getObservationLocations();
    const cached = db
      .prepare('SELECT lat, lon, coordsResolved FROM librarySessions WHERE objectId = ? AND date = ?')
      .get(OBJECT_ID, DATE) as { lat: number | null; lon: number | null; coordsResolved: number };
    expect(cached).toEqual({ lat: FITS_LAT, lon: FITS_LON, coordsResolved: 1 });
  });

  it('falls back to the session site when the FITS file carries no location', () => {
    fs.writeFileSync(
      path.join(LIBRARY_DIR, OBJECT_ID, SESSION_FOLDER, FITS_NAME),
      // (0, 0) is the "GPS not acquired" sentinel, not a site in the Gulf of Guinea.
      fitsWithSite(0, 0),
    );
    const entry = getObservationLocations().find(o => o.objectId === OBJECT_ID && o.date === DATE);
    expect(entry).toMatchObject({ lat: SITE_LAT, lon: SITE_LON, source: 'settings' });
  });
});

/**
 * Precedence, which is the whole point of the seam: a deliberate site tag beats
 * the files (scopes with an unset or wrong GPS exist, and retagging is how the
 * user corrects them), and the files beat the default site (so imaging from
 * somewhere once does not require creating a saved location for it).
 */
describe('sessionLocation precedence', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM librarySessions').run();
    db.prepare('DELETE FROM libraryObjects').run();
    db.prepare('DELETE FROM observingSites').run();
    fs.rmSync(path.join(LIBRARY_DIR, OBJECT_ID), { recursive: true, force: true });

    createSite({ name: 'Franklin, Tennessee', latitude: SITE_LAT, longitude: SITE_LON, isDefault: true });
    seedNestedSession();
  });

  const tag = (siteId: string | null) =>
    db.prepare('UPDATE librarySessions SET siteId = ? WHERE objectId = ? AND date = ?')
      .run(siteId, OBJECT_ID, DATE);

  it('uses the FITS coordinates when the session is untagged', () => {
    const loc = sessionLocation(OBJECT_ID, DATE);
    expect(loc).toMatchObject({ lat: FITS_LAT, lon: FITS_LON, source: 'fits', siteId: null });
  });

  it('synthesizes a transient site so no saved location is needed', () => {
    const loc = sessionLocation(OBJECT_ID, DATE);
    expect(loc.site.isTransient).toBe(true);
    expect(loc.site.latitude).toBe(FITS_LAT);
    expect(loc.site.longitude).toBe(FITS_LON);
    // Never persisted: it must not show up alongside the user's real sites.
    const saved = db.prepare('SELECT COUNT(*) AS c FROM observingSites').get() as { c: number };
    expect(saved.c).toBe(1);
  });

  it('lets an explicit site tag override the FITS coordinates', () => {
    const dark = createSite({ name: 'Dark Site', latitude: 40, longitude: -80 });
    tag(dark.id);
    expect(sessionLocation(OBJECT_ID, DATE)).toMatchObject({
      lat: 40, lon: -80, source: 'site', siteId: dark.id,
    });
  });

  it('falls back through the files when a tag is cleared', () => {
    const dark = createSite({ name: 'Dark Site', latitude: 40, longitude: -80 });
    tag(dark.id);
    tag(null);
    expect(sessionLocation(OBJECT_ID, DATE)).toMatchObject({ lat: FITS_LAT, lon: FITS_LON, source: 'fits' });
  });

  it('degrades to the files when the tagged site was deleted', () => {
    const dark = createSite({ name: 'Dark Site', latitude: 40, longitude: -80 });
    tag(dark.id);
    deleteSite(dark.id);
    // The dangling siteId is left on the row on purpose: observation history is
    // never rewritten by a site deletion.
    expect(sessionLocation(OBJECT_ID, DATE)).toMatchObject({ lat: FITS_LAT, lon: FITS_LON, source: 'fits' });
  });

  it('uses the default site for a session that does not exist', () => {
    expect(sessionLocation('M999', '1999-01-01')).toMatchObject({
      lat: SITE_LAT, lon: SITE_LON, source: 'site',
    });
  });
});
