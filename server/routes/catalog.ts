import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import sharp from '../lib/sharp-optional.js';
import { getCatalogEntry, searchCatalog, getAllCatalogEntries, getAlsoKnownAs } from '../data/catalog.js';
import db from '../lib/db.js';
import { parsePagination, paginate } from '../middleware/pagination.js';
import { raToDegs, decToDegs } from '../lib/astroCalc.js';
import { queryString } from '../lib/queryHelpers.js';
import { normalizeCatalogId } from '../lib/telescopeFiles.js';
import {
  startPrefetch,
  cancelPrefetch,
  getPrefetchStatus,
  getCatalogCacheEntry,
  getCatalogCacheStats,
  wipeCatalogCache,
  fovForEntry,
  wikiImagePath,
  hubbleImagePath,
  imageCachePath,
  resizedImagePath,
  findCachedMaster,
  prefetchObjectWiki,
  prefetchObjectHubble,
  MASTER_WIDTH,
  MASTER_HEIGHT,
  type ResizeFit,
} from '../lib/catalogPrefetch.js';
import { getAllPackStates } from '../lib/catalogPack/state.js';
import { getById as getDsoById } from '../lib/dsoCatalog.js';
import { prefetchSkyImage } from '../lib/skyImage.js';
import { enrichObjectData } from '../lib/localLibrary.js';
import { DATA_DIR } from '../lib/paths.js';
import { caldwellToNgcId, CALDWELL_FALLBACK_COORDS } from '../lib/caldwellCatalog.js';
import { getOverride, saveOverride, deleteOverride, getOverrideRecord } from '../lib/catalogOverrides.js';
import { getCuratedDescription } from '../lib/curatedDescriptions.js';
import { lookupTimeZoneForCoordinates } from '../lib/observerTimezone.js';

/** Max requested thumbnail size — caps Sharp work and disk usage. */
const MAX_REQUEST_DIMENSION = 1920;

const router = Router();

/** Format a distance in light-years to a human-readable string. */
function formatDistance(ly: number): string {
  if (ly >= 1_000_000) {
    const mly = ly / 1_000_000;
    return `${mly % 1 === 0 ? mly.toFixed(0) : mly.toFixed(2)} million light-years`;
  }
  return `${ly.toLocaleString('en-US')} light-years`;
}

// ─── Sky image cache (disk-backed) ─────────────────────────────────
// Must use DATA_DIR (not process.cwd()) so the on-demand fetch writes to the
// same directory that the catalog prefetch job reads from. On Windows the
// installed app's cwd is the install directory, not the data directory.
const SKY_CACHE_DIR = path.join(DATA_DIR, 'sky-cache');
try { fs.mkdirSync(SKY_CACHE_DIR, { recursive: true }); } catch {}

// List all catalog entries with optional search and pagination
router.get('/', (req: Request, res: Response) => {
  let entries = getAllCatalogEntries();

  // Optional type filter
  const typeFilter = queryString(req.query.type);
  if (typeFilter) {
    entries = entries.filter(e => e.type.toLowerCase().includes(typeFilter.toLowerCase()));
  }

  // Optional constellation filter
  const constellation = queryString(req.query.constellation);
  if (constellation) {
    entries = entries.filter(e => e.constellation.toLowerCase() === constellation.toLowerCase());
  }

  const pagination = parsePagination(req, 100);
  const result = paginate(entries, pagination);

  res.apiSuccess(result.items, { pagination: result.pagination });
});

// Search catalog
router.get('/search', (req: Request, res: Response) => {
  const q = String(req.query.q || '');
  if (!q) {
    res.apiError(400, 'MISSING_QUERY', 'Query parameter "q" is required');
    return;
  }
  const results = searchCatalog(q);
  const pagination = parsePagination(req);
  const result = paginate(results, pagination);

  res.apiSuccess(result.items, { pagination: result.pagination, query: q });
});

// In-flight resize lock — prevents duplicate Sharp work and clobbering writes
// when two requests for the same novel (id, w, h) arrive simultaneously. The
// second caller awaits the first's promise instead of starting its own resize.
// Keys are removed on completion (or failure) so transient errors retry.
const inflightResizes = new Map<string, Promise<void>>();

// Resized-cache size cap. Pre-warm fills ~3 sizes × N objects = 3N files for
// curated prefetch, plus whatever lazy resizes accumulate over time. The cap
// protects against unbounded growth from clients requesting unusual sizes
// (debug tools, integration tests, third-party clients). Pruning keeps the
// most-recently-accessed files. 5000 files × ~50 KB ≈ 250 MB max.
const RESIZED_CACHE_MAX_FILES = 5000;
let pruneInProgress = false;
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // throttle to once per hour

