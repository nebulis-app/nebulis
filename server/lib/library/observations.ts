/**
 * Library — observation/session domain.
 *
 * Per-session queries (file lists, calendar entries, detail pages), session
 * mutations (delete/move), telescope reassignment, and historical weather
 * backfill from Open-Meteo.
 */
import fs from 'fs';
import path from 'path';
import { getLibraryDir } from '../libraryPath.js';
import db from '../db.js';
import { isErrnoException } from '../errors.js';
import {
  parseFilename,
  getFileCategory,
  isRealFile,
  isSidecarFile,
  sessionNightFor,
  rolloverDateUnconditional,
} from '../telescopeFiles.js';
import { getNote } from '../notes.js';
import { parseFitsHeader } from '../fitsParser.js';
import {
  stmts,
  getFolderName,
  resolveCatalogMeta,
  loadIndex,
  LIBRARY_API_BASE,
} from './objects.js';
import {
  resolverFor,
  deleteLibraryFileRow,
  getLibraryFileRow,
  moveLibraryFileRow,
  writeObjectManifest,
} from './libraryFiles.js';
import { listObjectFiles, getObjectLayout, setObjectLayout } from './libraryLayout.js';
import {
  deleteCaptureInfoForSession,
  getCaptureInfoForSession,
  summarizeSessionCapture,
} from './captureInfo.js';
import { getSite, getDefaultSite, siteForSession, type ObservingSite } from '../observingSites.js';

// ─── Session weather ────────────────────────────────────────────────────────

import type { SessionWeather } from '../types/session.js';
export type { SessionWeather };

/**
 * Fetch historical weather for a date from Open-Meteo's archive API.
 * Returns average conditions during nighttime hours (8 PM – 4 AM) for the date.
 * Returns null if the site has no coordinates or the API call fails.
 *
 * `site` is the observing site this *specific session* was captured from
 * (see siteForSession), not necessarily the currently-active one — weather is
 * historical fact about where the telescope was, and must stay correct even
 * after the user switches which site the planner points at.
 */
