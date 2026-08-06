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
 *  2. The coordinates the capture files recorded (FITS SITELAT/SITELONG).
 *     Returned as a *transient* site, so a one-off trip needs no configured
 *     observing site. This is the case a site list can never cover: you image
 *     somewhere once and are not going to create a saved location for it.
 *  3. The default site, which is what every session resolved to before any of
 *     this existed.
 *
 * `siteId = NULL` therefore means "let the files decide, and fall back to the
 * default", not "the default site". No migration is needed for that change of
 * meaning: a session with no FITS coordinates still lands on the default site,
 * exactly as before.
 *
 * ── What is cached and what is not ──────────────────────────────────────────
 *
 * The FITS coordinates are cached on `librarySessions` (lat/lon/coordsResolved)
 * because they are an immutable fact about bytes on disk. The site fallback is
 * NOT cached: it is mutable user configuration, so retagging a session or
 * editing a site's coordinates has to take effect on the next read.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { parseFilename } from '../telescopeFiles.js';
import { parseFitsHeader } from '../fitsParser.js';
import { getFolderName } from './objects.js';
import { listObjectFiles, getObjectLayout } from './libraryLayout.js';
import { resolverFor } from './libraryFiles.js';
import { getSite, getDefaultSite, type ObservingSite } from '../observingSites.js';

/** Where the coordinates came from. Surfaced to clients so the UI can say
 *  "this is what the camera recorded" rather than implying the user chose it. */
export type SessionLocationSource = 'fits' | 'site';

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
}

const stmts = {
  read: db.prepare<[string, string], {
    lat: number | null;
    lon: number | null;
    coordsResolved: number;
    siteId: string | null;
  }>('SELECT lat, lon, coordsResolved, siteId FROM librarySessions WHERE objectId = ? AND date = ?'),
  writeCoords: db.prepare<[number | null, number | null, string, string]>(
    'UPDATE librarySessions SET lat = ?, lon = ?, coordsResolved = 1 WHERE objectId = ? AND date = ?',
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

/**
 * The coordinates this session's own files recorded, or null.
 *
 * Cache-first: only the first look at a session opens a file. The walk goes
 * through listObjectFiles rather than a flat readdir because a nested object
 * keeps its files a level down inside a session folder, and a flat read finds
 * none of them.
 */
export function fitsCoordsForSession(
  objectId: string,
  date: string,
  cached?: { lat: number | null; lon: number | null; coordsResolved: number },
): { lat: number; lon: number } | null {
  const row = cached ?? stmts.read.get(objectId, date);
  if (row && row.coordsResolved === 1) {
    // Ignore the legacy (0, 0) sentinel that older caches may hold.
    if (row.lat !== null && row.lon !== null && !(row.lat === 0 && row.lon === 0)) {
      return { lat: row.lat, lon: row.lon };
    }
    return null;
  }

  const objDir = path.join(getLibraryDir(), getFolderName(objectId));
  const identity = resolverFor(objectId);
  let firstFits: string | null = null;
  for (const entry of listObjectFiles(objDir, getObjectLayout(objectId))) {
    const parsed = parseFilename(entry.fileName);
    if (parsed.isThumbnail) continue;
    const ext = parsed.extension?.toLowerCase();
    if (ext !== '.fit' && ext !== '.fits') continue;
    if (identity.session(entry.relPath) !== date) continue;
    firstFits = entry.relPath;
    break;
  }

  const coords = firstFits ? readFitsCoords(path.join(objDir, firstFits)) : null;
  // Best-effort cache write (a session with no row yet simply updates nothing).
  try { stmts.writeCoords.run(coords?.lat ?? null, coords?.lon ?? null, objectId, date); } catch { /* best-effort */ }
  return coords;
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

/** Resolve where a session was captured from. See the module doc for precedence. */
export function sessionLocation(objectId: string, date: string): SessionLocation {
  const row = stmts.read.get(objectId, date);
  const fileCoords = fitsCoordsForSession(objectId, date, row);

  const tagged = row?.siteId ? getSite(row.siteId) : null;
  if (tagged) {
    return {
      lat: tagged.latitude,
      lon: tagged.longitude,
      source: 'site',
      site: tagged,
      siteId: tagged.id,
      fileCoords,
    };
  }

  if (fileCoords) {
    return {
      lat: fileCoords.lat,
      lon: fileCoords.lon,
      source: 'fits',
      site: transientSiteFor(fileCoords.lat, fileCoords.lon, getDefaultSite()),
      siteId: null,
      fileCoords,
    };
  }

  const defaultSite = getDefaultSite();
  return {
    lat: defaultSite.latitude,
    lon: defaultSite.longitude,
    source: 'site',
    site: defaultSite,
    siteId: null,
    fileCoords,
  };
}