async function maybePruneResizedCache(): Promise<void> {
  const now = Date.now();
  if (pruneInProgress) return;
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  pruneInProgress = true;
  lastPruneAt = now;
  try {
    const dir = path.join(DATA_DIR, 'sky-cache', 'resized');
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    if (names.length <= RESIZED_CACHE_MAX_FILES) return;

    // Read atime (last access) so we evict cold files first. Files with no
    // atime support fall back to mtime (creation time).
    const stats = names
      .map(name => {
        try {
          const s = fs.statSync(path.join(dir, name));
          return { name, atime: s.atimeMs || s.mtimeMs };
        } catch { return null; }
      })
      .filter((s): s is { name: string; atime: number } => s !== null)
      .sort((a, b) => a.atime - b.atime); // oldest first

    const toDelete = stats.length - RESIZED_CACHE_MAX_FILES;
    let deleted = 0;
    for (let i = 0; i < toDelete; i++) {
      try { fs.unlinkSync(path.join(dir, stats[i].name)); deleted++; } catch { /* skip */ }
    }
    if (deleted > 0) {
      console.log(`[catalog] pruned ${deleted} cold resized thumbnails (cap: ${RESIZED_CACHE_MAX_FILES})`);
    }
  } finally {
    pruneInProgress = false;
  }
}

/**
 * Resize `masterPath` to `dest` at `w×h` with the canonical Sharp options.
 * Concurrent calls for the same `dest` share one resize operation.
 */
