/**
 * Catalog prefetch job — one-time bulk download of imagery + Wikipedia
 * descriptions for every DSO in the local catalog.
 *
 * Runs in two phases:
 *   1. Images   — CDS DSS2 via the existing `prefetchSkyImage()` helper.
 *                 Concurrency 3 (alasky.cds.unistra.fr is not fast).
 *   2. Wikipedia — summaries + canonical URLs stored in `catalogCache`.
 *                 Concurrency 5 (Wikipedia is quick and rate-limit-tolerant).
 *
 * Both phases are **resumable**: re-running the job skips items that are
 * already in the cache (disk file present for images, row present for
 * Wikipedia). A `force=true` option wipes the Wikipedia cache rows to re-fetch
 * every description, but leaves image files alone (they're immutable DSS2
 * survey data — nothing to refresh).
 *
 * Status is mirrored to `catalogPrefetchStatus` on every step so the settings
 * UI can poll it, and so a server restart shows "running" as `false` even if
 * the in-memory job was killed mid-flight.
 */

import fs from 'fs';
import path from 'path';
import sharp from './sharp-optional.js';
import db from './db.js';
import { getCatalog, getById as getDsoById } from './dsoCatalog.js';
import { DATA_DIR } from './paths.js';
import { prefetchSkyImage, clearNegativeImageCache } from './skyImage.js';
import { fetchWikipediaSummary } from './wikipedia.js';
import { fetchCaldwellEntry } from './caldwellScraper.js';
import { ngcToCaldwell, caldwellToNgcId } from './caldwellCatalog.js';
import { resolveCanonicalId } from './catalogAliases.js';
import { POPULAR_DSO_IDS } from './popularDsoCatalog.js';
import { getSharplessEntry } from './sharplessCatalog.js';
import { SOLAR_SYSTEM_CATALOG } from '../data/solar-system-catalog.js';
import { installCatalogPacks } from './catalogPack/install.js';
import { clearPackState } from './catalogPack/state.js';
import type { CatalogTier } from './catalogPack/manifest.js';

const IMAGE_CONCURRENCY = 3;
const WIKI_CONCURRENCY = 5;

// DSS2 master image dimensions. The catalog route resizes from this on demand
// for any thumbnail size a client asks for, so this is the single source of
// truth for "how big do we download from CDS HiPS." Sized to comfortably cover
// 1920×1080 displays after FOV cropping.
export const MASTER_WIDTH = 1920;
export const MASTER_HEIGHT = 1280;

/**
 * Canonical thumbnail sizes that every client requests. Mirrored from each
 * platform's APIClient / catalogImage helpers. Pre-warming these during
 * prefetch means the first user to open any view never pays the resize tax.
 *
 * Keep in sync with:
 *   - src/lib/catalogImage.ts (CATALOG_IMAGE_WIDTH / HEIGHT)
 *   - seestar-apple/NebulisIOS/Services/APIClient.swift (skySurveyThumbnail*)
 */
const CANONICAL_THUMBNAIL_SIZES: ReadonlyArray<{ w: number; h: number; fit: ResizeFit }> = [
  { w: 384,  h: 384,  fit: 'inside' },  // Web — square library / preview tiles
  { w: 600,  h: 400,  fit: 'inside' },  // iOS — 3:2 grid tiles, planner sheets
  { w: 800,  h: 520,  fit: 'inside' },  // tvOS — 400×260pt @2x library tiles
  { w: 1920, h: 1080, fit: 'cover'  },  // tvOS — 16:9 full-screen, center-cropped from 3:2 master
];

/**
 * Generate every canonical thumbnail for a master that's already on disk.
 * Idempotent — skips sizes that already exist, never throws (logs and moves on).
 *
 * Each entry's `fit` mode mirrors the on-demand resize behavior in the catalog
 * route so a pre-warmed file is byte-equivalent to a lazy-resized one.
 */
