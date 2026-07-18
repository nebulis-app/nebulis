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
  sessionNightFor,
  rolloverDateUnconditional,
} from '../telescopeFiles.js';
import { getNote } from '../notes.js';
import { parseFitsHeader } from '../fitsParser.js';
import { fitsThumbnailRelName } from '../fitsThumbnail.js';
import {
  stmts,
  getFolderName,
  resolveCatalogMeta,
  loadSettings,
  loadIndex,
  LIBRARY_API_BASE,
} from './objects.js';

// ─── Session weather ────────────────────────────────────────────────────────

import type { SessionWeather } from '../types/session.js';
export type { SessionWeather };

/**
 * Fetch historical weather for a date from Open-Meteo's archive API.
 * Returns average conditions during nighttime hours (8 PM – 4 AM) for the date.
 * Returns null if location is not set or the API call fails.
 */
async function fetchSessionWeather(date: string): Promise<SessionWeather | null> {
  const settings = loadSettings();
  // Narrow via typeof instead of casting — settings comes back as `Record<string, unknown>`.
  const lat = typeof settings.latitude === 'number' ? settings.latitude : null;
  const lon = typeof settings.longitude === 'number' ? settings.longitude : null;
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
  for (const row of rows) {
    if (row.temperature != null) continue; // already has weather
    if (row.date === 'unknown') continue;
    const weather = await fetchSessionWeather(row.date);
    if (weather) {
      stmts.setSessionWeather.run(
        weather.temperature, weather.cloudCover, weather.humidity,
        weather.windSpeed, weather.dewPoint, weather.visibility, weather.precipProb,
        objectId, row.date
      );
    }
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
      sessionMap.set(r.date, { fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, imageCount: 0, thumbnailFile: null, stackedImageFile: null, anyImageFile: null });
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

  const files = fs.readdirSync(objDir).filter(f => isRealFile(f) && !f.startsWith('sky_') && !f.startsWith('gallery_'));

  for (const fname of files) {
    const parsed = parseFilename(fname);
    const sessionKey = sessionNightFor(parsed);
    if (!sessionKey) continue; // skip files we can't assign a session date to
    if (deletedSessions.has(sessionKey)) continue;
    if (!sessionMap.has(sessionKey)) {
      sessionMap.set(sessionKey, { fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, imageCount: 0, thumbnailFile: null, stackedImageFile: null, anyImageFile: null });
    }
    const s = sessionMap.get(sessionKey)!;
    s.fileCount++;
    if (parsed.type === 'stacked') s.stackedKeys.add(fname.slice(0, fname.length - path.extname(fname).length));
    if (parsed.isThumbnail && !s.thumbnailFile) s.thumbnailFile = fname;
    const isViewableImage = parsed.extension === '.jpg' || parsed.extension === '.jpeg'
      || parsed.extension === '.png' || parsed.extension === '.tif' || parsed.extension === '.tiff';
    if (!parsed.isThumbnail && parsed.type === 'stacked' && !s.stackedImageFile && isViewableImage) {
      s.stackedImageFile = fname;
    }
    if (!parsed.isThumbnail && parsed.type !== 'stacked' && !s.anyImageFile && isViewableImage) {
      s.anyImageFile = fname;
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

  return fs.readdirSync(objDir)
    .filter(f => isRealFile(f) && !f.startsWith('sky_') && !f.startsWith('gallery_'))
    .filter(fname => {
      if (!sessionDate) return true;
      return sessionNightFor(parseFilename(fname)) === sessionDate;
    })
    .map(fname => {
      const parsed = parseFilename(fname);
      const fullPath = path.join(objDir, fname);
      const stat = fs.statSync(fullPath);
      const category = getFileCategory(fname);
      // `getFileCategory` and `parsed.type` come back as wider string types
      // (from helpers in telescopeFiles). Runtime values are always within the
      // literal unions below, so we narrow via a guard + fallback instead of
      // asserting through. SQL/helper trust boundary.
      const knownType: 'image' | 'fits' | 'video' | 'thumbnail' | 'other' =
        category === 'image' || category === 'fits' || category === 'video' || category === 'thumbnail'
          ? category : 'other';
      const knownFileType: 'stacked' | 'sub' | 'thumbnail' | 'video' | 'other' =
        parsed.type === 'stacked' || parsed.type === 'sub' || parsed.type === 'thumbnail' || parsed.type === 'video'
          ? parsed.type : 'other';
      return {
        name: fname,
        size: stat.size,
        type: knownType,
        fileType: knownFileType,
        path: `${folderName}/${fname}`,
        exposure: parsed.exposure || null,
        filter: parsed.filter || null,
        timestamp: parsed.timestamp || null,
        date: parsed.date || null,
        frameCount: parsed.frameCount || null,
        isThumbnail: parsed.isThumbnail,
        downloadUrl: `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(`${folderName}/${fname}`)}`,
        thumbUrl: fs.existsSync(path.join(objDir, '.thumbs', fitsThumbnailRelName(fname)))
          ? `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(`${folderName}/.thumbs/${fitsThumbnailRelName(fname)}`)}`
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

    const files = fs.readdirSync(objDir);
    try { reconcileStaleSessionDates(objectId, files); } catch { /* best-effort */ }
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
    }>();

    // Seed from DB so note-only manual entries appear on the calendar
    for (const d of sessions) {
      if (d === 'unknown') continue;
      if (!sessionMap.has(d)) {
        sessionMap.set(d, { timestamps: [], fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, stackedImageFile: null });
      }
    }

    for (const fname of files) {
      const parsed = parseFilename(fname);
      if (parsed.isThumbnail) continue;
      const date = sessionNightFor(parsed);
      if (!date) continue; // skip files we can't assign a session date to
      if (!sessionMap.has(date)) {
        sessionMap.set(date, { timestamps: [], fileCount: 0, stackedKeys: new Set(), fitsCount: 0, subFrameCount: 0, stackedImageFile: null });
      }
      const s = sessionMap.get(date)!;
      s.fileCount++;
      if (parsed.timestamp) s.timestamps.push(parsed.timestamp);
      if (parsed.type === 'stacked') s.stackedKeys.add(fname.slice(0, fname.length - path.extname(fname).length));
      if (parsed.type === 'sub') s.subFrameCount++;
      const ext = parsed.extension?.toLowerCase();
      if (ext === '.fit' || ext === '.fits') s.fitsCount++;
      const isViewableImage = ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.tif' || ext === '.tiff';
      if (!s.stackedImageFile && parsed.type === 'stacked' && isViewableImage) {
        s.stackedImageFile = fname;
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

  // Fall back to user's configured observer location if no FITS coordinates
  if (!coordinates) {
    const settings = loadSettings();
    const lat = typeof settings.latitude === 'number' ? settings.latitude : null;
    const lon = typeof settings.longitude === 'number' ? settings.longitude : null;
    if (lat !== null && lon !== null) {
      coordinates = { lat, lon };
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

  // Now safe to remove files
  if (fs.existsSync(objDir)) {
    for (const fname of fs.readdirSync(objDir).filter(isRealFile)) {
      const parsed = parseFilename(fname);
      if (sessionNightFor(parsed) === date) {
        try { fs.unlinkSync(path.join(objDir, fname)); } catch { /* ignore */ }
      }
    }
  }

  // Recount remaining files
  try {
    const remaining = fs.existsSync(objDir) ? fs.readdirSync(objDir).filter(isRealFile) : [];
    stmts.updateObjectFileCount.run(remaining.length, objectId);
  } catch { /* ignore */ }
}

/**
 * Delete only the raw sub-frame (.fit/.fits) files for a specific session date.
 * Leaves stacked images, thumbnails, and other files for that session intact.
 */
export function deleteSessionSubFrames(objectId: string, date: string): { deleted: number } {
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.join(LIBRARY_DIR, getFolderName(objectId));
  let deleted = 0;
  if (fs.existsSync(objDir)) {
    for (const fname of fs.readdirSync(objDir).filter(isRealFile)) {
      const parsed = parseFilename(fname);
      if (parsed.type === 'sub' && sessionNightFor(parsed) === date) {
        try { fs.unlinkSync(path.join(objDir, fname)); deleted++; } catch { /* ignore */ }
      }
    }
  }
  try {
    const remaining = fs.existsSync(objDir) ? fs.readdirSync(objDir).filter(isRealFile) : [];
    stmts.updateObjectFileCount.run(remaining.length, objectId);
  } catch { /* ignore */ }
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
    let entries: string[];
    try { entries = fs.readdirSync(objDir); } catch { continue; }
    for (const fname of entries) {
      if (!isRealFile(fname)) continue;
      if (!isSubFramePreview(fname)) continue;
      result.matched++;
      matchedHere++;
      if (groupFiles.length < FILES_PER_GROUP_CAP) groupFiles.push(fname);
      if (!opts.dryRun) {
        try { fs.unlinkSync(path.join(objDir, fname)); result.deleted++; removedHere++; }
        catch { result.errors++; }
      }
    }

    if (matchedHere > 0) {
      result.groups.push({ folder: folderName, count: matchedHere, files: groupFiles });
    }

    if (removedHere > 0) {
      const objectId = folderToObjectId.get(folderName);
      if (objectId) {
        try {
          const remaining = fs.readdirSync(objDir).filter(isRealFile).length;
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

  // Find files to move
  const fromDirExists = fs.existsSync(fromDir);
  const allFiles = fromDirExists ? fs.readdirSync(fromDir).filter(isRealFile) : [];
  const filesToMove = allFiles.filter(fname => sessionNightFor(parseFilename(fname)) === date);

  // Ensure target directory exists
  if (!fs.existsSync(toDir)) {
    fs.mkdirSync(toDir, { recursive: true });
  }

  // Move files on disk.
  // If the destination already has a file with the same name (e.g. from a
  // previous partial move or auto-import re-downloading from the telescope),
  // remove the source copy — the target already has the canonical version.
  let moved = 0;
  for (const fname of filesToMove) {
    const src = path.join(fromDir, fname);
    const dest = path.join(toDir, fname);
    if (fs.existsSync(dest)) {
      // Target already has this file — just remove the stale source copy.
      try { fs.unlinkSync(src); moved++; } catch { /* ignore */ }
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
      moved++;
    }
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
    const fromRemaining = fs.existsSync(fromDir) ? fs.readdirSync(fromDir).filter(isRealFile) : [];
    stmts.updateObjectFileCount.run(fromRemaining.length, fromObjectId);

    const toFiles = fs.readdirSync(toDir).filter(isRealFile);
    stmts.updateObjectFileCount.run(toFiles.length, toObjectId);

    // Rebuild sessions for source from remaining disk files (excluding the
    // tombstoned date so it cannot be re-added here).
    const fromSessionSet = new Set<string>();
    for (const fname of fromRemaining) {
      const night = sessionNightFor(parseFilename(fname));
      if (night && night !== date) fromSessionSet.add(night);
    }
    stmts.clearSessions.run(fromObjectId);
    for (const d of fromSessionSet) {
      stmts.addSession.run(fromObjectId, d);
    }

    // Rebuild sessions for target from actual files on disk
    const toSessionSet = new Set<string>();
    for (const fname of toFiles) {
      const night = sessionNightFor(parseFilename(fname));
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