async function runResize(
  id: string,
  w: number,
  h: number,
  masterPath: string,
  dest: string,
  fit: ResizeFit = 'inside',
): Promise<void> {
  const key = `${id}_${w}x${h}_${fit}`;
  const existing = inflightResizes.get(key);
  if (existing) return existing;

  const work = (async () => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // `cover` fills the requested W×H exactly by center-cropping the master.
    // Used by tvOS full-screen so a 3:2 master fills a 16:9 TV without bars.
    // `withoutEnlargement` is omitted in cover mode — letterboxing a small
    // master into a TV frame defeats the point of asking for a fill.
    await sharp(masterPath)
      .resize(w, h, fit === 'cover'
        ? { fit: 'cover', position: 'centre' }
        : { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toFile(dest);
  })();

  inflightResizes.set(key, work);
  try {
    await work;
  } finally {
    inflightResizes.delete(key);
  }

  // Fire and forget — pruning is throttled internally and doesn't affect this response.
  void maybePruneResizedCache();
}

/**
 * Master priority (best → worst), checked in order:
 *   - `hubble_<ID>.webp` — NASA Hubble (Caldwell objects, full resolution)
 *   - `wiki_<ID>.jpg`    — Wikipedia thumbnail (curated astrophotography)
 *   - `<ID>_master.jpg`  — DSS2 plate at MASTER_WIDTH × MASTER_HEIGHT
 *
 * Request shape:
 *   - No `?w=&h=`  → serve the master directly (full quality, for full-screen views).
 *   - With `?w=H&h=H` → return a Sharp-resized JPG cached at `resized/<ID>_<w>x<h>.jpg`
 *                       so subsequent same-size requests are instant disk reads.
 *
 * Cold cache (no master available) triggers a live DSS2 fetch at master size,
 * then resizes from that for the requested thumbnail. Subsequent calls for
 * any size hit the disk-cached master and resize instantly.
 *
 * Caldwell C-numbers (e.g. "C21") are resolved to their canonical NGC/IC id
 * (e.g. "NGC4449") at the top of the handler. All file paths are built from
 * the canonical id, so there is exactly one master per object.
 */
router.get('/:id/image', async (req: Request, res: Response) => {
  const rawId = normalizeCatalogId(String(req.params.id));
  // Resolve Caldwell C-numbers once — everything below uses the canonical id.
  const id = caldwellToNgcId(rawId) ?? rawId;

  // Parse optional resize params. Missing or zero = serve master at native size.
  const reqW = Number(req.query.w);
  const reqH = Number(req.query.h);
  const wantsResize = reqW > 0 && reqH > 0;
  const width = Math.min(reqW || MASTER_WIDTH, MAX_REQUEST_DIMENSION);
  const height = Math.min(reqH || MASTER_HEIGHT, MAX_REQUEST_DIMENSION);
  // `?fill=cover` center-crops the master to exactly W×H — used by tvOS
  // full-screen so a 3:2 master fills a 16:9 TV without pillarbox bars.
  // Anything else (including missing) falls back to letterboxing aspect-fit.
  const fit: ResizeFit = req.query.fill === 'cover' ? 'cover' : 'inside';
  // `?source=hubble|wiki|dss2` pins to a specific cached master, bypassing
  // the default Hubble > Wikipedia > DSS2 priority. Used by the gallery
  // modal so users can choose which variant to render. Unknown values fall
  // through to the default priority.
  const requestedSource = String(req.query.source ?? '');
  const pinnedSource: 'hubble' | 'wiki' | 'dss2' | null =
    requestedSource === 'hubble' || requestedSource === 'wiki' || requestedSource === 'dss2'
      ? requestedSource
      : null;

  // ── Find best available master ──
  // Shared with /api/library/objects/:id/thumbnail via findCachedMaster, so
  // the gallery card and the object detail header always pick the same file.
  // Resize logic below uses Sharp's withoutEnlargement: true so a small
  // master is served at native size rather than upscaled-and-softened.
  //
  // Note: master selection runs BEFORE the resize-cache check so the cache
  // file name can include the master source. Otherwise an old DSS2-derived
  // thumbnail would keep being served forever after the priority changed
  // to prefer Hubble — `Cache-Control: immutable` stops the browser from
  // re-fetching, and the file name was previously unkeyed by source.
  let master = findCachedMaster(id, pinnedSource);

  // ── Cold cache: live fetch DSS2 master ──
  if (!master) {
    try {
      const dsoEntry = getDsoById(id);
      let raDegs: number | undefined = dsoEntry?.ra != null ? dsoEntry.ra * 15 : undefined;
      let decDegs: number | undefined = dsoEntry?.dec;

      if (raDegs == null || decDegs == null) {
        // Try original (pre-canonicalization) id in library DB for objects that
        // were imported under their C-number before canonicalization was added.
        // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
        const libCoordsStmt = db.prepare<[string, string], { ra: string | null; dec: string | null }>(
          `SELECT ra, dec FROM libraryObjects WHERE (objectId = ? OR objectId = ?) AND deleted = 0 LIMIT 1`,
        );
        const libCoords = libCoordsStmt.get(id, rawId);
        if (libCoords?.ra) raDegs = raToDegs(libCoords.ra);
        if (libCoords?.dec) decDegs = decToDegs(libCoords.dec);
      }

      // Last resort: built-in coords for Caldwell objects with no NGC/IC designation
      // (e.g. C99 Coalsack) that are absent from the DSO catalog and library.
      const caldwellFallback = (() => {
        const m = rawId.match(/^C(\d{1,3})$/i);
        return m ? (CALDWELL_FALLBACK_COORDS[parseInt(m[1], 10)] ?? null) : null;
      })();
      if ((raDegs == null || decDegs == null) && caldwellFallback) {
        raDegs = caldwellFallback.ra * 15;
        decDegs = caldwellFallback.dec;
      }

      const fov = req.query.fov != null && req.query.fov !== ''
        ? Number(req.query.fov) || 1.0
        : fovForEntry(dsoEntry?.majorAxisArcmin ?? caldwellFallback?.majorAxisArcmin ?? null);

      // Interactive request: use a short fetch deadline. The default 60s suits
      // the background prefetch job, but here the browser is holding one of its
      // ~6 per-origin connections open for the answer — on a dead/offline
      // network a long hang per uncached thumbnail starves real API calls.
      const fetched = await prefetchSkyImage(id, {
        fov,
        ra: raDegs,
        dec: decDegs,
        timeoutMs: 15_000,
      });
      if (fetched) master = { source: 'dss2', path: fetched, contentType: 'image/jpeg' };
    } catch { /* external service unavailable */ }
  }

  if (!master) {
    res.apiError(404, 'NOT_CACHED', `No image available for "${rawId}".`);
    return;
  }

  // ── No resize requested: stream the master directly ──
  if (!wantsResize) {
    const masterStat = fs.statSync(master.path);
    const lastModified = new Date(masterStat.mtimeMs).toUTCString();
    const ifModSince = req.headers['if-modified-since'];
    if (ifModSince && masterStat.mtimeMs <= new Date(ifModSince).getTime() + 1000) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', master.contentType);
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const s = fs.createReadStream(master.path);
    s.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    s.pipe(res);
    return;
  }

  // ── Resized cache hit ──
  // Keyed on (id, source, w, h, fit) so the file name changes when the
  // selected master does — preventing stale cross-source thumbnails.
  // Cache-Control is 24h (not immutable) because the best available master
  // can change when catalog packs download better imagery — immutable would
  // lock browsers onto the old image for an entire year.
  const resizedPath = resizedImagePath(id, width, height, fit, master.source);
  try {
    const stat = fs.statSync(resizedPath);
    if (stat.isFile() && stat.size > 0) {
      const lastModified = new Date(stat.mtimeMs).toUTCString();
      const ifModSince = req.headers['if-modified-since'];
      if (ifModSince && stat.mtimeMs <= new Date(ifModSince).getTime() + 1000) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Last-Modified', lastModified);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const s = fs.createReadStream(resizedPath);
      s.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      s.pipe(res);
      return;
    }
  } catch { /* not cached, fall through to resize */ }

  // ── Resize from master via Sharp, cache to disk, stream result ──
  // fit: 'inside' preserves the master's aspect ratio without cropping —
  // critical for astronomical imagery where every part of the frame may
  // contain real signal. The output may be smaller than W×H in one
  // dimension; clients should render with .scaledToFit / object-contain.
  // withoutEnlargement: true keeps small masters at native size rather
  // than upscaling and softening them.
  try {
    await runResize(id, width, height, master.path, resizedPath, fit);

    const resizedStat = fs.statSync(resizedPath);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Last-Modified', new Date(resizedStat.mtimeMs).toUTCString());
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const s = fs.createReadStream(resizedPath);
    s.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    s.pipe(res);
  } catch (err) {
    console.error(`[catalog] resize failed for ${id} ${width}x${height}:`, err);
    if (!res.headersSent) res.apiError(500, 'RESIZE_FAILED', 'Failed to resize image');
  }
});

// ─── Cached master inventory ────────────────────────────────────────────
/**
 * Lists which masters are currently cached on disk for one object. Used by
 * the gallery image picker so the user can browse cached variants (Hubble
 * vs Wikipedia vs DSS2) and pin a specific source instead of letting the
 * server auto-pick by priority.
 *
 * Each entry has a thumbnail URL the client can render directly:
 *   /api/catalog/<id>/image?source=<source>&w=…&h=…
 */
router.get('/:id/sources', async (req: Request, res: Response) => {
  const rawId = normalizeCatalogId(String(req.params.id));
  const id = caldwellToNgcId(rawId) ?? rawId;

  type SourceEntry = {
    source: 'hubble' | 'wiki' | 'dss2';
    label: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
  };
  const candidates: { source: SourceEntry['source']; label: string; path: string }[] = [
    { source: 'hubble', label: 'NASA Hubble',     path: hubbleImagePath(id) },
    { source: 'wiki',   label: 'Wikipedia',       path: wikiImagePath(id) },
    { source: 'dss2',   label: 'CDS DSS2 Survey', path: imageCachePath(id) },
  ];

  const sources: SourceEntry[] = [];
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c.path);
      if (!stat.isFile() || stat.size === 0) continue;
      // Cheap header read — no full decode.
      const meta = await sharp(c.path).metadata();
      sources.push({
        source: c.source,
        label: c.label,
        sizeBytes: stat.size,
        width: meta.width ?? null,
        height: meta.height ?? null,
      });
    } catch { /* not present */ }
  }

  res.apiSuccess({ id, sources });
});