async function fetchSessionWeather(date: string, site: ObservingSite): Promise<SessionWeather | null> {
  const lat = site.latitude;
  const lon = site.longitude;
  if (lat == null || lon == null) return null;

  // Open-Meteo archive API covers past dates; forecast API covers recent/future
  const dateObj = new Date(date + 'T12:00:00Z');
  const now = new Date();
  const daysDiff = (now.getTime() - dateObj.getTime()) / 86400000;

  const params = [
    `latitude=${lat}`,
    `longitude=${lon}`,
    `start_date=${date}`,
    `end_date=${date}`,
    'hourly=cloud_cover,relative_humidity_2m,temperature_2m,dew_point_2m,wind_speed_10m,visibility,precipitation_probability',
    'timezone=auto',
  ].join('&');

  // Use archive API for dates > 5 days old, forecast API for recent
  const base = daysDiff > 5
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';

  try {
    const res = await fetch(`${base}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    // Narrow the Open-Meteo payload at the boundary. Each `hourly.<field>` is
    // expected to be an array of numbers parallel to `hourly.time`.
    const raw: unknown = await res.json();
    if (raw === null || typeof raw !== 'object' || !('hourly' in raw)) return null;
    const hourly = raw.hourly;
    if (hourly === null || typeof hourly !== 'object') return null;

    // Safely pluck a property from an unknown object — returns `unknown` so
    // callers have to narrow it themselves. No cast needed at the access site.
    const pluck = (obj: object, key: string): unknown =>
      key in obj ? (obj as Record<string, unknown>)[key] : undefined;

    const readStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    const readNumberArray = (v: unknown): Array<number | null> =>
      Array.isArray(v) ? v.map(n => typeof n === 'number' ? n : null) : [];

    const times = readStringArray(pluck(hourly, 'time'));
    if (times.length === 0) return null;

    // Average over nighttime hours (8 PM – 4 AM local, indices 20-23 and 0-3)
    let nightIndices = times
      .map((t, i) => ({ hour: new Date(t).getHours(), i }))
      .filter(({ hour }) => hour >= 20 || hour <= 3)
      .map(({ i }) => i);

    if (nightIndices.length === 0) {
      // Fallback: use all hours
      nightIndices = times.map((_, i) => i);
    }

    const avg = (arr: Array<number | null>) => {
      if (arr.length === 0) return null;
      const vals = nightIndices.map(i => arr[i]).filter((v): v is number => v != null);
      return vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    };

    return {
      temperature: avg(readNumberArray(pluck(hourly, 'temperature_2m'))),
      cloudCover: avg(readNumberArray(pluck(hourly, 'cloud_cover'))),
      humidity: avg(readNumberArray(pluck(hourly, 'relative_humidity_2m'))),
      windSpeed: avg(readNumberArray(pluck(hourly, 'wind_speed_10m'))),
      dewPoint: avg(readNumberArray(pluck(hourly, 'dew_point_2m'))),
      visibility: avg(readNumberArray(pluck(hourly, 'visibility'))),
      precipProb: avg(readNumberArray(pluck(hourly, 'precipitation_probability'))),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch and store historical weather for all sessions of an object that
 * don't have weather data yet. Called during import and on startup.
 */
export async function backfillSessionWeather(objectId: string): Promise<void> {
  const rows = stmts.getSessions.all(objectId);
  const defaultSite = getDefaultSite();
  for (const row of rows) {
    if (row.temperature != null) continue; // already has weather
    if (row.date === 'unknown') continue;
    // row.siteId came from the same SELECT * this loop is already iterating,
    // so resolving it directly avoids a redundant per-row session lookup
    // (which is what siteForSession would otherwise do).
    const site = (row.siteId && getSite(row.siteId)) || defaultSite;
    const weather = await fetchSessionWeather(row.date, site);
    if (weather) {
      stmts.setSessionWeather.run(
        weather.temperature, weather.cloudCover, weather.humidity,
        weather.windSpeed, weather.dewPoint, weather.visibility, weather.precipProb,
        objectId, row.date
      );
    }
  }
}

/**
 * Fetch and store weather for exactly one session, awaited by the caller.
 *
 * Used right after a site retag: `reassignSessionSite` nulls that one
 * session's weather columns, and the route used to fire `backfillSessionWeather`
 * (which walks every session of the object still missing weather) in the
 * background and respond immediately. The client invalidates its cached
 * observation on that response, refetches, gets `weather: null`, and the
 * Conditions card disappears from the Details grid — nothing ever told the
 * client to invalidate again once the background fetch finished, so it
 * stayed gone until the next full page load. Awaiting a single-session fetch
 * here is fast enough to do inline, so the response already carries the
 * re-fetched weather and the card never blanks out.
 */
export async function backfillSingleSessionWeather(objectId: string, date: string): Promise<void> {
  const row = stmts.getSession.get(objectId, date);
  if (!row || row.temperature != null) return;
  const site = (row.siteId && getSite(row.siteId)) || getDefaultSite();
  const weather = await fetchSessionWeather(date, site);
  if (weather) {
    stmts.setSessionWeather.run(
      weather.temperature, weather.cloudCover, weather.humidity,
      weather.windSpeed, weather.dewPoint, weather.visibility, weather.precipProb,
      objectId, date
    );
  }
}

// Schedule one-time startup backfill for sessions missing weather
{
  // Typed prepared statements — SQL trust boundary enforced by librarySessions schema.
  const missingCountStmt = db.prepare<[string], { cnt: number }>(
    'SELECT COUNT(*) as cnt FROM librarySessions WHERE temperature IS NULL AND date != ?',
  );
  const missingCnt = missingCountStmt.get('unknown')?.cnt ?? 0;
  if (missingCnt > 0) {
    console.log(`[library] Backfilling weather for ${missingCnt} sessions...`);
    setTimeout(async () => {
      const distinctObjsStmt = db.prepare<[], { objectId: string }>(
        `SELECT DISTINCT objectId FROM librarySessions WHERE temperature IS NULL AND date != 'unknown'`,
      );
      const rows = distinctObjsStmt.all();
      for (const row of rows) {
        try { await backfillSessionWeather(row.objectId); } catch { /* best-effort */ }
      }
      console.log('[library] Weather backfill complete');
    }, 5000);
  }
}

// ─── Session/file queries ───────────────────────────────────────────────────

/**
 * Migrate stale per-session rows left behind by the observing-night rollover
 * fix or by toggling the Settings grouping switch. A session running past
 * local midnight can accumulate TWO `librarySessions` rows for what's really
 * one physical session — one keyed by the raw calendar date (written before
 * the fix existed, or while grouping was off) and one keyed by the rolled
 * night bucket (written while grouping was on) — because imports only ever
 * add session rows, never prune ones that stop matching. Whichever row isn't
 * the CURRENT bucket for its files becomes a phantom zero-file session that
 * would otherwise linger forever (in either direction: turning grouping off
 * doesn't delete the rolled row, and turning it on doesn't delete the raw one).
 *
 * For each row whose date isn't a bucket any current file maps to, this
 * checks whether it corresponds to some file's date under *either* the raw
 * (grouping off) or rolled (grouping on) convention — not just whichever one
 * is active right now — so a row from the other direction can still be
 * recognized and merged forward onto the file's current bucket. Ambiguous
 * cases (matching files disagree on their current bucket) are left untouched
 * rather than guessed at, and a row that doesn't correlate to any file under
 * either convention is assumed to be a genuine manual/note-only entry.
 *
 * Runs inline as part of `getLocalSessions` and `getLocalObservations` —
 * cheap (reuses the file list the caller already reads) and correctly
 * deferred until the library is actually available, unlike a startup-time
 * scan.
 */
function reconcileStaleSessionDates(objectId: string, files: string[]): void {
  const sessionRows = stmts.getSessions.all(objectId);
  if (sessionRows.length === 0) return;

  // The bucket every file currently belongs to, per the live toggle state.
  // A row already in this set is definitely still correct — skip it without
  // even trying to correlate it against files.
  const currentBuckets = new Set(
    files.map(f => sessionNightFor(parseFilename(f))).filter((d): d is string => d !== null),
  );

  for (const row of sessionRows) {
    if (row.date === 'unknown') continue;
    if (currentBuckets.has(row.date)) continue; // still a live bucket

    const matching = files.filter(f => {
      const parsed = parseFilename(f);
      if (!parsed.date) return false;
      if (parsed.date === row.date) return true; // raw-date convention
      const hms = parsed.timestamp ? parsed.timestamp.slice(-6) : null;
      return rolloverDateUnconditional(parsed.date, hms) === row.date; // rolled convention
    });
    if (matching.length === 0) continue; // note-only entry, or already migrated

    const nights = new Set(
      matching
        .map(f => sessionNightFor(parseFilename(f)))
        .filter((d): d is string => d !== null),
    );
    if (nights.size !== 1) continue; // ambiguous — leave it for the user to sort out
    const [newDate] = nights;
    if (newDate === row.date) continue; // already correct (shouldn't happen given the check above)

    db.transaction(() => {
      stmts.addSessionStamped.run(objectId, newDate, row.telescopeId);
      const dest = stmts.getSession.get(objectId, newDate);
      if (dest && dest.temperature == null && row.temperature != null) {
        stmts.setSessionWeather.run(
          row.temperature, row.cloudCover, row.humidity, row.windSpeed,
          row.dewPoint, row.visibility, row.precipProb, objectId, newDate,
        );
      }
      if (dest && !dest.sessionImage && row.sessionImage) {
        db.prepare('UPDATE librarySessions SET sessionImage = ? WHERE objectId = ? AND date = ?')
          .run(row.sessionImage, objectId, newDate);
      }
      stmts.removeSession.run(objectId, row.date);

      db.prepare(
        `UPDATE notes SET date = ? WHERE objectId = ? AND date = ?
         AND NOT EXISTS (SELECT 1 FROM notes WHERE objectId = ? AND date = ?)`,
      ).run(newDate, objectId, row.date, objectId, newDate);

      db.prepare('UPDATE sessionProcessedImages SET date = ? WHERE objectId = ? AND date = ?')
        .run(newDate, objectId, row.date);

      if (stmts.isSessionTombstoned.get(objectId, row.date)) {
        stmts.addSessionTombstone.run(objectId, newDate);
        db.prepare('DELETE FROM libraryDeletedSessions WHERE objectId = ? AND date = ?')
          .run(objectId, row.date);
      }
    })();
    console.log(`[library] Reconciled stale session date for ${objectId}: ${row.date} -> ${newDate}`);
  }
}

export function getLocalSessions(objectId: string) {
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.join(LIBRARY_DIR, getFolderName(objectId));

  if (fs.existsSync(objDir)) {
    const filesForReconcile = fs.readdirSync(objDir).filter(f => isRealFile(f) && !f.startsWith('sky_') && !f.startsWith('gallery_'));
    try { reconcileStaleSessionDates(objectId, filesForReconcile); } catch { /* best-effort */ }
  }

  const sessionMap = new Map<string, {
    fileCount: number;
    // Distinct stacked captures, keyed by basename so the FITS and the JPG of
    // the same stack count once (not twice).
    stackedKeys: Set<string>;
    fitsCount: number;
    subFrameCount: number;
    imageCount: number;
    thumbnailFile: string | null;   // _thn.jpg
    stackedImageFile: string | null; // Stacked_*.jpg (non-thumbnail)
    anyImageFile: string | null;     // any other .jpg/.png fallback
    /** Whether the chosen file is a JPEG (servable as-is). Lets a JPEG found
     *  later replace a costly earlier pick without a second pass. */
    stackedImageIsCheap: boolean;
    anyImageIsCheap: boolean;
  }>();

  // Processed-image counts per session date (separate `sessionProcessedImages`
  // table; these files live under `<folder>/processed/`, not the object root).
  const processedCountByDate = new Map<string, number>();
  for (const r of db.prepare<[string], { date: string; n: number }>(
    'SELECT date, COUNT(*) as n FROM sessionProcessedImages WHERE objectId = ? GROUP BY date',
  ).all(objectId)) {
    processedCountByDate.set(r.date, r.n);
  }

  interface SessionRow {
    date: string;
    telescopeId: string | null;
    temperature: number | null;
    cloudCover: number | null;
    humidity: number | null;
    windSpeed: number | null;
    dewPoint: number | null;
    visibility: number | null;
    precipProb: number | null;
    sessionImage: string | null;
  }

  // Seed from DB so note-only / image-free manual entries still appear.
  // `stmts.getSessions` returns LibrarySessionRow; we only need the fields
  // declared locally in SessionRow, which is structurally a subset.
  const sessionRows: SessionRow[] = stmts.getSessions.all(objectId);
  const deletedSessions = new Set(
    stmts.getDeletedSessions.all(objectId).map(r => r.date),
  );
  const weatherMap = new Map<string, SessionWeather>();
  const telescopeIdByDate = new Map<string, string | null>(
    sessionRows.map(r => [r.date, r.telescopeId]),
  );
  // User-crowned per-session preview: { date → relative library path }.
  // When set, this wins over auto-picked thumbnail/stacked/anyImage below
  // so the object page reflects the same hero image as the observation page.
  const sessionImageMap = new Map<string, string>();
  for (const r of sessionRows) {
    if (r.sessionImage && !deletedSessions.has(r.date)) {
      sessionImageMap.set(r.date, r.sessionImage);
    }
  }
  for (const r of sessionRows) {
    if (r.date === 'unknown') continue; // stale rows from old imports — skip
    if (!deletedSessions.has(r.date) && !sessionMap.has(r.date)) {
      sessionMap.set(r.date, { fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, imageCount: 0, thumbnailFile: null, stackedImageFile: null, anyImageFile: null, stackedImageIsCheap: false, anyImageIsCheap: false });
    }
    if (r.temperature != null) {
      weatherMap.set(r.date, {
        temperature: r.temperature,
        cloudCover: r.cloudCover,
        humidity: r.humidity,
        windSpeed: r.windSpeed,
        dewPoint: r.dewPoint,
        visibility: r.visibility,
        precipProb: r.precipProb,
      });
    }
  }

  if (!fs.existsSync(objDir)) {
    return Array.from(sessionMap.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, stats]) => ({
        id: `${objectId}_${date}`,
        date,
        objectId,
        fileCount: stats.fileCount,
        stackedCount: stats.stackedKeys.size,
        fitsCount: stats.fitsCount,
        subFrameCount: stats.subFrameCount,
        imageCount: stats.imageCount,
        processedCount: processedCountByDate.get(date) ?? 0,
        thumbnailUrl: `${LIBRARY_API_BASE}/objects/${encodeURIComponent(objectId)}/thumbnail`,
        filesUrl: `${LIBRARY_API_BASE}/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/files`,
        weather: weatherMap.get(date) || null,
      }));
  }

  // Layout-aware listing: flat objects are one level, nested objects are
  // object/<session>/<file>. listObjectFiles is the only place that knows the
  // difference, so everything below works on an object-relative path.
  const entries = listObjectFiles(objDir, getObjectLayout(objectId))
    .filter(e => isRealFile(e.fileName)
      && !e.fileName.startsWith('sky_')
      && !e.fileName.startsWith('gallery_'));

  // Session membership comes from libraryFiles when the file has a row, and
  // falls back to parsing the name when it doesn't. See resolverFor().
  const identity = resolverFor(objectId);

  for (const entry of entries) {
    const fname = entry.fileName;
    const parsed = parseFilename(fname);
    const sessionKey = identity.session(entry.relPath);
    if (!sessionKey) continue; // skip files we can't assign a session date to
    if (deletedSessions.has(sessionKey)) continue;
    if (!sessionMap.has(sessionKey)) {
      sessionMap.set(sessionKey, { fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, imageCount: 0, thumbnailFile: null, stackedImageFile: null, anyImageFile: null, stackedImageIsCheap: false, anyImageIsCheap: false });
    }
    const s = sessionMap.get(sessionKey)!;
    s.fileCount++;
    // Keyed on the object-relative path: in a nested object every session has
    // its own `stacked.jpg`, so a basename key would merge distinct stacks.
    if (parsed.type === 'stacked') s.stackedKeys.add(entry.relPath.slice(0, entry.relPath.length - path.extname(fname).length));
    // The preview fields hold object-relative paths because they are turned
    // into `<folderName>/<relPath>` URLs below.
    if (parsed.isThumbnail && !s.thumbnailFile) s.thumbnailFile = entry.relPath;
    const isViewableImage = parsed.extension === '.jpg' || parsed.extension === '.jpeg'
      || parsed.extension === '.png' || parsed.extension === '.tif' || parsed.extension === '.tiff';
    // A JPEG can be served straight to the client; anything else has to be
    // converted by sharp on the way out. That matters for the pick, not just the
    // URL: featuring a Dwarf's ~100 MB float `img_stacked_all.tif` means a 100 MB
    // decode every time this card misses the thumbnail cache. Prefer a cheap
    // format, and only settle for a costly one when it is the session's only
    // image (tracked separately below so a later JPEG can still win).
    const isCheapImage = parsed.extension === '.jpg' || parsed.extension === '.jpeg';
    if (!parsed.isThumbnail && parsed.type === 'stacked' && isViewableImage
      && (!s.stackedImageFile || (isCheapImage && !s.stackedImageIsCheap))) {
      s.stackedImageFile = entry.relPath;
      s.stackedImageIsCheap = isCheapImage;
    }
    if (!parsed.isThumbnail && parsed.type !== 'stacked' && isViewableImage
      && (!s.anyImageFile || (isCheapImage && !s.anyImageIsCheap))) {
      s.anyImageFile = entry.relPath;
      s.anyImageIsCheap = isCheapImage;
    }
    if (parsed.type === 'sub') s.subFrameCount++;
    const cat = getFileCategory(fname);
    if (cat === 'fits') s.fitsCount++;
    if (cat === 'image') s.imageCount++;
  }

  return Array.from(sessionMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, stats]) => ({
      id: `${objectId}_${date}`,
      date,
      objectId,
      fileCount: stats.fileCount,
      stackedCount: stats.stackedKeys.size,
      fitsCount: stats.fitsCount,
      subFrameCount: stats.subFrameCount,
      imageCount: stats.imageCount,
      processedCount: processedCountByDate.get(date) ?? 0,
      thumbnailUrl: (() => {
        // User-crowned session image wins over the auto-picked file so the
        // object-page card matches the hero shown on the observation page.
        const crowned = sessionImageMap.get(date);
        // Only use the crowned path if the file still exists on disk — a
        // re-import can rename or remove the previously crowned file, which
        // would leave a broken URL that shows "No preview" indefinitely.
        const crownedExists = crowned && fs.existsSync(path.join(LIBRARY_DIR, crowned));
        if (crownedExists) return `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(crowned)}`;
        const best = stats.thumbnailFile ?? stats.stackedImageFile ?? stats.anyImageFile;
        if (!best) return `${LIBRARY_API_BASE}/objects/${encodeURIComponent(objectId)}/thumbnail`;
        const fullPath = getFolderName(objectId) + '/' + best;
        // Use the thumbnail route for non-JPEG images (PNG/TIF) so sharp
        // converts them to browser-renderable JPEG. Raw 16-bit PNGs from
        // Dwarf stacking output cannot be displayed by browsers via <img>.
        const isJpeg = /\.(jpg|jpeg)$/i.test(best);
        return isJpeg
          ? `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(fullPath)}`
          : `${LIBRARY_API_BASE}/file/thumbnail?path=${encodeURIComponent(fullPath)}`;
      })(),
      filesUrl: `${LIBRARY_API_BASE}/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/files`,
      weather: weatherMap.get(date) || null,
      telescopeId: telescopeIdByDate.get(date) ?? null,
    }));
}

export function getLocalFiles(objectId: string, sessionDate?: string) {
  const LIBRARY_DIR = getLibraryDir();
  const folderName = getFolderName(objectId);
  // Resolve and contain — getFolderName falls back to the raw objectId on a DB
  // miss, so a crafted objectId with traversal tokens would escape LIBRARY_DIR
  // without this guard. Mirrors the containment in library.ts:1164/1201.
  const objDir = path.resolve(LIBRARY_DIR, folderName);
  if (!objDir.startsWith(LIBRARY_DIR + path.sep)) return [];
  if (!fs.existsSync(objDir)) return [];

  const identity = resolverFor(objectId);

  return listObjectFiles(objDir, getObjectLayout(objectId))
    .filter(e => isRealFile(e.fileName)
      && !e.fileName.startsWith('sky_')
      && !e.fileName.startsWith('gallery_'))
    .filter(entry => {
      if (!sessionDate) return true;
      return identity.session(entry.relPath) === sessionDate;
    })
    .map(entry => {
      const fname = entry.fileName;
      const parsed = parseFilename(fname);
      const fullPath = path.join(objDir, entry.relPath);
      const stat = fs.statSync(fullPath);
      const category = getFileCategory(fname);
      // `getFileCategory` and `parsed.type` come back as wider string types
      // (from helpers in telescopeFiles). Runtime values are always within the
      // literal unions below, so we narrow via a guard + fallback instead of
      // asserting through. SQL/helper trust boundary.
      const knownType: 'image' | 'fits' | 'video' | 'thumbnail' | 'other' =
        category === 'image' || category === 'fits' || category === 'video' || category === 'thumbnail'
          ? category : 'other';
      // Prefer the recorded role, falling back to the filename parse. The two
      // can legitimately disagree: the Dwarf master stack is a `.tif` that
      // parseFilename types as 'other' but which is genuinely a stack, and a
      // nested import keeps device names that carry no type hint at all.
      const role = identity.role(entry.relPath);
      const roleFileType = role === 'stacked' || role === 'sub' || role === 'thumbnail' || role === 'video'
        ? role : null;
      const knownFileType: 'stacked' | 'sub' | 'thumbnail' | 'video' | 'other' =
        roleFileType ?? (
          parsed.type === 'stacked' || parsed.type === 'sub' || parsed.type === 'thumbnail' || parsed.type === 'video'
            ? parsed.type : 'other');
      // The library path is folderName + the object-relative path, so a
      // nested object's session directory is carried into every URL.
      const libPath = `${folderName}/${entry.relPath}`;
      const needsRasterConversion = /\.(png|tiff?)$/i.test(fname);
      /**
       * TIFF gets no preview at all, and is shown as a file card instead.
       *
       * A Dwarf's `img_stacked_all.tif` is 32-bit float LINEAR data (measured:
       * min 251, max 9,672,048). sharp reads it as scene-linear scRGB where 1.0
       * is white, so every value clips and the render comes out pure white.
       * Rescaling before the conversion does not behave predictably either: the
       * output brightness is non-monotonic in the window (a white point at
       * mean+0.1σ gives mean 219, at mean+0.5σ gives mean 12), so there is no
       * stable calibration to pick.
       *
       * Displaying it properly needs a real astro render (decode the TIFF
       * directly, then the midtone-transfer autostretch fitsThumbnail.ts already
       * implements). Until then a file card is the honest answer: a linear
       * archival master is not a preview, and the device ships `stacked.jpg`
       * alongside it for exactly that purpose.
       *
       * 8-bit TIFFs lose their preview too. Accepted: they are rare from these
       * devices, and a download card beats a white rectangle.
       */
      const previewable = !/\.tiff?$/i.test(fname);
      return {
        name: fname,
        size: stat.size,
        type: knownType,
        fileType: knownFileType,
        path: libPath,
        sessionFolder: entry.sessionFolder,
        exposure: parsed.exposure || null,
        filter: parsed.filter || null,
        timestamp: parsed.timestamp || null,
        date: parsed.date || null,
        frameCount: parsed.frameCount || null,
        isThumbnail: parsed.isThumbnail,
        /** False when no rendering of this file can be trusted, so clients must
         *  show a download card rather than an `<img>`. */
        previewable,
        downloadUrl: `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(libPath)}`,
        // FITS files get a server-rendered JPEG (colorized MTF autostretch) so
        // clients never decode the raw FITS just to preview it. The endpoint
        // generates on demand, so this is emitted whether or not the thumb has
        // been rendered yet (older imports are backfilled on first request).
        // `previewUrl` is a larger 1024px tier for full-screen viewing.
        thumbUrl: knownType === 'fits'
          ? `${LIBRARY_API_BASE}/fits-thumbnail?path=${encodeURIComponent(libPath)}`
          // TIFF and PNG need a server-side conversion too. A 16-bit PNG or a
          // 32-bit float TIFF (the Dwarf master stack) cannot be shown by a
          // browser <img> at all, so hand the client a rendered JPEG rather
          // than a URL it will fail to display.
          : needsRasterConversion && previewable
            ? `${LIBRARY_API_BASE}/file/thumbnail?path=${encodeURIComponent(libPath)}`
            : undefined,
        previewUrl: knownType === 'fits'
          ? `${LIBRARY_API_BASE}/fits-thumbnail?size=preview&path=${encodeURIComponent(libPath)}`
          : needsRasterConversion && previewable
            ? `${LIBRARY_API_BASE}/file/thumbnail?w=1200&h=1200&path=${encodeURIComponent(libPath)}`
            : undefined,
        subIndex: parsed.subIndex || null,
      };
    })
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}

// ─── Observation-style queries (calendar + detail) ───────────────────────────

export function getLocalObservations() {
  const LIBRARY_DIR = getLibraryDir();
  // ensureLibraryDir is a no-op if the directory exists; route handlers can
  // assume the dir is present after this returns.
  if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
  interface MinObjectRow {
    objectId: string;
    folderName: string;
    objectName: string | null;
    catalogId: string | null;
    objectType: string | null;
    constellation: string | null;
    ra: string | null;
    dec: string | null;
    primaryTelescopeId: string | null;
  }
  const getLocalObservationsObjsStmt = db.prepare<[], MinObjectRow>(
    `SELECT objectId, folderName, objectName, catalogId, objectType, constellation, ra, dec, primaryTelescopeId
     FROM libraryObjects WHERE deleted = 0`,
  );
  const objects = getLocalObservationsObjsStmt.all();

  // Processed-image counts for every session in one pass, keyed `objectId|date`.
  const processedCountByKey = new Map<string, number>();
  for (const r of db.prepare<[], { objectId: string; date: string; n: number }>(
    'SELECT objectId, date, COUNT(*) as n FROM sessionProcessedImages GROUP BY objectId, date',
  ).all()) {
    processedCountByKey.set(`${r.objectId}|${r.date}`, r.n);
  }

  const observations: Array<{
    id: string;
    objectId: string;
    objectName: string;
    catalogId: string;
    type: string;
    constellation: string;
    date: string;
    startTime: string | null;
    endTime: string | null;
    fileCount: number;
    stackedCount: number;
    fitsCount: number;
    subFrameCount: number;
    processedCount: number;
    thumbnailUrl: string;
    ra: string | null;
    dec: string | null;
    hasNotes: boolean;
    telescopeId: string | null;
  }> = [];

  for (const obj of objects) {
    const objectId = obj.objectId;
    const objDir = path.join(LIBRARY_DIR, obj.folderName || objectId);
    if (!fs.existsSync(objDir)) continue;

    // Layout-aware: a nested object keeps its files inside per-session
    // directories, so an object-level readdir would report it as having no
    // files at all and it would show up empty on the calendar.
    const entries = listObjectFiles(objDir, getObjectLayout(objectId));
    const identity = resolverFor(objectId);
    // reconcileStaleSessionDates parses bare filenames, so it takes basenames.
    try { reconcileStaleSessionDates(objectId, entries.map(e => e.fileName)); } catch { /* best-effort */ }
    const sessionRows = stmts.getSessions.all(objectId);
    const sessions = sessionRows.map(r => r.date);
    // User-crowned per-session preview wins over the object-level thumbnail.
    const sessionImageMap = new Map<string, string>();
    for (const r of sessionRows) {
      if (r.sessionImage) sessionImageMap.set(r.date, r.sessionImage);
    }
    const telescopeIdByDate = new Map<string, string | null>(
      sessionRows.map(r => [r.date, r.telescopeId]),
    );

    // Group files by session date
    const sessionMap = new Map<string, {
      timestamps: string[];
      fileCount: number;
      // Distinct stacked captures, keyed by basename so a FITS+JPG pair of the
      // same stack counts once.
      stackedKeys: Set<string>;
      fitsCount: number;
      subFrameCount: number;
      stackedImageFile: string | null;
      /** True when stackedImageFile is a JPEG, so a later JPEG can displace a
       *  costly earlier pick. See getLocalSessions for the reasoning. */
      stackedImageIsCheap: boolean;
    }>();

    // Seed from DB so note-only manual entries appear on the calendar
    for (const d of sessions) {
      if (d === 'unknown') continue;
      if (!sessionMap.has(d)) {
        sessionMap.set(d, { timestamps: [], fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, stackedImageFile: null, stackedImageIsCheap: false });
      }
    }

    for (const entry of entries) {
      const fname = entry.fileName;
      const parsed = parseFilename(fname);
      if (parsed.isThumbnail) continue;
      const date = identity.session(entry.relPath);
      if (!date) continue; // skip files we can't assign a session date to
      if (!sessionMap.has(date)) {
        sessionMap.set(date, { timestamps: [], fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, stackedImageFile: null, stackedImageIsCheap: false });
      }
      const s = sessionMap.get(date)!;
      s.fileCount++;
      if (parsed.timestamp) s.timestamps.push(parsed.timestamp);
      // Keyed on the object-relative path: every nested session has its own
      // `stacked.jpg`, which a basename key would merge into one stack.
      if (parsed.type === 'stacked') s.stackedKeys.add(entry.relPath.slice(0, entry.relPath.length - path.extname(fname).length));
      if (parsed.type === 'sub') s.subFrameCount++;
      const ext = parsed.extension?.toLowerCase();
      if (ext === '.fit' || ext === '.fits') s.fitsCount++;
      const isViewableImage = ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.tif' || ext === '.tiff';
      // Cheap-first, same reasoning as getLocalSessions: a costly pick means a
      // ~100 MB sharp decode per calendar card on a thumbnail-cache miss.
      const isCheapImage = ext === '.jpg' || ext === '.jpeg';
      if (parsed.type === 'stacked' && isViewableImage
        && (!s.stackedImageFile || (isCheapImage && !s.stackedImageIsCheap))) {
        // Object-relative, because it is turned into a `<folderName>/<path>` URL.
        s.stackedImageFile = entry.relPath;
        s.stackedImageIsCheap = isCheapImage;
      }
    }

    const folderName = obj.folderName || objectId;

    for (const [date, session] of sessionMap) {
      const sorted = session.timestamps.sort();
      const note = getNote(objectId, date);
      observations.push({
        id: `${objectId}_${date}`,
        objectId,
        objectName: obj.objectName || objectId,
        catalogId: obj.catalogId || objectId,
        type: obj.objectType || 'Unknown',
        constellation: obj.constellation || 'Unknown',
        date,
        startTime: sorted.length > 0 ? sorted[0] : null,
        endTime: sorted.length > 0 ? sorted[sorted.length - 1] : null,
        fileCount: session.fileCount,
        stackedCount: session.stackedKeys.size,
        fitsCount: session.fitsCount,
        subFrameCount: session.subFrameCount,
        processedCount: processedCountByKey.get(`${objectId}|${date}`) ?? 0,
        thumbnailUrl: (() => {
          const crowned = sessionImageMap.get(date);
          if (crowned) return `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(crowned)}`;
          if (session.stackedImageFile) {
            const fullPath = folderName + '/' + session.stackedImageFile;
            const isJpeg = /\.(jpg|jpeg)$/i.test(session.stackedImageFile);
            return isJpeg
              ? `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(fullPath)}`
              : `${LIBRARY_API_BASE}/file/thumbnail?path=${encodeURIComponent(fullPath)}`;
          }
          return `${LIBRARY_API_BASE}/objects/${encodeURIComponent(objectId)}/thumbnail`;
        })(),
        ra: obj.ra || null,
        dec: obj.dec || null,
        hasNotes: !!note,
        telescopeId: telescopeIdByDate.get(date) ?? obj.primaryTelescopeId ?? null,
      });
    }
  }

  observations.sort((a, b) => b.date.localeCompare(a.date));
  return observations;
}

// ─── Observation-site coordinates (world map) ───────────────────────────────

/**
 * Read observer coordinates from a session's first FITS header.
 * Returns null when the file carries no SITELAT/SITELONG (or can't be read).
 * These values are fixed per file, so callers cache the result.
 */
function readFitsCoords(fitsPath: string): { lat: number; lon: number } | null {
  try {
    const fd = fs.openSync(fitsPath, 'r');
    const buf = Buffer.alloc(28800);
    fs.readSync(fd, buf, 0, 28800, 0);
    fs.closeSync(fd);
    const header = parseFitsHeader(buf);
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
  }
}

export interface ObservationLocation {
  objectId: string;
  date: string;
  objectName: string;
  catalogId: string;
  telescopeId: string | null;
  lat: number;
  lon: number;
  /** 'fits' = precise (from the file); 'settings' = fell back to the saved observer location. */
  source: 'fits' | 'settings';
}

/**
 * Every imported observation that has a known location, for the world map.
 * FITS-derived coordinates are cached on librarySessions (see db.ts migration)
 * so only never-seen sessions pay the file-read cost. Sessions with no FITS
 * location fall back to the session's own observing site (applied at read
 * time, not cached, so retagging a session or editing a site's coordinates
 * takes effect immediately).
 */
export function getObservationLocations(): ObservationLocation[] {
  const LIBRARY_DIR = getLibraryDir();
  if (!fs.existsSync(LIBRARY_DIR)) return [];

  const defaultSite = getDefaultSite();

  const readCoordsCache = db.prepare<[string, string], { lat: number | null; lon: number | null; coordsResolved: number; siteId: string | null }>(
    'SELECT lat, lon, coordsResolved, siteId FROM librarySessions WHERE objectId = ? AND date = ?',
  );
  const writeCoordsCache = db.prepare<[number | null, number | null, string, string]>(
    'UPDATE librarySessions SET lat = ?, lon = ?, coordsResolved = 1 WHERE objectId = ? AND date = ?',
  );

  const out: ObservationLocation[] = [];

  for (const obs of getLocalObservations()) {
    const { objectId, date } = obs;

    // Cache-first: only touch the FITS file the first time we see a session.
    let fitsCoords: { lat: number; lon: number } | null = null;
    const cached = readCoordsCache.get(objectId, date);
    if (cached && cached.coordsResolved === 1) {
      // Ignore the legacy (0, 0) sentinel that older caches may hold.
      if (cached.lat !== null && cached.lon !== null && !(cached.lat === 0 && cached.lon === 0)) {
        fitsCoords = { lat: cached.lat, lon: cached.lon };
      }
    } else {
      // Resolve from the session's first non-thumbnail FITS file, then cache it.
      const folderName = getFolderName(objectId);
      const objDir = path.join(LIBRARY_DIR, folderName);
      let firstFits: string | null = null;
      try {
        for (const fname of fs.readdirSync(objDir)) {
          const parsed = parseFilename(fname);
          if (parsed.isThumbnail) continue;
          const ext = parsed.extension?.toLowerCase();
          if (ext !== '.fit' && ext !== '.fits') continue;
          if (sessionNightFor(parsed) !== date) continue;
          firstFits = fname;
          break;
        }
      } catch { /* dir gone; treated as resolved-with-no-coords */ }

      fitsCoords = firstFits ? readFitsCoords(path.join(objDir, firstFits)) : null;
      // Best-effort cache write (no row to update for file-only sessions is fine).
      try { writeCoordsCache.run(fitsCoords?.lat ?? null, fitsCoords?.lon ?? null, objectId, date); } catch { /* best-effort */ }
    }

    let lat: number | null = null;
    let lon: number | null = null;
    let source: 'fits' | 'settings' = 'fits';
    if (fitsCoords) {
      lat = fitsCoords.lat;
      lon = fitsCoords.lon;
    } else {
      const site = (cached?.siteId && getSite(cached.siteId)) || defaultSite;
      if (site.latitude !== null && site.longitude !== null) {
        lat = site.latitude;
        lon = site.longitude;
        source = 'settings';
      }
    }
    if (lat === null || lon === null) continue; // no location for this session

    out.push({
      objectId,
      date,
      objectName: obs.objectName,
      catalogId: obs.catalogId,
      telescopeId: obs.telescopeId,
      lat,
      lon,
      source,
    });
  }

  return out;
}

export function getLocalObservationDetail(objectId: string, date: string) {
  const LIBRARY_DIR = getLibraryDir();
  const obj = stmts.getObject.get(objectId);
  const files = getLocalFiles(objectId, date);

  const timestamps = files
    // Filter preserves non-null timestamps; the predicate narrows via typeof
    // so the subsequent `.map` can read timestamp as a string without casting.
    .filter((f): f is typeof f & { timestamp: string } => !f.isThumbnail && typeof f.timestamp === 'string')
    .map(f => f.timestamp)
    .sort();

  // Distinct stacked captures: a stack exported as both FITS and JPG shares a
  // basename, so dedupe on the name-without-extension to count it once.
  const stackedCount = new Set(
    files.filter(f => f.fileType === 'stacked')
      .map(f => f.name.slice(0, f.name.length - path.extname(f.name).length)),
  ).size;
  const fitsCount = files.filter(f => f.type === 'fits').length;
  const subFrameCount = files.filter(f => f.fileType === 'sub').length;
  const processedCount = stmts.getProcessedImages.all(objectId, date).length;

  const note = getNote(objectId, date) || null;

  // Extract coordinates from the first available local FITS file
  let coordinates: { lat: number; lon: number } | null = null;
  const firstFits = files.find(f => f.type === 'fits' && !f.isThumbnail);
  if (firstFits) {
    try {
      const fullPath = path.join(LIBRARY_DIR, getFolderName(objectId), firstFits.name);
      const fd = fs.openSync(fullPath, 'r');
      const buf = Buffer.alloc(28800);
      fs.readSync(fd, buf, 0, 28800, 0);
      fs.closeSync(fd);
      const header = parseFitsHeader(buf);
      const lat = header.values['OBS-LAT'] ?? header.values['SITELAT'] ?? null;
      const lon = header.values['OBS-LONG'] ?? header.values['SITELONG'] ?? null;
      if (lat !== null && lon !== null) {
        const latNum = typeof lat === 'number' ? lat : parseFloat(String(lat));
        const lonNum = typeof lon === 'number' ? lon : parseFloat(String(lon));
        if (!isNaN(latNum) && !isNaN(lonNum)) {
          coordinates = { lat: latNum, lon: lonNum };
        }
      }
    } catch { /* best-effort */ }
  }

  // Fall back to this session's observing site if no FITS coordinates
  if (!coordinates) {
    const site = siteForSession(objectId, date);
    if (site.latitude !== null && site.longitude !== null) {
      coordinates = { lat: site.latitude, lon: site.longitude };
    }
  }

  // Sort: stacked first, then images, then FITS subs by index/timestamp
  const sortedFiles = [...files].sort((a, b) => {
    if (a.fileType === 'stacked' && b.fileType !== 'stacked') return -1;
    if (a.fileType !== 'stacked' && b.fileType === 'stacked') return 1;
    if (a.type === 'image' && b.type === 'fits') return -1;
    if (a.type === 'fits' && b.type === 'image') return 1;
    if (a.subIndex != null && b.subIndex != null) return a.subIndex - b.subIndex;
    return (a.timestamp || '').localeCompare(b.timestamp || '');
  });

  const sessionImagePath = (() => {
    const row = stmts.getSessionImage.get(objectId, date);
    return row?.sessionImage ?? null;
  })();

  return {
    id: `${objectId}_${date}`,
    objectId,
    objectName: obj?.objectName || objectId,
    catalogId: obj?.catalogId || objectId,
    type: obj?.objectType || 'Unknown',
    constellation: obj?.constellation || 'Unknown',
    date,
    startTime: timestamps.length > 0 ? timestamps[0] : null,
    endTime: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
    fileCount: sortedFiles.filter(f => !f.isThumbnail).length,
    stackedCount,
    fitsCount,
    subFrameCount,
    processedCount,
    thumbnailUrl: `${LIBRARY_API_BASE}/objects/${encodeURIComponent(objectId)}/thumbnail`,
    ra: obj?.ra || null,
    dec: obj?.dec || null,
    magnitude: obj?.magnitude ?? null,
    distanceLy: obj?.distanceLy ?? null,
    description: obj?.description || '',
    wikiUrl: obj?.wikiUrl || null,
    sizeArcmin: obj?.sizeArcmin || null,
    hasNotes: !!note,
    sessionImage: sessionImagePath,
    // What the device itself recorded about this night, parsed from its own
    // sidecar. `captureRuns` is plural because one night can hold several runs
    // at different exposure and gain; `capture` is the rolled-up view, with
    // exposure/gain/filter left null when the runs disagree.
    capture: summarizeSessionCapture(getCaptureInfoForSession(objectId, date)),
    captureRuns: getCaptureInfoForSession(objectId, date),
    files: sortedFiles,
    note,
    coordinates,
    weather: (() => {
      const row = stmts.getSession.get(objectId, date);
      if (!row || row.temperature == null) return null;
      const weather: SessionWeather = {
        temperature: row.temperature,
        cloudCover: row.cloudCover,
        humidity: row.humidity,
        windSpeed: row.windSpeed,
        dewPoint: row.dewPoint,
        visibility: row.visibility,
        precipProb: row.precipProb,
      };
      return weather;
    })(),
    telescopeId: (() => {
      const row = stmts.getSession.get(objectId, date);
      return row?.telescopeId ?? obj?.primaryTelescopeId ?? null;
    })(),
    // NULL means the default site (see siteForSession in observingSites.ts).
    // Read directly off the row rather than resolved to a concrete site here,
    // so the client can distinguish "explicitly tagged" from "using whatever
    // the default currently is."
    siteId: stmts.getSession.get(objectId, date)?.siteId ?? null,
  };
}

// ─── Session deletes / mutations ────────────────────────────────────────────

/**
 * Delete all local files for a specific session date and tombstone that date
 * so it is never re-imported from the telescope.
 */
export function deleteLocalSession(objectId: string, date: string): void {
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.join(LIBRARY_DIR, getFolderName(objectId));

  // Update DB FIRST
  const existing = stmts.getObject.get(objectId);
  if (!existing) {
    const cat = resolveCatalogMeta(objectId);
    stmts.upsertObject.run(objectId, objectId, 0, new Date().toISOString(), 0, null,
      cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
      cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
  }
  stmts.addSessionTombstone.run(objectId, date);
  stmts.removeSession.run(objectId, date);
  // The sidecar that produced this is deleted below, so its parsed record goes
  // with it rather than lingering as a row describing files that are gone.
  deleteCaptureInfoForSession(objectId, date);

  // Now safe to remove files. Membership comes from the resolver, not from
  // re-parsing the name: once the importer stops rewriting filenames, a file's
  // session lives in its libraryFiles row and the name may carry no date at all.
  const folderName = getFolderName(objectId);
  const layout = getObjectLayout(objectId);
  const identity = resolverFor(objectId);
  const emptiedDirs = new Set<string>();
  if (fs.existsSync(objDir)) {
    for (const entry of listObjectFiles(objDir, layout)) {
      // Sidecars go with the session they describe. They are outside
      // isRealFile's image-only allowlist, so they have to be named explicitly
      // or a deleted session would leave its shotsInfo.json behind (and the
      // session directory would never be pruned because it isn't empty).
      if (!isRealFile(entry.fileName) && !isSidecarFile(entry.fileName)) continue;
      if (identity.session(entry.relPath) !== date) continue;
      try { fs.unlinkSync(path.join(objDir, entry.relPath)); } catch { /* ignore */ }
      deleteLibraryFileRow(`${folderName}/${entry.relPath}`);
      if (entry.sessionFolder) emptiedDirs.add(entry.sessionFolder);
    }
    // A nested session folder that gave up all its files is now an empty
    // directory. Remove it, but only if it really is empty — a sidecar we do
    // not manage must not be silently taken with it.
    for (const dir of emptiedDirs) {
      const abs = path.join(objDir, dir);
      try {
        if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
      } catch { /* not empty or unreadable — leave it */ }
    }
  }

  // Recount remaining files
  try {
    const remaining = fs.existsSync(objDir)
      ? listObjectFiles(objDir, layout).filter(e => isRealFile(e.fileName))
      : [];
    stmts.updateObjectFileCount.run(remaining.length, objectId);
  } catch { /* ignore */ }
  writeObjectManifest(objectId, folderName);
}

/**
 * Delete only the raw sub-frame (.fit/.fits) files for a specific session date.
 * Leaves stacked images, thumbnails, and other files for that session intact.
 */
export function deleteSessionSubFrames(objectId: string, date: string): { deleted: number } {
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.join(LIBRARY_DIR, getFolderName(objectId));
  let deleted = 0;
  const folderName = getFolderName(objectId);
  const layout = getObjectLayout(objectId);
  const identity = resolverFor(objectId);
  if (fs.existsSync(objDir)) {
    for (const entry of listObjectFiles(objDir, layout)) {
      if (!isRealFile(entry.fileName)) continue;
      if (identity.role(entry.relPath) !== 'sub') continue;
      if (identity.session(entry.relPath) !== date) continue;
      try { fs.unlinkSync(path.join(objDir, entry.relPath)); deleted++; } catch { /* ignore */ }
      deleteLibraryFileRow(`${folderName}/${entry.relPath}`);
    }
  }
  try {
    const remaining = fs.existsSync(objDir)
      ? listObjectFiles(objDir, layout).filter(e => isRealFile(e.fileName))
      : [];
    stmts.updateObjectFileCount.run(remaining.length, objectId);
  } catch { /* ignore */ }
  writeObjectManifest(objectId, folderName);
  return { deleted };
}

/**
 * Matches frame-named preview images that should never live in the library:
 *   Light_<anything>.jpg/jpeg/png  — SeeStar per-frame preview
 *   sub_<N>_<anything>.jpg/jpeg/png — alternate naming scheme
 * Stacked images are always named Stacked_* or DSO_Stacked_*, never Light_*,
 * so there is no risk of catching a legitimate image with this pattern.
 * Strips macOS copy suffixes (" copy", " copy N") before matching.
 */
const SUBFRAME_PREVIEW_RE = /^(?:Light|sub_\d+)_.+\.(?:jpe?g|png)$/i;

function isSubFramePreview(filename: string): boolean {
  const stripped = filename.replace(/ copy(?: \d+)?(\.[^.]+)$/, '$1');
  return SUBFRAME_PREVIEW_RE.test(stripped);
}

/** Per-object breakdown of matched preview files, for the review modal. */
export interface SubFramePreviewGroup {
  folder: string;
  /** True number of matches in this folder (may exceed files.length). */
  count: number;
  /** Up to FILES_PER_GROUP_CAP example file names (no folder prefix). */
  files: string[];
}

export interface SubFrameImagePurgeResult {
  scannedObjects: number;
  /** Files matched (frame-named JPG/PNG previews). Equals `deleted` unless dryRun. */
  matched: number;
  deleted: number;
  errors: number;
  /** Matched files grouped by object folder, for a review-before-delete list. */
  groups: SubFramePreviewGroup[];
}

/** Cap on example file names listed per folder in the review breakdown. */
const FILES_PER_GROUP_CAP = 200;

/**
 * Library-wide cleanup for frame-named image previews (e.g. `Light_*.jpg`) that
 * older imports copied into object folders before sub-frame import was made
 * FITS-only. Deletes only files that parse as a sub-frame AND carry an image
 * extension — raw `.fit`/`.fits` sub-frames and stacked JPGs are never touched.
 *
 * Pass `dryRun: true` to count without deleting. File counts are refreshed for
 * every affected object so library listings stay accurate.
 */
export function purgeSubFrameImages(opts: { dryRun?: boolean } = {}): SubFrameImagePurgeResult {
  const LIBRARY_DIR = getLibraryDir();
  const result: SubFrameImagePurgeResult = { scannedObjects: 0, matched: 0, deleted: 0, errors: 0, groups: [] };
  if (!fs.existsSync(LIBRARY_DIR)) return result;

  // folderName -> objectId, so we can refresh the stored file count after
  // deletes. Best-effort: the purge still runs if the index can't be loaded.
  const folderToObjectId = new Map<string, string>();
  try {
    for (const [objectId, meta] of Object.entries(loadIndex().objects)) {
      folderToObjectId.set(meta.folderName, objectId);
    }
  } catch { /* count refresh is best-effort */ }

  for (const folderName of fs.readdirSync(LIBRARY_DIR)) {
    const objDir = path.join(LIBRARY_DIR, folderName);
    try {
      if (!fs.statSync(objDir).isDirectory()) continue;
    } catch { continue; }
    result.scannedObjects++;

    let removedHere = 0;
    let matchedHere = 0;
    const groupFiles: string[] = [];
    // Layout-aware: frame-named previews land inside session directories for a
    // nested object, and this purge would otherwise never find them.
    const objectIdForDir = folderToObjectId.get(folderName);
    const entries = listObjectFiles(objDir, objectIdForDir ? getObjectLayout(objectIdForDir) : 'flat');
    for (const entry of entries) {
      if (!isRealFile(entry.fileName)) continue;
      if (!isSubFramePreview(entry.fileName)) continue;
      result.matched++;
      matchedHere++;
      if (groupFiles.length < FILES_PER_GROUP_CAP) groupFiles.push(entry.relPath);
      if (!opts.dryRun) {
        try {
          fs.unlinkSync(path.join(objDir, entry.relPath));
          deleteLibraryFileRow(`${folderName}/${entry.relPath}`);
          result.deleted++; removedHere++;
        } catch { result.errors++; }
      }
    }

    if (matchedHere > 0) {
      result.groups.push({ folder: folderName, count: matchedHere, files: groupFiles });
    }

    if (removedHere > 0) {
      const objectId = folderToObjectId.get(folderName);
      if (objectId) {
        try {
          const remaining = listObjectFiles(objDir, getObjectLayout(objectId))
            .filter(e => isRealFile(e.fileName)).length;
          stmts.updateObjectFileCount.run(remaining, objectId);
        } catch { /* ignore */ }
      }
    }
  }

  return result;
}

/**
 * Move a single observation (session) from one object to another.
 * Moves all files for that date on disk and updates all DB records.
 */
export function moveObservation(fromObjectId: string, date: string, toObjectId: string): { moved: number } {
  const LIBRARY_DIR = getLibraryDir();
  const fromDir = path.join(LIBRARY_DIR, getFolderName(fromObjectId));
  const toFolderName = getFolderName(toObjectId);
  const toDir = path.join(LIBRARY_DIR, toFolderName);

  if (fromObjectId === toObjectId) {
    throw new Error('Source and target objects are the same');
  }

  // Find files to move. Object-relative paths, so a nested source keeps its
  // session directory and lands under the same directory in the target.
  const fromFolderName = getFolderName(fromObjectId);
  const fromLayout = getObjectLayout(fromObjectId);
  const identity = resolverFor(fromObjectId);
  const fromDirExists = fs.existsSync(fromDir);
  const allFiles = fromDirExists
    ? listObjectFiles(fromDir, fromLayout).filter(e => isRealFile(e.fileName))
    : [];
  const filesToMove = allFiles.filter(e => identity.session(e.relPath) === date);

  // Ensure target directory exists
  if (!fs.existsSync(toDir)) {
    fs.mkdirSync(toDir, { recursive: true });
  }

  // Moving a nested session into a flat target (or vice versa) would leave the
  // target holding both shapes at once, which no read path can explain. Adopt
  // the source's shape when the target has no files of its own; otherwise keep
  // the session's directory only when both sides agree it is nested.
  const targetHasFiles = fs.existsSync(toDir)
    && listObjectFiles(toDir, getObjectLayout(toObjectId)).length > 0;
  const keepSessionDirs = targetHasFiles
    ? getObjectLayout(toObjectId) === 'nested' && fromLayout === 'nested'
    : fromLayout === 'nested';

  /** Where a source entry lands inside the target object folder. */
  const destRelFor = (e: { relPath: string; fileName: string }): string =>
    keepSessionDirs ? e.relPath : e.fileName;

  // Move files on disk.
  // If the destination already has a file with the same name (e.g. from a
  // previous partial move or auto-import re-downloading from the telescope),
  // remove the source copy — the target already has the canonical version.
  let moved = 0;
  const movedDirs = new Set<string>();
  for (const entry of filesToMove) {
    const destRel = destRelFor(entry);
    const src = path.join(fromDir, entry.relPath);
    const dest = path.join(toDir, destRel);
    if (entry.sessionFolder) movedDirs.add(entry.sessionFolder);
    if (fs.existsSync(dest)) {
      // Target already has this file — just remove the stale source copy.
      try { fs.unlinkSync(src); moved++; } catch { /* ignore */ }
    } else {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
      } catch (renameErr) {
        if (isErrnoException(renameErr) && renameErr.code === 'EXDEV') {
          fs.copyFileSync(src, dest);
          fs.unlinkSync(src);
        } else {
          throw renameErr;
        }
      }
      moved++;
    }
  }

  // Follow the files in libraryFiles. A row already sitting at the destination
  // path means the target owns that file now, so the source row is dropped
  // rather than moved onto it (relPath is UNIQUE).
  for (const entry of filesToMove) {
    const destRel = destRelFor(entry);
    const fromRel = `${fromFolderName}/${entry.relPath}`;
    if (getLibraryFileRow(`${toFolderName}/${destRel}`)) {
      deleteLibraryFileRow(fromRel);
    } else {
      moveLibraryFileRow(fromRel, toObjectId, toFolderName, destRel);
    }
  }

  // Drop session directories the move emptied out.
  for (const dir of movedDirs) {
    const abs = path.join(fromDir, dir);
    try {
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch { /* not empty or unreadable — leave it */ }
  }

  // Processed images live in a separate `<objectFolder>/processed/` directory
  // with rows in `sessionProcessedImages` keyed by objectId+date. Their
  // `proc_*` filenames never parse to a session date, so the loop above skips
  // them — move their files and reassign their rows explicitly.
  const processedRows = stmts.getProcessedImages.all(fromObjectId, date);
  if (processedRows.length > 0) {
    const fromProcessedDir = path.join(fromDir, 'processed');
    const toProcessedDir = path.join(toDir, 'processed');
    if (!fs.existsSync(toProcessedDir)) fs.mkdirSync(toProcessedDir, { recursive: true });
    for (const row of processedRows) {
      const src = path.join(fromProcessedDir, row.filename);
      const dest = path.join(toProcessedDir, row.filename);
      if (!fs.existsSync(src)) continue; // row's file already gone — DB row still reassigned below
      if (fs.existsSync(dest)) {
        try { fs.unlinkSync(src); } catch { /* ignore */ }
      } else {
        try {
          fs.renameSync(src, dest);
        } catch (renameErr) {
          if (isErrnoException(renameErr) && renameErr.code === 'EXDEV') {
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
          } else {
            throw renameErr;
          }
        }
      }
    }
  }

  // Update DB in a transaction
  const updateDb = db.transaction(() => {
    // Ensure target object exists in DB
    const targetExists = stmts.getObject.get(toObjectId);
    if (!targetExists) {
      const cat = resolveCatalogMeta(toObjectId);
      stmts.upsertObject.run(toObjectId, toFolderName, 0, new Date().toISOString(), 0, null,
        cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
        cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
    }
    // An empty target adopts the source's shape. Must run after the upsert
    // above: setObjectLayout is an UPDATE, so doing it earlier would silently
    // no-op and leave a nested folder being read as flat.
    if (!targetHasFiles && keepSessionDirs) setObjectLayout(toObjectId, 'nested');

    // Tombstone the source session so it cannot resurface from disk (e.g. if
    // auto-import re-downloads the files from the telescope into the source folder).
    stmts.addSessionTombstone.run(fromObjectId, date);

    // Move note if one exists
    db.prepare('UPDATE notes SET objectId = ? WHERE objectId = ? AND date = ?')
      .run(toObjectId, fromObjectId, date);

    // Reassign processed-image rows so they surface under the target object.
    db.prepare('UPDATE sessionProcessedImages SET objectId = ? WHERE objectId = ? AND date = ?')
      .run(toObjectId, fromObjectId, date);

    // Recount files for both objects
    const fromRemaining = fs.existsSync(fromDir)
      ? listObjectFiles(fromDir, getObjectLayout(fromObjectId)).filter(e => isRealFile(e.fileName))
      : [];
    stmts.updateObjectFileCount.run(fromRemaining.length, fromObjectId);

    const toFiles = listObjectFiles(toDir, getObjectLayout(toObjectId)).filter(e => isRealFile(e.fileName));
    stmts.updateObjectFileCount.run(toFiles.length, toObjectId);

    // Rebuild sessions for source from remaining disk files (excluding the
    // tombstoned date so it cannot be re-added here). Fresh resolvers: the
    // rows moved above, so the ones built before the move are stale.
    const fromIdentity = resolverFor(fromObjectId);
    const fromSessionSet = new Set<string>();
    for (const entry of fromRemaining) {
      const night = fromIdentity.session(entry.relPath);
      if (night && night !== date) fromSessionSet.add(night);
    }
    stmts.clearSessions.run(fromObjectId);
    for (const d of fromSessionSet) {
      stmts.addSession.run(fromObjectId, d);
    }

    // Rebuild sessions for target from actual files on disk
    const toIdentity = resolverFor(toObjectId);
    const toSessionSet = new Set<string>();
    for (const entry of toFiles) {
      const night = toIdentity.session(entry.relPath);
      if (night) toSessionSet.add(night);
    }
    // Snapshot any manual (DB-only) sessions on the target before clearing
    const existingTargetSessions = stmts.getSessions.all(toObjectId) as { date: string }[];
    const manualDates = existingTargetSessions
      .map(s => s.date)
      .filter(d => !toSessionSet.has(d));
    stmts.clearSessions.run(toObjectId);
    for (const d of toSessionSet) {
      stmts.addSession.run(toObjectId, d);
    }
    for (const d of manualDates) {
      stmts.addSession.run(toObjectId, d);
    }

    // Update target catalog metadata (might have been unknown before)
    const cat = resolveCatalogMeta(toObjectId);
    db.prepare(
      `UPDATE libraryObjects SET catalogId=?, objectName=?, objectType=?, constellation=?,
       description=?, magnitude=?, ra=?, dec=?, distanceLy=?, lastImport=?, deleted=0, deletedAt=NULL
       WHERE objectId=?`
    ).run(cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
      cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy, new Date().toISOString(), toObjectId);
  });
  updateDb();

  writeObjectManifest(fromObjectId, fromFolderName);
  writeObjectManifest(toObjectId, toFolderName);

  return { moved };
}

// ─── Telescope reassignment ─────────────────────────────────────────────────

/** Look up which telescope captured a session, falling back to the object's
 *  primaryTelescopeId when the session itself is unstamped (legacy data).
 *  Used by per-session sync/resync routes so re-pulling files always targets
 *  the telescope that originally captured them, regardless of which scope
 *  is currently "active" in Settings. */
export function getSessionTelescopeId(objectId: string, date: string): string | null {
  const row = stmts.getSession.get(objectId, date);
  if (row?.telescopeId) return row.telescopeId;
  const obj = stmts.getObject.get(objectId);
  return obj?.primaryTelescopeId ?? null;
}

/** Look up an object's primaryTelescopeId directly, for callers that don't
 *  have a specific session date to check first (e.g. a per-object import
 *  triggered without an explicit telescope). */
export function getObjectPrimaryTelescopeId(objectId: string): string | null {
  return stmts.getObject.get(objectId)?.primaryTelescopeId ?? null;
}

/** Reassign a session (objectId+date) to a different telescope. Returns
 *  true if a row was updated. Side effect: refreshes the object's
 *  primaryTelescopeId from the new session-count distribution. */
export function reassignSessionTelescope(objectId: string, date: string, telescopeId: string): boolean {
  const update = db.prepare(
    'UPDATE librarySessions SET telescopeId = ? WHERE objectId = ? AND date = ?',
  ).run(telescopeId, objectId, date);

  if (update.changes > 0) {
    // Recompute primaryTelescopeId based on the new session distribution.
    const top = db
      .prepare<[string], { telescopeId: string; n: number }>(
        `SELECT telescopeId, COUNT(*) as n FROM librarySessions
           WHERE objectId = ? AND telescopeId IS NOT NULL
           GROUP BY telescopeId ORDER BY n DESC LIMIT 1`,
      )
      .get(objectId);
    if (top?.telescopeId) {
      stmts.setObjectPrimaryTelescope.run(top.telescopeId, objectId);
    }
  }
  return update.changes > 0;
}

/**
 * Reassign a session (objectId+date) to a different observing site. `siteId:
 * null` clears the tag, which resolves back to the default site (see
 * siteForSession). Returns true if a row was updated.
 *
 * Side effect: nulls the session's cached weather columns. They were fetched
 * at the OLD site's coordinates and are now wrong for the new one; the caller
 * is expected to kick off backfillSessionWeather(objectId) afterward (the
 * route handler does this in the background) so the columns get re-filled at
 * the new coordinates instead of just going blank until the next import.
 */
export function reassignSessionSite(objectId: string, date: string, siteId: string | null): boolean {
  const update = db.prepare(
    `UPDATE librarySessions
        SET siteId = ?, temperature = NULL, cloudCover = NULL, humidity = NULL,
            windSpeed = NULL, dewPoint = NULL, visibility = NULL, precipProb = NULL
      WHERE objectId = ? AND date = ?`,
  ).run(siteId, objectId, date);
  return update.changes > 0;
}
