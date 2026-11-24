/**
 * Where a session was captured from.
 *
 * This is the single seam every location-dependent read of an observation goes
 * through: the detail page's map, the world map, and the historical weather
 * lookup. It exists because those three used to answer the question separately
 * and drifted apart, which is how a session whose files plainly recorded Destin
 * came to be displayed, mapped, and weather-reported as Franklin.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 *
 *  1. An explicit `siteId` on the session. A deliberate user statement about
 *     where the telescope was, so it outranks the files: scopes with an unset
 *     or wrong GPS do exist, and retagging is how the user corrects them.
 *  2. A saved observing site within SITE_MATCH_RADIUS_M of the coordinates the
 *     files recorded. The files say where the scope stood; when that is the
 *     user's own observatory, the session gets that site's real horizon,
 *     timezone and sky settings rather than a nameless transient copy of the
 *     default site's. Resolved on read, never written into `siteId`: a match is
 *     a guess, and storing it would turn it into a user decision that outranks
 *     the files forever. Reading it fresh also means a site created or moved
 *     later picks up its past sessions with no migration.
 *  3. The coordinates the capture files recorded. Returned as a *transient*
 *     site, so a one-off trip needs no configured observing site. This is the
 *     case a site list can never cover: you image somewhere once and are not
 *     going to create a saved location for it.
 *  4. The default site, which is what every session resolved to before any of
 *     this existed.
 *
 * `siteId = NULL` therefore means "let the files decide, and fall back to the
 * default", not "the default site".
 *
 * ── Which files ─────────────────────────────────────────────────────────────
 *
 *  - FITS SITELAT/SITELONG (or OBS-LAT/OBS-LONG) from the managed library, as
 *    before, then from the session's linked files.
 *  - The EXIF GPS block of a linked DWARF `stacked.jpg`. A DWARF 3 writes no
 *    observer position into its FITS, but geotags that preview JPEG (firmware
 *    1.5.x on). See exifGps.ts.
 *
 * ── What is cached and what is not ──────────────────────────────────────────
 *
 * The file coordinates are cached on `librarySessions` (lat/lon/coordsSource/
 * elevationM/coordsResolved) because they are an immutable fact about bytes on
 * disk. The site match and the site fallback are NOT cached: they are mutable
 * user configuration, so retagging a session or editing a site's coordinates
 * has to take effect on the next read.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { parseFilename } from '../telescopeFiles.js';
import { parseFitsHeader } from '../fitsParser.js';
import { resolveContainedObjectDir } from './objects.js';
import { listObjectFiles, getObjectLayout } from './libraryLayout.js';
import { resolverFor, getLibraryFilesForObject, sessionDateForRow, type LibraryFileRow } from './libraryFiles.js';
import { resolveLibraryFile } from './fileResolver.js';
import { readJpegGps } from './exifGps.js';
import { getSite, getDefaultSite, listSites, type ObservingSite } from '../observingSites.js';
import { log } from '../logger.js';

/** A saved site this close to the file coordinates is taken to be where the
 *  session was shot. A DWARF writes whole arc-seconds (~31 m of latitude), so
 *  its rounding alone can put a reading ~20 m off the true spot. */
export const SITE_MATCH_RADIUS_M = 50;

/** Two folders of the same night further apart than this are worth a warning. */
const FOLDER_DISAGREEMENT_M = 1000;

/** Which file the coordinates came from: a FITS header, or a JPEG's EXIF GPS. */
export type FileCoordsSource = 'fits' | 'exif';

/** Where the coordinates came from. Surfaced to clients so the UI can say
 *  "this is what the camera recorded" rather than implying the user chose it.
 *  'site' covers both an explicit tag and a saved site matched by proximity
 *  (see `matchedSite`). */
export type SessionLocationSource = FileCoordsSource | 'site';

export interface FileCoords {
  lat: number;
  lon: number;
  source: FileCoordsSource;
  /** Metres above sea level, when the file recorded it. */
  elevationM: number | null;
}

export interface SessionLocation {
  /** Null only when the resolved site has no coordinates configured. */
  lat: number | null;
  lon: number | null;
  source: SessionLocationSource;
  /** The site whose sky settings apply, and which weather is fetched for.
   *  Transient (never persisted) when the coordinates came from the files. */
  site: ObservingSite;
  /** The explicit tag, when the user set one. Null means "let the files decide". */
  siteId: string | null;
  /** What the capture files recorded, reported even when a site tag outranks it.
   *  Without this the UI could not offer "go back to what the image says" once a
   *  session had been tagged, making the tag a one-way door. */
  fileCoords: { lat: number; lon: number } | null;
  /** Which kind of file `fileCoords` came from. */
  fileCoordsSource: FileCoordsSource | null;
  /** Elevation the files recorded, in metres. */
  fileElevationM: number | null;
  /** Set when the session is untagged and a saved site lies within
   *  SITE_MATCH_RADIUS_M of `fileCoords`: the site the files resolved to, and
   *  how far from the recorded position it is. */
  matchedSite: { id: string; name: string; distanceM: number } | null;
}