// ─── Per-object force re-fetch ──────────────────────────────────────────
/**
 * Force-fetch the DSS2 master for one catalog object. Used by the gallery
 * image picker's "re-fetch" button so users can recover from a single
 * object that was missed by the bulk prefetch (alasky timeout, transient
 * 5xx, etc.) without having to wipe and rerun the whole catalog.
 *
 * Always blocks until the fetch completes (success or failure) so the
 * client can show a loading state and immediately invalidate its
 * `catalog-sources` query when the response arrives.
 */
router.post('/:id/prefetch', requireAdmin, async (req: Request, res: Response) => {
  const rawId = normalizeCatalogId(String(req.params.id));
  const id = caldwellToNgcId(rawId) ?? rawId;
  const dsoEntry = getDsoById(id);
  const fov = fovForEntry(dsoEntry?.majorAxisArcmin ?? null);
  const ra = dsoEntry?.ra != null ? dsoEntry.ra * 15 : undefined;
  const dec = dsoEntry?.dec ?? undefined;

  try {
    const [dss2Result, wikiResult, hubbleResult] = await Promise.allSettled([
      prefetchSkyImage(id, { fov, ra, dec, force: true }),
      prefetchObjectWiki(id),
      prefetchObjectHubble(id),
    ]);
    res.apiSuccess({
      id,
      dss2: dss2Result.status === 'fulfilled' ? !!dss2Result.value : false,
      wiki: wikiResult.status === 'fulfilled' ? wikiResult.value : false,
      hubble: hubbleResult.status === 'fulfilled' ? hubbleResult.value : false,
    });
  } catch (err) {
    res.apiError(500, 'PREFETCH_FAILED', err instanceof Error ? err.message : 'Prefetch failed');
  }
});