export async function prewarmThumbnails(id: string, masterPath: string, source: CatalogMasterSource): Promise<void> {
  const resizedDir = path.join(DATA_DIR, 'sky-cache', 'resized');
  try { fs.mkdirSync(resizedDir, { recursive: true }); } catch { /* exists */ }

  await Promise.all(CANONICAL_THUMBNAIL_SIZES.map(async ({ w, h, fit }) => {
    const dest = resizedImagePath(id, w, h, fit, source);
    try {
      const stat = fs.statSync(dest);
      if (stat.size > 0) return;
    } catch { /* not present, generate */ }

    try {
      // `cover` variants always render at full W×H (no `withoutEnlargement`)
      // because letterboxing a small master into a TV-sized frame defeats
      // the whole point of asking for a fill.
      await sharp(masterPath)
        .resize(w, h, fit === 'cover'
          ? { fit: 'cover', position: 'centre' }
          : { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toFile(dest);
    } catch (err) {
      console.warn(`[prefetch] prewarm failed for ${id} ${w}x${h} (${fit}):`, err instanceof Error ? err.message : err);
    }
  }));
}

// ─── Persistent status (mirrors in-memory to DB) ─────────────────────────

// Add per-phase completion timestamp columns if not present (migration for existing installs)
for (const col of ['imagesCompletedAt', 'wikiCompletedAt', 'caldwellCompletedAt', 'packCompletedAt']) {
  try { db.prepare(`ALTER TABLE catalogPrefetchStatus ADD COLUMN ${col} INTEGER`).run(); } catch { /* already exists */ }
}

export type PrefetchPhase = 'idle' | 'pack' | 'images' | 'wikipedia' | 'caldwell' | 'done' | 'cancelled' | 'error';

export interface PrefetchStatus {
  running: boolean;
  phase: PrefetchPhase;
  processed: number;
  total: number;
  errors: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string;
  imagesCompletedAt: number | null;
  wikiCompletedAt: number | null;
  caldwellCompletedAt: number | null;
  packCompletedAt: number | null;
}

// Raw DB row for the prefetch status. INTEGER columns come in as number,
// the phase TEXT is stored free-form and narrowed via isPrefetchPhase.
interface PrefetchStatusRow {
  id: number;
  running: number;
  phase: string;
  processed: number;
  total: number;
  errors: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string;
  imagesCompletedAt: number | null;
  wikiCompletedAt: number | null;
  caldwellCompletedAt: number | null;
  packCompletedAt: number | null;
}

const getStatusStmt = db.prepare<[], PrefetchStatusRow>('SELECT * FROM catalogPrefetchStatus WHERE id = 1');
const setStatusStmt = db.prepare(
  `UPDATE catalogPrefetchStatus SET
    running = ?, phase = ?, processed = ?, total = ?, errors = ?,
    startedAt = ?, finishedAt = ?, lastError = ?,
    imagesCompletedAt = ?, wikiCompletedAt = ?, caldwellCompletedAt = ?, packCompletedAt = ?
   WHERE id = 1`,
);

const PREFETCH_PHASES = ['idle', 'pack', 'images', 'wikipedia', 'caldwell', 'done', 'cancelled', 'error'] as const;
function isPrefetchPhase(v: string): v is PrefetchPhase {
  return (PREFETCH_PHASES as readonly string[]).includes(v);
}

function rowToStatus(row: PrefetchStatusRow): PrefetchStatus {
  return {
    running: Boolean(row.running),
    phase: isPrefetchPhase(row.phase) ? row.phase : 'idle',
    processed: row.processed,
    total: row.total,
    errors: row.errors,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lastError: row.lastError,
    imagesCompletedAt: row.imagesCompletedAt,
    wikiCompletedAt: row.wikiCompletedAt,
    caldwellCompletedAt: row.caldwellCompletedAt,
    packCompletedAt: row.packCompletedAt,
  };
}

export function getPrefetchStatus(): PrefetchStatus {
  const row = getStatusStmt.get();
  // The row is seeded by INSERT OR IGNORE at db.ts load time, so a missing row
  // is a schema bug worth crashing on rather than silently defaulting.
  if (!row) throw new Error('[catalogPrefetch] catalogPrefetchStatus row missing');
  return rowToStatus(row);
}

function saveStatus(s: PrefetchStatus): void {
  setStatusStmt.run(
    s.running ? 1 : 0,
    s.phase,
    s.processed,
    s.total,
    s.errors,
    s.startedAt,
    s.finishedAt,
    s.lastError,
    s.imagesCompletedAt,
    s.wikiCompletedAt,
    s.caldwellCompletedAt,
    s.packCompletedAt,
  );
}

// Server restart safety — if we see `running=1` at boot, the previous job was
// killed mid-flight. Mark it as cancelled so the UI doesn't show an infinitely
// hanging job.
{
  const s = getPrefetchStatus();
  if (s.running) {
    saveStatus({ ...s, running: false, phase: 'cancelled', finishedAt: Date.now() });
  }
}

// ─── catalogCache helpers ────────────────────────────────────────────────

// Case-insensitive existence check: "Sh2-274" and "SH2-274" are the same object.
// The pack build may store entries under "Sh2-N" while library objectIds are
// "SH2-N" — COLLATE NOCASE bridges that gap without any data migration.
const getCacheStmt = db.prepare(
  'SELECT objectId FROM catalogCache WHERE objectId = ? COLLATE NOCASE',
);
const upsertCacheStmt = db.prepare(
  `INSERT INTO catalogCache (objectId, extract, wikiUrl, source, fetchedAt, status)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(objectId) DO UPDATE SET
     extract = excluded.extract,
     wikiUrl = excluded.wikiUrl,
     source = excluded.source,
     fetchedAt = excluded.fetchedAt,
     status = excluded.status`,
);
const clearCacheStmt = db.prepare('DELETE FROM catalogCache');

export interface CatalogCacheRow {
  objectId: string;
  extract: string;
  wikiUrl: string;
  status: 'ok' | 'not_found' | 'error';
}

// Case-insensitive lookup, preferring 'ok' rows so a stale 'not_found' written
// under "SH2-274" can't shadow a good entry stored as "Sh2-274" by the pack.
const getCatalogCacheEntryStmt = db.prepare<[string], CatalogCacheRow>(
  `SELECT objectId, extract, wikiUrl, status FROM catalogCache
   WHERE objectId = ? COLLATE NOCASE
   ORDER BY CASE WHEN status = 'ok' THEN 0 ELSE 1 END
   LIMIT 1`,
);

export function getCatalogCacheEntry(objectId: string): CatalogCacheRow | null {
  const canonical = resolveCanonicalId(objectId);
  return getCatalogCacheEntryStmt.get(canonical) ?? null;
}

// ─── Cache stats + wipe ──────────────────────────────────────────────────

export interface CatalogCacheStats {
  /** DSS2 sky-plate masters (<id>_master.jpg) */
  dss2Count: number;
  dss2Bytes: number;
  /** Wikipedia thumbnail images (wiki_<id>.jpg) */
  wikiImageCount: number;
  wikiImageBytes: number;
  /** NASA Hubble Caldwell images (hubble_<id>.webp) */
  caldwellCount: number;
  caldwellBytes: number;
  /** Wikipedia text extracts with status='ok' */
  wikiWithExtract: number;
  /** Objects not found on Wikipedia */
  wikiNotFound: number;
}

export function getCatalogCacheStats(): CatalogCacheStats {
  const skyDir = path.join(DATA_DIR, 'sky-cache');
  let dss2Count = 0, dss2Bytes = 0;
  let wikiImageCount = 0, wikiImageBytes = 0;
  let caldwellCount = 0, caldwellBytes = 0;

  try {
    for (const name of fs.readdirSync(skyDir)) {
      try {
        const stat = fs.statSync(path.join(skyDir, name));
        if (!stat.isFile()) continue;
        if (name.startsWith('hubble_') && name.endsWith('.webp')) {
          caldwellCount++; caldwellBytes += stat.size;
        } else if (name.startsWith('wiki_') && name.endsWith('.jpg')) {
          wikiImageCount++; wikiImageBytes += stat.size;
        } else if (name.endsWith('_master.jpg')) {
          dss2Count++; dss2Bytes += stat.size;
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir may not exist yet */ }

  // Typed prepared statement — SQL trust boundary enforced by catalogCache schema.
  const wikiCountsStmt = db.prepare<[], { ok: number | null; notFound: number | null }>(
    `SELECT
       SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
       SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) AS notFound
     FROM catalogCache`,
  );
  // SUM always returns exactly one row, so assert non-undefined via `?? defaults`.
  const wikiCounts = wikiCountsStmt.get() ?? { ok: 0, notFound: 0 };

  return {
    dss2Count,
    dss2Bytes,
    wikiImageCount,
    wikiImageBytes,
    caldwellCount,
    caldwellBytes,
    wikiWithExtract: wikiCounts.ok ?? 0,
    wikiNotFound: wikiCounts.notFound ?? 0,
  };
}

/**
 * Nuke everything: stop any running job, wipe the catalogCache table, delete
 * every file in the sky-cache directory, and reset the status row. Used by
 * the "Reinitialize catalog" button in settings.
 */
export function wipeCatalogCache(): void {
  // Stop the running job first
  if (currentController) {
    currentController.abort();
    currentController = null;
  }

  // Wipe Wikipedia table and pack install state so packs re-download on next run
  clearCacheStmt.run();
  clearPackState();

  // Forget every negative-cache entry (24h persistent + in-memory transient)
  // so a re-download retries objects that previously 404'd or failed instead
  // of silently skipping them.
  clearNegativeImageCache();

  // Wipe every image file in sky-cache (leave the Sesame JSON cache alone
  // so we don't lose RA/Dec resolutions). Includes the resized/ subdirectory
  // where the catalog route stores Sharp-generated thumbnails, and the
  // per-tier credits-<tier>.json files the pack installer writes alongside
  // the images (left behind previously since they don't end in .jpg/.webp).
  const skyDir = path.join(DATA_DIR, 'sky-cache');
  try {
    for (const name of fs.readdirSync(skyDir)) {
      const isImage = name.endsWith('.jpg') || name.endsWith('.webp');
      const isCredits = name.startsWith('credits-') && name.endsWith('.json');
      if (!isImage && !isCredits) continue;
      try { fs.unlinkSync(path.join(skyDir, name)); } catch { /* best-effort */ }
    }
  } catch { /* dir may not exist */ }
  const resizedDir = path.join(skyDir, 'resized');
  try {
    for (const name of fs.readdirSync(resizedDir)) {
      if (!name.endsWith('.jpg')) continue;
      try { fs.unlinkSync(path.join(resizedDir, name)); } catch { /* best-effort */ }
    }
  } catch { /* dir may not exist */ }

  // Reset status row to fresh state, clearing all per-phase timestamps
  saveStatus({
    running: false,
    phase: 'idle',
    processed: 0,
    total: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    lastError: '',
    imagesCompletedAt: null,
    wikiCompletedAt: null,
    caldwellCompletedAt: null,
    packCompletedAt: null,
  });
}

// ─── Concurrency helper ──────────────────────────────────────────────────

/**
 * Run an async worker over an array with a fixed concurrency pool. Respects
 * an AbortSignal — workers exit cleanly at the next item boundary.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function loop() {
    while (cursor < items.length) {
      if (signal.aborted) return;
      const i = cursor++;
      try {
        await worker(items[i], i);
      } catch {
        // worker is responsible for logging and counting its own errors
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => loop());
  await Promise.all(workers);
}

// ─── Job runner (singleton) ──────────────────────────────────────────────

let currentController: AbortController | null = null;

/**
 * Scale the requested DSS2 field-of-view to the object's size so small
 * planetary nebulae get tight crops while sprawling nebulae fit in frame.
 * Capped at 3° — beyond that DSS2 resolution gets blotchy and the thumbnail
 * loses useful detail anyway.
 *
 * IMPORTANT: the client (ObjectPreview + ObjectDetail) mirrors this formula
 * verbatim in `src/lib/catalogImage.ts` so the URLs it requests match the
 * filenames the prefetch writes to disk. Keep them in sync.
 */
export function fovForEntry(majorAxisArcmin: number | null): number {
  if (majorAxisArcmin == null || !Number.isFinite(majorAxisArcmin)) return 1.0;
  const raw = (majorAxisArcmin / 60) * 2.5; // 2.5× object size in degrees
  return Math.max(0.3, Math.min(3.0, raw));
}

function masterCacheKey(id: string): string {
  const normalized = id.replace(/\s+/g, '').toUpperCase();
  return `${normalized}_master`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** DSS2 master JPG path. One file per object, regardless of FOV or display size. */
export function imageCachePath(id: string): string {
  return path.join(DATA_DIR, 'sky-cache', `${masterCacheKey(id)}.jpg`);
}

/** How a resized image is fitted into the requested W×H frame.
 *  - `inside` (default): preserve master aspect, may letterbox.
 *  - `cover`: center-crop to exactly fill W×H. Used by tvOS full-screen so
 *    the 3:2 master fills a 16:9 TV without pillarbox bars. */
export type ResizeFit = 'inside' | 'cover';

/** Which cached catalog master a thumbnail was derived from. Used as a cache
 *  key dimension on resized files so the resize cache self-busts when the
 *  selected master changes. */
export type CatalogMasterSource = 'hubble' | 'wiki' | 'dss2';

/** Resized cache path: derived from a specific master, sized for the requested display.
 *  `cover` variants get a `_cover` suffix so they don't collide with the default
 *  `inside`-fit thumbnails.
 *
 *  The `source` segment ('hubble' / 'wiki' / 'dss2') prevents stale entries
 *  from sticking around when the master-selection priority changes — a thumbnail
 *  resized from DSS2 never gets served when Hubble is now the picked master,
 *  because the file name itself differs.
 *
 *  `source` is optional only for backwards compatibility with old call sites;
 *  any newly cached file should always carry it. */
export function resizedImagePath(
  id: string,
  width: number,
  height: number,
  fit: ResizeFit = 'inside',
  source?: CatalogMasterSource,
): string {
  const normalized = id.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9_.-]/g, '_');
  const suffix = fit === 'cover' ? '_cover' : '';
  const src = source ? `_${source}` : '';
  return path.join(DATA_DIR, 'sky-cache', 'resized', `${normalized}${src}_${width}x${height}${suffix}.jpg`);
}

function imageAlreadyCached(id: string): boolean {
  try {
    const stat = fs.statSync(imageCachePath(id));
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Canonical on-disk path for a cached Wikipedia thumbnail. Stored under a
 * normalized id (uppercase, no whitespace) so the /image route can find it
 * without touching the catalog database — same pattern as DSS2 files but
 * with a `wiki_` prefix so the two don't collide.
 */
export function wikiImagePath(id: string): string {
  const normalized = id.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, 'sky-cache', `wiki_${normalized}.jpg`);
}

/**
 * Canonical on-disk path for a cached NASA Hubble image (webp).
 * These are stored with a `hubble_` prefix and .webp extension so they
 * don't collide with Wikipedia thumbnails or DSS2 plates.
 * The /image route checks for this file first (Tier 0) — Hubble imagery
 * is significantly higher quality than DSS2 plates or Wikipedia thumbnails.
 */
export function hubbleImagePath(id: string): string {
  const normalized = id.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, 'sky-cache', `hubble_${normalized}.webp`);
}

/**
 * True when any cached catalog sky image exists on disk for this id —
 * Hubble webp (Tier 0), Wikipedia thumbnail (Tier 1), or DSS2 plate (Tier 2).
 * Used by the gallery fallback to decide whether to substitute an observation image.
 *
 * Caldwell C-numbers are resolved to their canonical NGC/IC id before any path
 * is checked, so this function works identically whether called with "C21" or
 * "NGC4449".
 */
export function hasCachedCatalogImage(id: string): boolean {
  const canonical = resolveCanonicalId(id);

  // Tier 0: Hubble webp
  try {
    const stat = fs.statSync(hubbleImagePath(canonical));
    if (stat.isFile() && stat.size > 0) return true;
  } catch { /* not found */ }

  // Tier 1: Wikipedia jpg
  try {
    const stat = fs.statSync(wikiImagePath(canonical));
    if (stat.isFile() && stat.size > 0) return true;
  } catch { /* not found */ }

  // Tier 2: DSS2 master — single canonical path per object.
  try {
    const stat = fs.statSync(imageCachePath(canonical));
    if (stat.isFile() && stat.size > 0) return true;
  } catch { /* not found */ }

  return false;
}

/** A cached catalog master image on disk: which source it came from, where
 *  the file lives, and the right Content-Type if it gets streamed verbatim.
 *  CatalogMasterSource is declared with ResizeFit above so resizedImagePath
 *  can take it as a cache-key segment. */
export interface CachedMaster {
  source: CatalogMasterSource;
  path: string;
  contentType: 'image/webp' | 'image/jpeg';
}

/**
 * Single source of truth for catalog master selection. Both `/api/catalog/:id/image`
 * and `/api/library/objects/:id/thumbnail` go through here so they always pick
 * the same file for a given id — preventing the two routes from drifting.
 *
 * Priority by quality: Hubble (high-res webp) > Wikipedia (curated thumb) >
 * DSS2 (universal fallback). Pass `pinnedSource` to bias toward a specific
 * master (the others remain as fallbacks so a wiped pinned source still
 * serves something rather than 404).
 *
 * Intrinsic master dimensions are intentionally NOT consulted — picking by
 * size would make the same id return different sources at different request
 * sizes, which is the bug this helper exists to prevent. Resize callers
 * should use Sharp's `withoutEnlargement: true` so a small master is served
 * at native size rather than upscaled.
 */
export function findCachedMaster(
  id: string,
  pinnedSource?: CatalogMasterSource | null,
): CachedMaster | null {
  id = resolveCanonicalId(id);
  const all: Record<CatalogMasterSource, CachedMaster> = {
    hubble: { source: 'hubble', path: hubbleImagePath(id), contentType: 'image/webp' },
    wiki:   { source: 'wiki',   path: wikiImagePath(id),   contentType: 'image/jpeg' },
    dss2:   { source: 'dss2',   path: imageCachePath(id),  contentType: 'image/jpeg' },
  };
  const defaultOrder: CatalogMasterSource[] = ['hubble', 'wiki', 'dss2'];
  const order = pinnedSource
    ? [pinnedSource, ...defaultOrder.filter(s => s !== pinnedSource)]
    : defaultOrder;
  for (const s of order) {
    const c = all[s];
    try {
      const stat = fs.statSync(c.path);
      if (stat.isFile() && stat.size > 0) return c;
    } catch { /* not present, try next */ }
  }
  return null;
}

/**
 * Download a Wikipedia thumbnail URL and write it to disk under the
 * object's canonical `wiki_<id>.jpg` path. Returns true on success.
 *
 * Fails silently — the caller doesn't count it as an error because many
 * Wikipedia pages don't have thumbnails at all, and missing a thumbnail
 * just means the /image route falls back to the DSS2 file.
 */
async function downloadWikipediaThumbnail(
  id: string,
  thumbnailUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(thumbnailUrl, {
      signal,
      headers: { 'User-Agent': 'Nebulis/1.0 (https://nebulis.app)' },
    });
    if (!res.ok) return false;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return false;

    const dest = wikiImagePath(id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
    await prewarmThumbnails(id, dest, 'wiki');
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && signal.aborted) {
      throw err;
    }
    return false;
  }
}

/**
 * Download the Wikipedia thumbnail for a single object if not already cached.
 *
 * Skips silently when the file already exists on disk or when a prior attempt
 * (ok or not_found) is recorded in catalogCache — so calling this on every
 * gallery-image request is safe and cheap once the object is settled.
 *
 * Returns true only when a new thumbnail was written to disk.
 */
export async function prefetchObjectWiki(id: string, signal?: AbortSignal): Promise<boolean> {
  const cacheKey = resolveCanonicalId(id);

  try {
    const stat = fs.statSync(wikiImagePath(cacheKey));
    if (stat.isFile() && stat.size > 0) return false;
  } catch { /* not present */ }

  // Build candidates BEFORE checking the cache. A prior not_found may have
  // been written when we only tried the raw ID (e.g. "SH2-274" which 404s on
  // Wikipedia). Now that we can resolve a common name ("Medusa Nebula"), we
  // should retry rather than treating the old not_found as permanent.
  const dsoEntry = getDsoById(id);
  const candidates: string[] = [];
  if (dsoEntry?.name && dsoEntry.name !== id) candidates.push(dsoEntry.name);
  if (!dsoEntry) {
    // Sharpless objects aren't in OpenNGC. Check the Sharpless catalog for a
    // common name; also try the spaced "Sh 2-N" form that Wikipedia accepts.
    const sh2 = getSharplessEntry(id);
    if (sh2?.commonName) candidates.push(sh2.commonName);
    if (sh2) {
      const num = id.replace(/^SH2-/i, '');
      if (num) candidates.push(`Sh 2-${num}`);
    }
  }
  if (!candidates.includes(id)) candidates.push(id);
  const ngcMatch = id.match(/^(NGC|IC)(\d+)$/);
  if (ngcMatch) {
    const spaced = `${ngcMatch[1]} ${ngcMatch[2]}`;
    if (!candidates.includes(spaced)) candidates.push(spaced);
  }
  if (dsoEntry?.messier != null) candidates.push(`Messier ${dsoEntry.messier}`);

  // Skip if already successfully cached.
  // For not_found: only skip when there are no candidates beyond the raw ID —
  // the prior miss may have used wrong search terms and we now have better ones.
  const existing = getCatalogCacheEntry(cacheKey);
  if (existing?.status === 'ok') return false;
  const hasBetterCandidates = candidates.some(c => c !== id && c !== cacheKey);
  if (existing?.status === 'not_found' && !hasBetterCandidates) return false;

  const ctrl = new AbortController();
  const sig = signal ?? ctrl.signal;

  for (const title of candidates) {
    try {
      const summary = await fetchWikipediaSummary(title, sig);
      if (!summary) continue;
      upsertCacheStmt.run(cacheKey, summary.extract, summary.wikiUrl, 'wikipedia', Date.now(), 'ok');
      if (summary.thumbnailUrl) {
        return downloadWikipediaThumbnail(cacheKey, summary.thumbnailUrl, sig);
      }
      return false;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return false;
    }
  }

  upsertCacheStmt.run(cacheKey, '', '', 'wikipedia', Date.now(), 'not_found');
  return false;
}

/**
 * Download the NASA Hubble image for a single Caldwell object if not already
 * cached. Non-Caldwell objects return false immediately.
 *
 * Returns true only when a new Hubble image was written to disk.
 */
export async function prefetchObjectHubble(id: string, signal?: AbortSignal): Promise<boolean> {
  const hubblePath = hubbleImagePath(id);
  try {
    const stat = fs.statSync(hubblePath);
    if (stat.isFile() && stat.size > 0) return false;
  } catch { /* not present */ }

  const cMatch = id.match(/^C(\d{1,3})$/i);
  const caldwellNum = cMatch ? parseInt(cMatch[1], 10) : ngcToCaldwell(id);
  if (caldwellNum === null) return false;

  try {
    const entry = await fetchCaldwellEntry(caldwellNum, signal);
    if (!entry) return false;

    const imgRes = await fetch(entry.imageUrl, {
      signal,
      headers: { 'User-Agent': 'Nebulis/1.0 (astronomy companion app)' },
    });
    if (!imgRes.ok) return false;

    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length === 0) return false;

    fs.mkdirSync(path.dirname(hubblePath), { recursive: true });
    fs.writeFileSync(hubblePath, buf);

    await prewarmThumbnails(entry.catalogId, hubblePath, 'hubble');
    const caldwellId = `C${caldwellNum}`;
    if (entry.catalogId !== caldwellId) {
      await prewarmThumbnails(caldwellId, hubblePath, 'hubble');
    }

    if (entry.description) {
      const now = Date.now();
      upsertCacheStmt.run(entry.catalogId, entry.description, entry.pageUrl, 'nasa_caldwell', now, 'ok');
      if (entry.catalogId !== caldwellId) {
        upsertCacheStmt.run(caldwellId, entry.description, entry.pageUrl, 'nasa_caldwell', now, 'ok');
      }
    }
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return false;
    return false;
  }
}

/**
 * Scope of objects to prefetch in phases 1 (DSS2) and 2 (Wikipedia).
 *
 *   - `curated` (default): Messier (110 objects) + the curated popular-DSO
 *     list (~100 well-known NGC/IC objects from `popularDsoCatalog.ts`) +
 *     every object the user has imported. Roughly 250–600 objects total.
 *     Anything else gets a cold-cache live fetch on first request, which
 *     writes the master to disk so subsequent requests are fast.
 *
 *   - `full`: every entry in OpenNGC (~14 000 objects). Heavy bandwidth
 *     and disk usage; reserve for users who want a fully offline catalog.
 *
 * Phase 3 (Caldwell) is always exactly the 109 Caldwell objects regardless
 * of scope — it's a small, well-defined set with NASA Hubble imagery.
 */
export type PrefetchScope = 'curated' | 'full';

export interface StartOptions {
  /** Wipe the Wikipedia cache before starting. Images are left alone. */
  force?: boolean;
  /** Run only a single phase instead of the full three-phase job. */
  phase?: 'images' | 'wikipedia' | 'caldwell';
  /** What subset of the catalog to fetch. Defaults to `curated`. */
  scope?: PrefetchScope;
  /** Run Phase 0 (catalog packs) only. No Wikipedia, NASA, or DSS2 requests. */
  packsOnly?: boolean;
}

/**
 * Kick off (or restart) the prefetch job. Returns immediately — the job
 * runs in the background. If a job is already running, this is a no-op
 * unless `force` is true, in which case the running job is cancelled first.
 */
export function startPrefetch(opts: StartOptions = {}): { started: boolean; reason?: string } {
  const status = getPrefetchStatus();
  if (status.running && currentController && !opts.force) {
    return { started: false, reason: 'already_running' };
  }

  if (currentController) {
    currentController.abort();
    currentController = null;
  }

  if (opts.force && !opts.phase) {
    // Full force-refresh wipes all Wikipedia cache rows; a phase-specific
    // re-download just re-fetches that phase's items (already-cached are skipped).
    clearCacheStmt.run();
  }

  const controller = new AbortController();
  currentController = controller;

  // Fire and forget — don't block the request handler
  void runJob(controller.signal, opts.phase, opts.scope ?? 'curated', opts.packsOnly ?? false).catch(err => {
    console.error('[catalogPrefetch] Job failed:', err);
    const s = getPrefetchStatus();
    saveStatus({
      ...s,
      running: false,
      phase: 'error',
      finishedAt: Date.now(),
      lastError: err instanceof Error ? err.message : String(err),
    });
    currentController = null;
  });

  return { started: true };
}

export function cancelPrefetch(): boolean {
  if (!currentController) return false;
  currentController.abort();
  currentController = null;
  const s = getPrefetchStatus();
  saveStatus({ ...s, running: false, phase: 'cancelled', finishedAt: Date.now() });
  return true;
}

/** Library object IDs the user has actually imported. Used to scope curated prefetch. */
function getLibraryObjectIds(): Set<string> {
  // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
  const stmt = db.prepare<[], { objectId: string }>(
    `SELECT objectId FROM libraryObjects WHERE deleted = 0`,
  );
  const rows = stmt.all();
  const ids = new Set<string>();
  for (const r of rows) ids.add(r.objectId);
  return ids;
}

async function runJob(
  signal: AbortSignal,
  singlePhase?: 'images' | 'wikipedia' | 'caldwell',
  scope: PrefetchScope = 'curated',
  packsOnly = false,
): Promise<void> {
  const allEntries = getCatalog();

  // Scope filter for phases 1 & 2. Caldwell phase always runs full.
  let entries = allEntries;
  if (scope === 'curated') {
    const libraryIds = getLibraryObjectIds();
    entries = allEntries.filter(e =>
      e.messier !== null ||                  // Messier 1–110
      POPULAR_DSO_IDS.has(e.id) ||           // ~100 popular non-Messier non-Caldwell DSOs
      libraryIds.has(e.id),                  // user's imported objects
    );
  }

  const catalogTotal = entries.length;
  const CALDWELL_TOTAL = 109;

  console.log(`[prefetch] starting${singlePhase ? ` (phase: ${singlePhase})` : ''} (scope: ${scope}): ${catalogTotal} catalog entries`);

  const initialStatus = getPrefetchStatus();
  const startTotal = singlePhase === 'caldwell' ? CALDWELL_TOTAL : catalogTotal;
  saveStatus({
    ...initialStatus,
    running: true,
    phase: singlePhase ?? 'pack',
    processed: 0,
    total: startTotal,
    errors: 0,
    startedAt: Date.now(),
    finishedAt: null,
    lastError: '',
  });

  // ── Phase 0: catalog asset packs ──────────────────────────────────────────
  // Attempt to download pre-built signed packs. On success the live phases
  // below become gap-fillers (they already skip cached objects). On failure
  // the pack error is logged and we fall through to the full live scrape.
  if (!singlePhase) {
    const tiersForScope: CatalogTier[] = scope === 'curated'
      ? ['messier', 'caldwell', 'popular', 'sharpless']
      : ['messier', 'caldwell', 'popular', 'extended', 'sharpless'];

    saveStatus({ ...getPrefetchStatus(), phase: 'pack', processed: 0, total: tiersForScope.length, errors: 0 });

    let packInstalled = 0;
    let packErrors = 0;
    for (const tier of tiersForScope) {
      if (signal.aborted) break;
      try {
        const [result] = await installCatalogPacks([tier], signal, prewarmThumbnails);
        if (result && !result.skipped) packInstalled++;
        else if (result?.skipped && result.reason && result.reason !== 'already_installed') packErrors++;
      } catch (err) {
        console.warn('[prefetch] phase 0 pack install threw unexpectedly:', err instanceof Error ? err.message : err);
        packErrors++;
      }
      persistProgress('pack', packInstalled + packErrors, tiersForScope.length, packErrors);
    }
    console.log(`[prefetch] phase 0 done: ${packInstalled}/${tiersForScope.length} tiers installed`);

    if (signal.aborted) {
      saveStatus({ ...getPrefetchStatus(), running: false, phase: 'cancelled', finishedAt: Date.now() });
      return;
    }

    saveStatus({ ...getPrefetchStatus(), packCompletedAt: Date.now() });

    if (packsOnly) {
      const finalStatus = getPrefetchStatus();
      saveStatus({ ...finalStatus, running: false, phase: 'done', finishedAt: Date.now() });
      currentController = null;
      return;
    }
  }

  // ── Phase 1: DSS2 images ──
  if (!singlePhase || singlePhase === 'images') {
    let imageProcessed = 0;
    let imageErrors = 0;

    await runPool(entries, IMAGE_CONCURRENCY, signal, async entry => {
      if (signal.aborted) return;

      const canonicalId = resolveCanonicalId(entry.id);
      const masterPath = imageCachePath(canonicalId);
      if (imageAlreadyCached(canonicalId)) {
        // Master already on disk — still pre-warm thumbnails, idempotent.
        await prewarmThumbnails(canonicalId, masterPath, 'dss2');
        imageProcessed++;
        if (imageProcessed % 25 === 0) persistProgress('images', imageProcessed, catalogTotal, imageErrors);
        return;
      }

      try {
        const fov = fovForEntry(entry.majorAxisArcmin ?? null);
        const result = await prefetchSkyImage(canonicalId, { fov });
        if (!result) {
          imageErrors++;
        } else {
          await prewarmThumbnails(canonicalId, result, 'dss2');
        }
      } catch {
        imageErrors++;
      }
      imageProcessed++;
      if (imageProcessed % 10 === 0) persistProgress('images', imageProcessed, catalogTotal, imageErrors);
    });

    if (signal.aborted) {
      saveStatus({ ...getPrefetchStatus(), running: false, phase: 'cancelled', finishedAt: Date.now() });
      return;
    }

    console.log(`[prefetch] phase 1 done (images: ${imageProcessed} processed, ${imageErrors} errors)`);
    // Record per-phase completion timestamp, preserving all other timestamps
    saveStatus({ ...getPrefetchStatus(), imagesCompletedAt: Date.now() });
  }

  // ── Phase 2: Wikipedia ──
  if (!singlePhase || singlePhase === 'wikipedia') {
    saveStatus({ ...getPrefetchStatus(), phase: 'wikipedia', processed: 0, total: catalogTotal, errors: 0 });
    let wikiProcessed = 0;
    const wikiErrors = 0;

    await runPool(entries, WIKI_CONCURRENCY, signal, async entry => {
      if (signal.aborted) return;

      // Skip if already in cache — either a successful fetch or a previous 404.
      if (getCacheStmt.get(entry.id)) {
        wikiProcessed++;
        if (wikiProcessed % 50 === 0) persistProgress('wikipedia', wikiProcessed, catalogTotal, wikiErrors);
        return;
      }

      // Try the most likely page title first (common name), then fall back
      // to the scientific id. Wikipedia's REST API does NOT redirect
      // "NGC4274" → "NGC 4274" (returns an Internal error instead), so we
      // also add the spaced form "NGC 4274" / "IC 434" explicitly.
      const candidates: string[] = [];
      if (entry.name && entry.name !== entry.id) candidates.push(entry.name);
      if (entry.id && !candidates.includes(entry.id)) candidates.push(entry.id);
      const ngcMatch = entry.id?.match(/^(NGC|IC)(\d+)$/);
      if (ngcMatch) {
        const spaced = `${ngcMatch[1]} ${ngcMatch[2]}`;
        if (!candidates.includes(spaced)) candidates.push(spaced);
      }
      if (entry.messier != null) candidates.push(`Messier ${entry.messier}`);

      let summary = null;
      for (const title of candidates) {
        try {
          summary = await fetchWikipediaSummary(title, signal);
          if (summary) break;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return;
        }
      }

      const now = Date.now();
      if (summary) {
        upsertCacheStmt.run(entry.id, summary.extract, summary.wikiUrl, 'wikipedia', now, 'ok');
        if (summary.thumbnailUrl) {
          try {
            await downloadWikipediaThumbnail(entry.id, summary.thumbnailUrl, signal);
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
          }
        }
      } else {
        upsertCacheStmt.run(entry.id, '', '', 'wikipedia', now, 'not_found');
      }

      wikiProcessed++;
      if (wikiProcessed % 20 === 0) persistProgress('wikipedia', wikiProcessed, catalogTotal, wikiErrors);
    });

    if (signal.aborted) {
      saveStatus({ ...getPrefetchStatus(), running: false, phase: 'cancelled', finishedAt: Date.now() });
      return;
    }

    console.log(`[prefetch] phase 2 done (wiki: ${wikiProcessed} processed, ${wikiErrors} errors)`);
    saveStatus({ ...getPrefetchStatus(), wikiCompletedAt: Date.now() });
  }

  // ── Phase 3: NASA Hubble Caldwell ────────────────────────────────
  // Fetches descriptions and Hubble imagery for Caldwell C1–C109.
  // 88 of 109 objects have Hubble imagery; the rest return null and are skipped.
  // NASA content is public domain. Images are saved as `hubble_<id>.webp` and
  // served as Tier 0 in the /image route — higher priority than Wikipedia or DSS2.
  if (!singlePhase || singlePhase === 'caldwell') {
    console.log('[prefetch] phase 3: NASA Caldwell catalog (C1–C109)');
    const CALDWELL_CONCURRENCY = 3; // NASA CDN is polite-rate-limited
    let caldwellProcessed = 0;
    let caldwellErrors = 0;

    saveStatus({ ...getPrefetchStatus(), phase: 'caldwell', processed: 0, total: CALDWELL_TOTAL, errors: 0 });

    const caldwellNums = Array.from({ length: CALDWELL_TOTAL }, (_, i) => i + 1);

    // Prepare a per-entry cache-hit check. We can only know the catalogId
    // (e.g. "NGC188") after fetching the detail page, so skipping is done
    // post-fetch: if both the image file and a nasa_caldwell DB row exist we
    // avoid the image download and upsert but still count the HTTP request.
    // Typed prepared statement — SQL trust boundary enforced by catalogCache schema.
    const isCaldwellCached = db.prepare<[string], { objectId: string }>(
      "SELECT objectId FROM catalogCache WHERE objectId = ? AND source = 'nasa_caldwell'",
    );

    await runPool(caldwellNums, CALDWELL_CONCURRENCY, signal, async (num) => {
      if (signal.aborted) return;

      try {
        // Skip without any network when the object is already fully covered —
        // Hubble image on disk plus a good description row, which is exactly
        // what the caldwell pack installs (the pack ships Wikipedia text, so
        // the check accepts any 'ok' row rather than requiring source
        // 'nasa_caldwell'). Most C-numbers resolve to their NGC/IC id locally;
        // only ones with no NGC designation need the NASA detail page to
        // learn their catalogId.
        const localId = caldwellToNgcId(`C${num}`);
        if (localId) {
          let localImageOk = false;
          try {
            const stat = fs.statSync(hubbleImagePath(localId));
            if (stat.size > 0) localImageOk = true;
          } catch { /* not cached */ }
          if (localImageOk && getCatalogCacheEntry(localId)?.status === 'ok') {
            caldwellProcessed++;
            if (caldwellProcessed % 10 === 0)
              persistProgress('caldwell', caldwellProcessed, CALDWELL_TOTAL, caldwellErrors);
            return;
          }
        }

        const entry = await fetchCaldwellEntry(num, signal);
        if (!entry) {
          caldwellProcessed++;
          return;
        }

        // Images are stored only under the canonical NGC/IC id (e.g. "NGC4449").
        // The image route resolves C-numbers to their NGC alias before building
        // any file path, so one file per object is sufficient.
        const caldwellId = `C${num}`;
        const hubblePath = hubbleImagePath(entry.catalogId);

        let imageOk = false;
        try {
          const stat = fs.statSync(hubblePath);
          if (stat.size > 0) imageOk = true;
        } catch { /* not cached */ }

        const cacheRow = isCaldwellCached.get(entry.catalogId);

        if (imageOk && cacheRow) {
          caldwellProcessed++;
          if (caldwellProcessed % 10 === 0)
            persistProgress('caldwell', caldwellProcessed, CALDWELL_TOTAL, caldwellErrors);
          return;
        }

        if (!imageOk) {
          try {
            const imgRes = await fetch(entry.imageUrl, {
              signal,
              headers: { 'User-Agent': 'Nebulis/1.0 (astronomy companion app)' },
            });
            if (imgRes.ok) {
              const buf = Buffer.from(await imgRes.arrayBuffer());
              if (buf.length > 0) {
                fs.mkdirSync(path.dirname(hubblePath), { recursive: true });
                fs.writeFileSync(hubblePath, buf);
                imageOk = true;
              }
            }
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
            caldwellErrors++;
          }
        }

        // Pre-warm thumbnails under both ids so requests for either alias hit
        // the resized cache instantly. Idempotent if already warmed.
        if (imageOk) {
          await prewarmThumbnails(entry.catalogId, hubblePath, 'hubble');
          if (entry.catalogId !== caldwellId) {
            await prewarmThumbnails(caldwellId, hubblePath, 'hubble');
          }
        }

        if (imageOk && entry.description) {
          const now = Date.now();
          upsertCacheStmt.run(entry.catalogId, entry.description, entry.pageUrl, 'nasa_caldwell', now, 'ok');
          // Also insert under the Caldwell C-number so /:id/info lookups using
          // the C-number (the user's library objectId) find the description.
          if (entry.catalogId !== caldwellId) {
            upsertCacheStmt.run(caldwellId, entry.description, entry.pageUrl, 'nasa_caldwell', now, 'ok');
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        caldwellErrors++;
      }

      caldwellProcessed++;
      if (caldwellProcessed % 5 === 0)
        persistProgress('caldwell', caldwellProcessed, CALDWELL_TOTAL, caldwellErrors);
    });

    if (signal.aborted) {
      saveStatus({ ...getPrefetchStatus(), running: false, phase: 'cancelled', finishedAt: Date.now() });
      return;
    }

    console.log(`[prefetch] phase 3 done (caldwell: ${caldwellProcessed} processed, ${caldwellErrors} errors)`);
    saveStatus({ ...getPrefetchStatus(), caldwellCompletedAt: Date.now() });
  }

  // ── Phase 4: Solar system ─────────────────────────────────────────────────
  // NASA images + Wikipedia for the Sun, planets, notable moons, and dwarf
  // planets. Runs on every full prefetch (not triggered by singlePhase sweeps,
  // which target DSOs only). Images land in the same DSS2 master slot so the
  // existing /catalog/:id/image route and thumbnail prewarm code work unchanged.
  if (!singlePhase) {
    console.log(`[prefetch] phase 4: solar system (${SOLAR_SYSTEM_CATALOG.length} objects)`);
    let solarProcessed = 0;
    let solarErrors = 0;

    for (const entry of SOLAR_SYSTEM_CATALOG) {
      if (signal.aborted) break;

      // NASA image
      if (!imageAlreadyCached(entry.id)) {
        try {
          const result = await prefetchSkyImage(entry.id);
          if (result) {
            await prewarmThumbnails(entry.id, result, 'dss2');
          } else {
            solarErrors++;
          }
        } catch {
          solarErrors++;
        }
      }

      // Wikipedia extract + thumbnail
      if (!getCacheStmt.get(entry.id)) {
        try {
          await prefetchObjectWiki(entry.id, signal);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') break;
        }
      }

      solarProcessed++;
    }

    if (!signal.aborted) {
      console.log(`[prefetch] phase 4 done (solar: ${solarProcessed} processed, ${solarErrors} image errors)`);
    }
  }

  // ── Done ──
  const finalStatus = getPrefetchStatus();
  saveStatus({
    ...finalStatus,
    running: false,
    phase: 'done',
    finishedAt: Date.now(),
  });
  currentController = null;
}

function persistProgress(phase: PrefetchPhase, processed: number, total: number, errors: number): void {
  const s = getPrefetchStatus();
  saveStatus({ ...s, phase, processed, total, errors });
}