interface CachedCoordsRow {
  lat: number | null;
  lon: number | null;
  coordsResolved: number;
  coordsSource: string | null;
  elevationM: number | null;
}

const stmts = {
  read: db.prepare<[string, string], CachedCoordsRow & { siteId: string | null }>(
    'SELECT lat, lon, coordsResolved, coordsSource, elevationM, siteId FROM librarySessions WHERE objectId = ? AND date = ?',
  ),
  writeCoords: db.prepare<[number | null, number | null, string | null, number | null, string, string]>(
    'UPDATE librarySessions SET lat = ?, lon = ?, coordsSource = ?, elevationM = ?, coordsResolved = 1 WHERE objectId = ? AND date = ?',
  ),
};

// FITS headers come in 2880-byte blocks; ten blocks covers the primary header
// of every telescope we've seen. Matches the read size in dateDerivation.ts.
const FITS_HEADER_BYTES = 28800;

/**
 * Read observer coordinates from a FITS header.
 * Returns null when the file carries no usable SITELAT/SITELONG.
 */
export function readFitsCoords(fitsPath: string): { lat: number; lon: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(fitsPath, 'r');
    const buf = Buffer.alloc(FITS_HEADER_BYTES);
    const read = fs.readSync(fd, buf, 0, FITS_HEADER_BYTES, 0);
    if (read < 80) return null;
    const header = parseFitsHeader(read === FITS_HEADER_BYTES ? buf : buf.subarray(0, read));
    const lat = header.values['OBS-LAT'] ?? header.values['SITELAT'] ?? null;
    const lon = header.values['OBS-LONG'] ?? header.values['SITELONG'] ?? null;
    if (lat === null || lon === null) return null;
    const latNum = typeof lat === 'number' ? lat : parseFloat(String(lat));
    const lonNum = typeof lon === 'number' ? lon : parseFloat(String(lon));
    if (isNaN(latNum) || isNaN(lonNum)) return null;
    if (latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) return null;
    // Exactly (0, 0) is the "GPS not acquired" sentinel some scopes write, not a
    // real observing site in the Gulf of Guinea.
    if (latNum === 0 && lonNum === 0) return null;
    return { lat: latNum, lon: lonNum };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/** Great-circle distance in metres (haversine, mean Earth radius). */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest saved site within `radiusM` of `coords`, or null. */
export function nearestSiteWithin(
  coords: { lat: number; lon: number },
  radiusM: number = SITE_MATCH_RADIUS_M,
): { site: ObservingSite; distanceM: number } | null {
  let best: { site: ObservingSite; distanceM: number } | null = null;
  for (const site of listSites()) {
    if (site.latitude === null || site.longitude === null) continue;
    const d = distanceMeters(coords, { lat: site.latitude, lon: site.longitude });
    if (d <= radiusM && (best === null || d < best.distanceM)) best = { site, distanceM: d };
  }
  return best;
}

const isFitsName = (name: string) => /\.fits?$/i.test(name);
const isJpegName = (name: string) => /\.jpe?g$/i.test(name);

/** The DWARF's geotagged preview: `stacked.jpg` in each observation folder. Any
 *  other linked stacked/preview JPEG is tried after it, since a geotag in one is
 *  just as true; a thumbnail never is (it is a scaled copy without EXIF). */
function jpegRank(row: LibraryFileRow): number | null {
  if (!isJpegName(row.fileName)) return null;
  if (row.fileName.toLowerCase() === 'stacked.jpg') return 0;
  if (row.role === 'preview' || row.role === 'stacked') return parseFilename(row.fileName).isThumbnail ? null : 1;
  return null;
}

/**
 * Coordinates from the session's linked files. `unreachable` is true when a
 * candidate file could not be found on disk (a linked drive that is not
 * mounted), so the caller does not cache a "no coordinates" that is really
 * "could not look".
 */
function linkedFileCoords(objectId: string, date: string): { coords: FileCoords | null; unreachable: boolean } {
  const rows = getLibraryFilesForObject(objectId)
    .filter(row => row.sourceId !== null && !row.missingSince && sessionDateForRow(row) === date)
    .sort((a, b) => `${a.captureDate ?? ''} ${a.captureTime ?? ''} ${a.relPath}`
      .localeCompare(`${b.captureDate ?? ''} ${b.captureTime ?? ''} ${b.relPath}`));
  let unreachable = false;
  const abs = (row: LibraryFileRow): string | null => {
    const resolved = resolveLibraryFile(row.relPath);
    if (!resolved || !fs.existsSync(resolved.abs)) { unreachable = true; return null; }
    return resolved.abs;
  };

  // A FITS position first, as for the managed library: one header is enough,
  // every frame of a night carries the same site.
  const fits = rows.find(row => isFitsName(row.fileName) && !parseFilename(row.fileName).isThumbnail);
  if (fits) {
    const p = abs(fits);
    const c = p ? readFitsCoords(p) : null;
    if (c) return { coords: { ...c, source: 'fits', elevationM: null }, unreachable };
  }

  // Then the EXIF GPS of the night's stacked JPEGs. One night can span several
  // DWARF folders (a 30 s and a 60 s run); the first geotagged one, by capture
  // time, decides, and a second one far away is logged rather than splitting
  // the session.
  const jpegs = rows
    .map(row => ({ row, rank: jpegRank(row) }))
    .filter((x): x is { row: LibraryFileRow; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank);
  let first: FileCoords | null = null;
  for (const { row } of jpegs) {
    const p = abs(row);
    const gps = p ? readJpegGps(p) : null;
    if (!gps) continue;
    if (!first) {
      first = { lat: gps.lat, lon: gps.lon, source: 'exif', elevationM: gps.altM };
      continue;
    }
    const apart = distanceMeters(first, gps);
    if (apart > FOLDER_DISAGREEMENT_M) {
      log.warn(
        { objectId, date, file: row.relPath, apartM: Math.round(apart) },
        '[session-location] folders of the same night record different GPS positions; using the first',
      );
      break;
    }
  }
  return { coords: first, unreachable };
}

/** Managed-library FITS coordinates (the files Nebulis copied in). */
function managedFitsCoords(objectId: string, date: string): { lat: number; lon: number } | null {
  // Contained resolution: this reads a FITS header off disk, so a traversal id
  // must resolve to nothing rather than to an arbitrary file elsewhere on the
  // host (and write a sessionLocation row built from it).
  const objDir = resolveContainedObjectDir(objectId);
  if (!objDir) return null;
  const identity = resolverFor(objectId);
  for (const entry of listObjectFiles(objDir, getObjectLayout(objectId))) {
    const parsed = parseFilename(entry.fileName);
    if (parsed.isThumbnail) continue;
    const ext = parsed.extension?.toLowerCase();
    if (ext !== '.fit' && ext !== '.fits') continue;
    if (identity.session(entry.relPath) !== date) continue;
    return readFitsCoords(path.join(objDir, entry.relPath));
  }
  return null;
}

function fromCache(row: CachedCoordsRow): FileCoords | null {
  // Ignore the legacy (0, 0) sentinel that older caches may hold.
  if (row.lat === null || row.lon === null || (row.lat === 0 && row.lon === 0)) return null;
  return {
    lat: row.lat,
    lon: row.lon,
    source: row.coordsSource === 'exif' ? 'exif' : 'fits',
    elevationM: row.elevationM ?? null,
  };
}

/**
 * The coordinates this session's own files recorded, or null.
 *
 * Cache-first: only the first look at a session opens a file. The managed walk
 * goes through listObjectFiles rather than a flat readdir because a nested
 * object keeps its files a level down inside a session folder, and a flat read
 * finds none of them. Linked files are found through their `libraryFiles` rows.
 */
export function fileCoordsForSession(
  objectId: string,
  date: string,
  cached?: CachedCoordsRow,
): FileCoords | null {
  const row = cached ?? stmts.read.get(objectId, date);
  if (row && row.coordsResolved === 1) return fromCache(row);

  const managed = managedFitsCoords(objectId, date);
  let coords: FileCoords | null = managed ? { ...managed, source: 'fits', elevationM: null } : null;
  let unreachable = false;
  if (!coords) {
    const linked = linkedFileCoords(objectId, date);
    coords = linked.coords;
    unreachable = linked.unreachable;
  }

  // A linked drive that is not mounted is "could not look", not "no location":
  // caching null would hide the GPS for good once the drive is back.
  if (coords || !unreachable) {
    // Best-effort cache write (a session with no row yet simply updates nothing).
    try {
      stmts.writeCoords.run(coords?.lat ?? null, coords?.lon ?? null, coords?.source ?? null, coords?.elevationM ?? null, objectId, date);
    } catch { /* best-effort */ }
  }
  return coords;
}

/** FITS-or-EXIF coordinates without the source, for existing callers. */
export function fitsCoordsForSession(
  objectId: string,
  date: string,
  cached?: CachedCoordsRow,
): { lat: number; lon: number } | null {
  const c = fileCoordsForSession(objectId, date, cached);
  return c ? { lat: c.lat, lon: c.lon } : null;
}

/**
 * Forget the cached "no coordinates" of these sessions, so the next read looks
 * at their files again. Called by a linked-folder refresh: a `stacked.jpg` the
 * DWARF wrote after the first scan, or a drive that was offline then, must get
 * its chance. Sessions that did resolve keep their value (a fact about bytes).
 */
export function clearUnresolvedCoords(objectId: string): number {
  return db
    .prepare('UPDATE librarySessions SET coordsResolved = 0 WHERE objectId = ? AND coordsResolved = 1 AND lat IS NULL')
    .run(objectId).changes;
}

/**
 * Post-import stage: read the file coordinates of every session of an object
 * now, so a freshly linked or refreshed folder shows its location (and fetches
 * its weather there) without waiting for someone to open the session. A linked
 * refresh first forgets the sessions that found nothing last time: the DWARF may
 * have written its stacked.jpg since, or the drive may have been offline.
 * Returns how many sessions have file coordinates.
 */
export function resolveObjectSessionCoords(objectId: string, opts: { recheckUnresolved: boolean }): number {
  if (opts.recheckUnresolved) clearUnresolvedCoords(objectId);
  const dates = db
    .prepare<[string], { date: string }>('SELECT date FROM librarySessions WHERE objectId = ?')
    .all(objectId);
  let found = 0;
  for (const { date } of dates) {
    if (date === 'unknown') continue;
    if (fileCoordsForSession(objectId, date)) found++;
  }
  return found;
}

/**
 * A site that exists only for this lookup, carrying coordinates the files
 * recorded. Sky settings are inherited from `base` because the type requires
 * them and the user's own horizon is the least-wrong stand-in, but they
 * describe `base`, not this place: treat anything other than the coordinates as
 * nominal. Mirrors the transient site `resolveSite` builds for ad-hoc GPS.
 */
function transientSiteFor(lat: number, lon: number, base: ObservingSite): ObservingSite {
  return {
    ...base,
    id: `transient:${lat},${lon}`,
    name: 'From image data',
    latitude: lat,
    longitude: lon,
    // The files may be from anywhere, so the base site's timezone would be
    // wrong. Callers resolve one from the coordinates when this is blank.
    timezone: '',
    isDefault: false,
    isTransient: true,
  };
}

/** True when the location was decided by the session's own files (directly, or
 *  through a saved site they matched), not by a tag or the default site. */
export function resolvedFromFiles(location: SessionLocation): boolean {
  return location.source !== 'site' || location.matchedSite !== null;
}

/** Resolve where a session was captured from. See the module doc for precedence. */
export function sessionLocation(objectId: string, date: string): SessionLocation {
  const row = stmts.read.get(objectId, date);
  const file = fileCoordsForSession(objectId, date, row);
  const fileInfo = {
    fileCoords: file ? { lat: file.lat, lon: file.lon } : null,
    fileCoordsSource: file?.source ?? null,
    fileElevationM: file?.elevationM ?? null,
  };

  const tagged = row?.siteId ? getSite(row.siteId) : null;
  if (tagged) {
    return {
      lat: tagged.latitude,
      lon: tagged.longitude,
      source: 'site',
      site: tagged,
      siteId: tagged.id,
      ...fileInfo,
      matchedSite: null,
    };
  }

  if (file) {
    const near = nearestSiteWithin(file);
    if (near) {
      return {
        lat: near.site.latitude,
        lon: near.site.longitude,
        source: 'site',
        site: near.site,
        siteId: null,
        ...fileInfo,
        matchedSite: { id: near.site.id, name: near.site.name, distanceM: Math.round(near.distanceM) },
      };
    }
    return {
      lat: file.lat,
      lon: file.lon,
      source: file.source,
      site: transientSiteFor(file.lat, file.lon, getDefaultSite()),
      siteId: null,
      ...fileInfo,
      matchedSite: null,
    };
  }

  const defaultSite = getDefaultSite();
  return {
    lat: defaultSite.latitude,
    lon: defaultSite.longitude,
    source: 'site',
    site: defaultSite,
    siteId: null,
    ...fileInfo,
    matchedSite: null,
  };
}