// ─── Object info (served from DB — enriched during import) ──────────────
router.get('/:id/info', (_req: Request, res: Response) => {
  const id = String(_req.params.id);

  interface LibObjInfoRow {
    objectName: string | null; objectType: string | null; constellation: string | null;
    magnitude: number | null; description: string | null; ra: string | null; dec: string | null;
    distanceLy: number | null; wikiUrl: string | null; sizeArcmin: string | null;
  }
  // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
  const libObjInfoStmt = db.prepare<[string], LibObjInfoRow>(
    `SELECT objectName, objectType, constellation, magnitude, description, ra, dec,
     distanceLy, wikiUrl, sizeArcmin FROM libraryObjects WHERE objectId = ? AND deleted = 0`,
  );
  // Try library DB first (pre-enriched during import)
  const obj = libObjInfoStmt.get(id);

  // Fall back to static catalog for non-imported objects
  const entry = getCatalogEntry(id);

  // Reject completely unknown objects — if the ID is neither in the user's
  // library nor in the static catalog, there is nothing real to return.
  if (!obj && !entry) {
    res.apiError(404, 'NOT_FOUND', `Catalog entry "${id}" not found`);
    return;
  }

  // Pre-fetched Wikipedia cache — populated by the catalog prefetch job
  const cached = getCatalogCacheEntry(id);
  const curated = getCuratedDescription(id);

  // Prefer the Wikipedia extract when available — it's richer than the
  // short one-liners saved during library import. Fall back to curated
  // descriptions for popular objects, then the library/static description.
  const wikiExtract = cached?.status === 'ok' ? cached.extract : '';
  const description = curated?.extract || wikiExtract || obj?.description || entry?.description || '';

  const wikiUrl =
    curated?.wikiUrl
    || (cached?.status === 'ok' ? cached.wikiUrl : '')
    || obj?.wikiUrl
    || null;

  // User overrides win over every other source — they're the user's intent.
  // Crucially this beats the Wikipedia extract for description, which the
  // base merge inside getCatalogEntry can't do (the extract is only
  // consulted in this route).
  const override = getOverride(id);

  const info = {
    name: override?.name ?? obj?.objectName ?? entry?.name ?? id,
    type: override?.type ?? obj?.objectType ?? entry?.type ?? 'Unknown',
    constellation: override?.constellation ?? obj?.constellation ?? entry?.constellation ?? 'Unknown',
    magnitude: override?.magnitude ?? obj?.magnitude ?? entry?.magnitude ?? null,
    description: override?.description ?? description,
    ra: override?.ra ?? obj?.ra ?? entry?.ra ?? null,
    dec: override?.dec ?? obj?.dec ?? entry?.dec ?? null,
    distance: (override?.distanceLy ?? entry?.distanceLy ?? obj?.distanceLy) != null
      ? formatDistance((override?.distanceLy ?? entry?.distanceLy ?? obj?.distanceLy)!)
      : null,
    distanceLy: override?.distanceLy ?? entry?.distanceLy ?? obj?.distanceLy ?? null,
    size: obj?.sizeArcmin || (entry?.majorAxisArcmin != null ? `${entry.majorAxisArcmin.toFixed(1)}'` : null),
    imageUrl: `/api/catalog/${encodeURIComponent(id)}/image`,
    wikiUrl,
    alsoKnownAs: getAlsoKnownAs(id),
    override: getOverrideRecord(id) ?? null,
  };

  // When the object is in the library but has no description yet, trigger a
  // background re-enrichment. Skip if catalogCache already recorded not_found —
  // the prefetch job already determined Wikipedia has no page for this object,
  // so retrying on every /info request just hammers Wikipedia pointlessly.
  if (!description && obj && cached?.status !== 'not_found') {
    enrichObjectData(id).catch(() => {});
  }

  res.apiSuccess(info);
});

// ─── User overrides for catalog metadata ─────────────────────────────────
// Layered on top of every read path via getCatalogEntry / the /info route.
// Admin-only (matches the prefetch routes' permission model).
// The current override (if any) is exposed on /info via the `override` field
// so the UI can pre-fill its edit form without a second request.

router.put('/:id/override', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const body: Record<string, unknown> = (req.body && typeof req.body === 'object') ? req.body : {};

  const asString = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const asNumber = (v: unknown): number | undefined => {
    if (v === '' || v == null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const patch = {
    name: asString(body.name),
    type: asString(body.type),
    constellation: asString(body.constellation),
    magnitude: asNumber(body.magnitude),
    description: asString(body.description),
    ra: asString(body.ra),
    dec: asString(body.dec),
    distanceLy: asNumber(body.distanceLy),
  };
  const record = saveOverride(id, patch, req.userId ?? null);
  res.apiSuccess(record);
});

router.delete('/:id/override', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const removed = deleteOverride(id);
  res.apiSuccess({ removed });
});

// ─── Catalog credits ────────────────────────────────────────────────────
// Returns image credit info for a specific object. Reads from credits-{tier}.json
// files installed into sky-cache/ by the catalog pack installer.
router.get('/credits/:id', (req: Request, res: Response) => {
  const id = normalizeCatalogId(String(req.params.id || ''));
  const creditsDir = path.join(DATA_DIR, 'sky-cache');
  const tiers = ['messier', 'caldwell', 'popular', 'extended', 'sharpless'] as const;

  for (const tier of tiers) {
    const creditsPath = path.join(creditsDir, `credits-${tier}.json`);
    try {
      const credits = JSON.parse(fs.readFileSync(creditsPath, 'utf8')) as Record<string, unknown>;
      if (id in credits) {
        res.apiSuccess(credits[id]);
        return;
      }
    } catch { /* file not present or unreadable */ }
  }

  res.apiError(404, 'NOT_FOUND', 'No credits found for this object');
});

// ─── Catalog prefetch job routes ─────────────────────────────────────────

// Unauthenticated diagnostic endpoint — walks each pack install step and
// reports exactly where the process fails without modifying any state.
router.get('/prefetch/pack-debug', async (_req: Request, res: Response) => {
  const PACK_INDEX_URL = 'https://downloads.nebulis.app/catalog/v1/index.json';
  const PACK_INDEX_SIG_URL = 'https://downloads.nebulis.app/catalog/v1/index.json.sig';
  const { verifyManifestSignature } = await import('../lib/catalogPack/verify.js');
  const { PackIndex } = await import('../lib/catalogPack/manifest.js');
  const { fetchJson, fetchText } = await import('../lib/catalogPack/download.js');
  const skyCacheDir = path.join(DATA_DIR, 'sky-cache');
  const signal = AbortSignal.timeout(15_000);

  const steps: Record<string, unknown> = {};

  // Step 1: sky-cache inventory
  try {
    const files = fs.readdirSync(skyCacheDir);
    const masters = files.filter(f => f.endsWith('_master.jpg'));
    const hubble  = files.filter(f => f.startsWith('hubble_'));
    const wiki    = files.filter(f => f.startsWith('wiki_'));
    steps.skyCacheInventory = { total: files.length, masters: masters.length, hubble: hubble.length, wiki: wiki.length };
  } catch (err) {
    steps.skyCacheInventory = { error: err instanceof Error ? err.message : String(err) };
  }

  // Step 2: pack state from DB
  steps.installedPacks = getAllPackStates();

  // Step 3: fetch index.json
  let indexBuf: Buffer | null = null;
  try {
    indexBuf = await fetchJson(PACK_INDEX_URL, signal);
    steps.indexFetch = { ok: true, bytes: indexBuf.length };
  } catch (err) {
    steps.indexFetch = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return res.apiSuccess({ steps });
  }

  // Step 4: fetch index.json.sig
  let indexSig: string | null = null;
  try {
    indexSig = await fetchText(PACK_INDEX_SIG_URL, signal);
    steps.indexSigFetch = { ok: true, bytes: indexSig.length };
  } catch (err) {
    steps.indexSigFetch = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return res.apiSuccess({ steps });
  }

  // Step 5: signature verification
  const sigValid = verifyManifestSignature(indexBuf, indexSig);
  steps.indexSignature = { valid: sigValid };
  if (!sigValid) return res.apiSuccess({ steps });

  // Step 6: parse index
  let parsedIndex: { tiers: { tier: string; version: string; totalObjects: number; archiveUrl: string; manifestUrl: string; manifestSigUrl: string; archiveSha256: string }[] } | null = null;
  try {
    parsedIndex = PackIndex.parse(JSON.parse(indexBuf.toString('utf8')));
    steps.indexParse = { ok: true, tiers: parsedIndex.tiers.map(t => ({
      tier: t.tier, version: t.version, totalObjects: t.totalObjects, archiveUrl: t.archiveUrl,
    })) };
  } catch (err) {
    steps.indexParse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return res.apiSuccess({ steps });
  }

  // Step 7: fetch manifest for each tier
  const tierResults: Record<string, unknown> = {};
  for (const entry of parsedIndex.tiers) {
    const t: Record<string, unknown> = { version: entry.version, totalObjects: entry.totalObjects, archiveUrl: entry.archiveUrl };
    try {
      const [mBuf, mSig] = await Promise.all([
        fetchJson(entry.manifestUrl, signal),
        fetchText(entry.manifestSigUrl, signal),
      ]);
      t.manifestFetch = { ok: true, bytes: mBuf.length };
      t.manifestSignature = { valid: verifyManifestSignature(mBuf, mSig) };
    } catch (err) {
      t.manifestFetch = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    tierResults[entry.tier] = t;
  }
  steps.tiers = tierResults;

  res.apiSuccess({ steps });
});

router.get('/prefetch/status', (_req: Request, res: Response) => {
  res.apiSuccess({
    ...getPrefetchStatus(),
    stats: getCatalogCacheStats(),
    packStates: getAllPackStates(),
  });
});

router.post('/prefetch/start', requireAdmin, (req: Request, res: Response) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const packsOnly = req.query.packsOnly === '1' || req.query.packsOnly === 'true';
  const rawPhase = String(req.query.phase || '');
  // Narrow via literal-union guard so the branch refines the type without a cast.
  const phase: 'images' | 'wikipedia' | 'caldwell' | undefined =
    rawPhase === 'images' || rawPhase === 'wikipedia' || rawPhase === 'caldwell'
      ? rawPhase
      : undefined;
  const rawScope = String(req.query.scope || '');
  const scope: 'curated' | 'full' =
    rawScope === 'full' ? 'full' : 'curated';
  const result = startPrefetch({ force, phase, scope, packsOnly });
  res.apiSuccess({ ...result, status: getPrefetchStatus() });
});

router.post('/prefetch/cancel', requireAdmin, (_req: Request, res: Response) => {
  const cancelled = cancelPrefetch();
  res.apiSuccess({ cancelled, status: getPrefetchStatus() });
});

// Dump everything and reset to a fresh state. Destructive — requires the
// client to echo `confirmation: "reinitialize"` in the request body.
router.delete('/prefetch/cache', requireAdmin, (req: Request, res: Response) => {
  // Narrow the JSON body at the boundary instead of casting. Express types
  // `req.body` as `any`; we treat it as `unknown` and verify the shape.
  const body: unknown = req.body;
  let confirmation: unknown;
  if (body !== null && typeof body === 'object') {
    // `in` operator narrows `body` to an object with the property — no cast needed.
    confirmation = 'confirmation' in body ? body.confirmation : undefined;
  }
  if (confirmation !== 'reinitialize') {
    res.apiError(
      400,
      'CONFIRMATION_REQUIRED',
      'Send { "confirmation": "reinitialize" } to confirm cache wipe',
    );
    return;
  }
  wipeCatalogCache();
  res.apiSuccess({ wiped: true, stats: getCatalogCacheStats() });
});

// ─── Reverse geocode cache (disk-backed) ─────────────────────────────────
const geocodeCache = new Map<string, string | null>();
const GEOCODE_CACHE_FILE = path.join(SKY_CACHE_DIR, '_geocode_cache.json');

try {
  const raw: unknown = JSON.parse(fs.readFileSync(GEOCODE_CACHE_FILE, 'utf-8'));
  if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v === null) geocodeCache.set(k, null);
      else if (typeof v === 'string') geocodeCache.set(k, v);
    }
  }
} catch { /* no cache yet */ }

function saveGeocodeCache() {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of geocodeCache) obj[k] = v;
  fs.writeFile(GEOCODE_CACHE_FILE, JSON.stringify(obj), () => {});
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Nebulis/1.0 (astronomy observation app)' },
    });
    if (!resp.ok) { geocodeCache.set(key, null); saveGeocodeCache(); return null; }
    const data: unknown = await resp.json();
    // Narrow the Nominatim response at the boundary — we only need data.address.
    const addr: Record<string, string> = {};
    if (data !== null && typeof data === 'object' && 'address' in data) {
      const rawAddr: unknown = data.address;
      if (rawAddr !== null && typeof rawAddr === 'object') {
        for (const [k, v] of Object.entries(rawAddr)) {
          if (typeof v === 'string') addr[k] = v;
        }
      }
    }
    const city = addr.city || addr.town || addr.village || addr.county || null;
    // ISO3166-2-lvl4 gives e.g. "US-TN" — parse to get the abbreviation "TN"
    const isoRegion = addr['ISO3166-2-lvl4'];
    const stateAbbr = isoRegion ? isoRegion.split('-').pop() ?? null : null;
    const state = stateAbbr || addr.state || null;
    const location = city && state ? `${city}, ${state}` : city || state || null;
    geocodeCache.set(key, location);
    saveGeocodeCache();
    return city;
  } catch {
    return null; // Don't cache network errors
  }
}

router.get('/geocode/reverse', async (req: Request, res: Response) => {
  const lat = parseFloat(String(req.query.lat));
  const lon = parseFloat(String(req.query.lon));
  if (isNaN(lat) || isNaN(lon)) {
    res.apiError(400, 'INVALID_PARAMS', 'lat and lon are required');
    return;
  }
  const [city, timezone] = await Promise.all([
    reverseGeocode(lat, lon),
    lookupTimeZoneForCoordinates(lat, lon),
  ]);
  res.apiSuccess({ city, timezone });
});

// ─── Forward geocode (city / place search) ───────────────────────────────
// Open-Meteo geocoding: free, no API key, CORS-friendly, and already the
// source of the weather forecast. Returns lat/lon plus the IANA timezone, so
// selecting a place can also set the planner/forecast timezone correctly.
interface ForwardGeocodeResult {
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  timezone: string | null;
  country: string | null;
  admin1: string | null;
}

// In-memory only (search queries are varied and transient — no disk cache like
// the coordinate-keyed reverse lookup). Bounded so a long typing session can't
// grow it without limit.
const geocodeSearchCache = new Map<string, ForwardGeocodeResult[]>();
const GEOCODE_SEARCH_CACHE_MAX = 200;

async function forwardGeocode(query: string): Promise<ForwardGeocodeResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const cached = geocodeSearchCache.get(key);
  if (cached) return cached;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Nebulis/1.0 (astronomy observation app)' },
    });
    if (!resp.ok) return [];
    const data: unknown = await resp.json();
    const rawResults: unknown[] =
      data !== null && typeof data === 'object' && 'results' in data && Array.isArray(data.results)
        ? data.results
        : [];
    const results: ForwardGeocodeResult[] = [];
    for (const r of rawResults) {
      if (r === null || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name : null;
      const latitude = typeof rec.latitude === 'number' ? rec.latitude : null;
      const longitude = typeof rec.longitude === 'number' ? rec.longitude : null;
      if (!name || latitude === null || longitude === null) continue;
      const admin1 = typeof rec.admin1 === 'string' ? rec.admin1 : null;
      const country = typeof rec.country === 'string' ? rec.country : null;
      const timezone = typeof rec.timezone === 'string' ? rec.timezone : null;
      const label = [name, admin1, country].filter(Boolean).join(', ');
      results.push({ name, label, latitude, longitude, timezone, country, admin1 });
    }
    if (geocodeSearchCache.size >= GEOCODE_SEARCH_CACHE_MAX) {
      const firstKey = geocodeSearchCache.keys().next().value;
      if (firstKey !== undefined) geocodeSearchCache.delete(firstKey);
    }
    geocodeSearchCache.set(key, results);
    return results;
  } catch {
    return []; // network error — caller shows "no results"
  }
}

router.get('/geocode/search', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (q.trim().length < 2) {
    res.apiSuccess([]);
    return;
  }
  const results = await forwardGeocode(q);
  res.apiSuccess(results);
});

// Get specific catalog entry by ID (must be after /:id/image and /:id/info)
// Falls back to libraryObjects for IDs not in the static catalog (e.g. Caldwell C-numbers).
router.get('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);

  // Wikipedia extract from pre-downloaded catalog pack (or live prefetch result).
  // This is the authoritative description source — richer than the static catalog's
  // one-liners and covers Sharpless objects whose static description is always ''.
  const cached = getCatalogCacheEntry(id);
  const wikiExtract = cached?.status === 'ok' ? cached.extract : '';
  const wikiUrl = cached?.status === 'ok' ? cached.wikiUrl : null;
  const curated = getCuratedDescription(id);

  // User override wins over every auto-populated field.
  const override = getOverride(id);

  const entry = getCatalogEntry(id);
  if (entry) {
    res.apiSuccess({
      ...entry,
      description: override?.description ?? (curated?.extract || wikiExtract || entry.description || ''),
      wikiUrl: curated?.wikiUrl || wikiUrl || undefined,
      alsoKnownAs: getAlsoKnownAs(id),
    });
    return;
  }

  interface LibObjFallbackRow {
    objectId: string; objectName: string | null; objectType: string | null;
    constellation: string | null; magnitude: number | null; ra: string | null;
    dec: string | null; distanceLy: number | null; sizeArcmin: string | null;
    description: string | null;
  }
  // Typed prepared statement — SQL trust boundary enforced by libraryObjects schema.
  const libObjFallbackStmt = db.prepare<[string], LibObjFallbackRow>(
    `SELECT objectId, objectName, objectType, constellation, magnitude, ra, dec, distanceLy, sizeArcmin, description
     FROM libraryObjects WHERE objectId = ? AND deleted = 0 LIMIT 1`,
  );
  // Library fallback — any object the user has imported (Caldwell objects, custom objects)
  const libObj = libObjFallbackStmt.get(id);

  if (libObj) {
    // Parse sizeArcmin display string ("13.5' x 5.2'" or "13.5'") to a number
    const majorAxisArcmin = libObj.sizeArcmin
      ? parseFloat(libObj.sizeArcmin) || null
      : null;
    res.apiSuccess({
      id: libObj.objectId,
      name: libObj.objectName || libObj.objectId,
      type: libObj.objectType || 'Unknown',
      constellation: libObj.constellation || '',
      magnitude: libObj.magnitude ?? undefined,
      description: override?.description ?? (curated?.extract || wikiExtract || libObj.description || ''),
      alsoKnownAs: getAlsoKnownAs(id),
      ra: libObj.ra ?? undefined,
      dec: libObj.dec ?? undefined,
      distanceLy: libObj.distanceLy ?? undefined,
      majorAxisArcmin,
      wikiUrl: curated?.wikiUrl || wikiUrl || undefined,
    });
    return;
  }

  res.apiError(404, 'NOT_FOUND', `Catalog entry "${id}" not found`);
});

export { router as catalogRouter };
