/**
 * Sky image resolution — fetches and caches master images for astronomical objects.
 *
 * Three-tier resolution:
 *   1. Solar system objects → NASA Image Library (public domain)
 *   2. Objects in local catalog → CDS HiPS DSS2 color survey
 *   3. Any astronomical name → CDS Sesame resolver → CDS HiPS
 *
 * When CDS fails several times in a row it is skipped for a while. Cutouts then come first from our own rendering
 * of the same survey over partner HiPS tile pyramids (`hips/`), and if that cannot be built they fall back to the
 * SDSS, Legacy, SkyView and Pan-STARRS cutout services (see skyImageFallback.ts). A picture from one of those is
 * marked, and the CDS one replaces it later.
 *
 * Extracted from server/routes/catalog.ts to break the upward lib→route dependency
 * that existed when catalogPrefetch.ts imported prefetchSkyImage from a route file.
 */

import fs from 'fs';
import path from 'path';
import { getCatalogEntry } from './catalogLookup.js';
import { SOLAR_SYSTEM_LOOKUP_KEYS, SOLAR_SYSTEM_NASA_TERMS, SOLAR_SYSTEM_ASTROBACKYARD_URLS } from '../data/solar-system-catalog.js';
import { raToDegs, decToDegs } from './astroCalc.js';
import { DATA_DIR } from './paths.js';
import { isRecord } from './typeGuards.js';
import {
  cdsIsSkipped, recordCdsFailure, recordCdsSuccess, fetchFallbackSkyImage,
  markFallbackImage, isFallbackImage, clearFallbackMark,
} from './skyImageFallback.js';
import { renderHipsCutout } from './hips/cutout.js';

// Local constants — kept self-contained to avoid a circular dependency with
// catalogPrefetch.ts (which imports this module). catalogPrefetch exports the
// same values for the route layer; both must stay in sync.
const MASTER_WIDTH = 1920;
const MASTER_HEIGHT = 1280;

const SKY_CACHE_DIR = path.join(DATA_DIR, 'sky-cache');

function masterCacheKey(id: string): string {
  const normalized = id.replace(/\s+/g, '').toUpperCase();
  return `${normalized}_master`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function imageCachePath(id: string): string {
  return path.join(SKY_CACHE_DIR, `${masterCacheKey(id)}.jpg`);
}

/** Thumbnails cut from a DSS2 master are named by id and source, not by the master's content, so a master that is
 *  replaced (a backup picture giving way to the CDS one) leaves them stale until they are removed. */
export function dropDerivedThumbnails(id: string): void {
  const prefix = `${id.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9_.-]/g, '_')}_dss2_`;
  const dir = path.join(SKY_CACHE_DIR, 'resized');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix) && /^\d+x\d+(_cover)?\.jpg$/i.test(name.slice(prefix.length))) fs.unlinkSync(path.join(dir, name));
    }
  } catch { /* no thumbnails yet */ }
}

// ─── Sesame coordinate resolver ──────────────────────────────────────

const sesameCache = new Map<string, { ra: number; dec: number } | null>();
const SESAME_CACHE_FILE = path.join(SKY_CACHE_DIR, '_sesame_cache.json');

function isCoords(v: unknown): v is { ra: number; dec: number } {
  return isRecord(v) && typeof v.ra === 'number' && typeof v.dec === 'number';
}

try {
  const raw: unknown = JSON.parse(fs.readFileSync(SESAME_CACHE_FILE, 'utf-8'));
  if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v === null) sesameCache.set(k, null);
      else if (isCoords(v)) sesameCache.set(k, v);
    }
  }
} catch { /* no cache yet */ }

function saveSesameCache() {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of sesameCache) obj[k] = v;
  fs.writeFile(SESAME_CACHE_FILE, JSON.stringify(obj), () => {});
}

/**
 * Sesame resolves a name to coordinates. CDS runs it, and publishes mirrors for the times its own site is
 * degraded: IDIA in South Africa and CfA Harvard. Tried in that order, because CDS is the reference and the
 * mirrors can lag its catalogue by weeks.
 */
const SESAME_HOSTS = [
  'https://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame',
  'https://vizier.idia.ac.za/viz-bin/nph-sesame',
  'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame',
] as const;

/**
 * Coordinates for a name, from the first Sesame mirror that knows it. Exported for the mirror tests.
 *
 * A name is remembered as unknown only when every host answered and none had it: a host that is merely
 * unreachable says nothing about whether the name exists, and caching that would hide the object until the cache
 * file is deleted.
 */
export async function resolveObjectCoords(name: string): Promise<{ ra: number; dec: number } | null> {
  const key = name.toUpperCase().replace(/\s+/g, '');
  const cachedCoords = sesameCache.get(key);
  if (cachedCoords !== undefined) return cachedCoords;

  const query = `/-ox/SNV?${encodeURIComponent(name)}`;
  let hostsAnswered = 0;
  for (const host of SESAME_HOSTS) {
    let xml: string;
    try {
      const resp = await fetch(host + query, { signal: AbortSignal.timeout(3000) });
      if (resp.status >= 400 && resp.status < 500) {
        // The resolver understood the name and does not have it. That is an answer, so a mirror is still worth a try.
        hostsAnswered++;
        continue;
      }
      if (!resp.ok) continue;
      xml = await resp.text();
    } catch {
      continue;
    }

    hostsAnswered++;
    const raMatch = xml.match(/<jradeg>([\d.+-]+)<\/jradeg>/);
    const decMatch = xml.match(/<jdedeg>([\d.+-]+)<\/jdedeg>/);
    if (raMatch && decMatch) {
      const coords = { ra: parseFloat(raMatch[1]), dec: parseFloat(decMatch[1]) };
      sesameCache.set(key, coords);
      saveSesameCache();
      return coords;
    }
  }

  if (hostsAnswered === SESAME_HOSTS.length) {
    sesameCache.set(key, null);
    saveSesameCache();
  }
  return null;
}

// ─── Solar system / AstroBackyard + NASA Image Library ──────────────

function isSolarSystemObject(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  return SOLAR_SYSTEM_LOOKUP_KEYS.has(normalized);
}

async function fetchAstroBackyardImage(name: string): Promise<Buffer | null> {
  const url = SOLAR_SYSTEM_ASTROBACKYARD_URLS[name.toLowerCase().replace(/[^a-z]/g, '')];
  if (!url) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

async function fetchNasaImage(name: string): Promise<Buffer | null> {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  const searchTerm = SOLAR_SYSTEM_NASA_TERMS[normalized] || `${name} astronomy`;

  try {
    const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(searchTerm)}&media_type=image`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return null;

    // NASA's API is a third party: narrow every level with isRecord rather
    // than reaching into it through casts.
    const data: unknown = await resp.json();
    if (!isRecord(data) || !isRecord(data.collection)) return null;
    const items = data.collection.items;
    if (!Array.isArray(items)) return null;

    const isPreviewLink = (l: unknown): l is { href: string; rel: string } => {
      if (!isRecord(l)) return false;
      const { href, rel } = l;
      return typeof href === 'string' && rel === 'preview' && href.endsWith('.jpg');
    };

    for (const item of items) {
      if (!isRecord(item)) continue;
      const links = item.links;
      if (!Array.isArray(links)) continue;
      const link = links.find(isPreviewLink);
      if (link) {
        const imgResp = await fetch(link.href, { signal: AbortSignal.timeout(10000) });
        if (imgResp.ok) return Buffer.from(await imgResp.arrayBuffer());
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Negative cache ──────────────────────────────────────────────────

const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — persisted across restarts
const NEGATIVE_CACHE_FILE = path.join(SKY_CACHE_DIR, '_negative_cache.json');

const negativeImageCache = new Map<string, number>();

// Network failures get a separate, short, in-memory-only negative cache.
// They must not go into the 24h persistent cache (the object's image exists
// upstream; only this machine's connectivity failed), but they must be cached
// for a little while: with no entry at all, an offline install re-attempts the
// live CDS fetch on every request for every uncached object, and those hung
// requests occupy the browser's per-origin connection pool and starve real
// API calls.
const TRANSIENT_NEGATIVE_TTL_MS = 10 * 60 * 1000;
const transientNegativeCache = new Map<string, number>();

try {
  const raw: unknown = JSON.parse(fs.readFileSync(NEGATIVE_CACHE_FILE, 'utf-8'));
  if (raw !== null && typeof raw === 'object') {
    const cutoff = Date.now() - NEGATIVE_CACHE_TTL_MS;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number' && v > cutoff) negativeImageCache.set(k, v);
    }
  }
} catch { /* no cache yet */ }

function saveNegativeCache() {
  const obj: Record<string, number> = {};
  for (const [k, v] of negativeImageCache) obj[k] = v;
  fs.writeFile(NEGATIVE_CACHE_FILE, JSON.stringify(obj), () => {});
}

/**
 * Forget every negative-cache entry, in memory and on disk. Called by the
 * catalog "Wipe & reset" so a re-download retries objects that previously
 * 404'd or failed instead of silently skipping them for up to 24h.
 * The Sesame coordinate cache is intentionally left alone — resolved RA/Dec
 * values stay correct across a wipe.
 */
export function clearNegativeImageCache(): void {
  negativeImageCache.clear();
  transientNegativeCache.clear();
  try { fs.unlinkSync(NEGATIVE_CACHE_FILE); } catch { /* not present */ }
}

// ─── prefetchSkyImage ────────────────────────────────────────────────

type PrefetchSkyImageOpts = {
    fov?: number;
    /** RA in decimal degrees (0–360). When provided, skips catalog + Sesame lookup. */
    ra?: number;
    /** Dec in decimal degrees (-90–90). Must be paired with ra. */
    dec?: number;
    /** Force a fresh fetch even if cached or negative-cached. */
    force?: boolean;
    /** Deadline for the CDS DSS2 fetch. Defaults to 60s, which suits the
     *  background prefetch job. Interactive request handlers should pass
     *  something much shorter so a dead network doesn't pin the client's
     *  connection for a minute per thumbnail. */
    timeoutMs?: number;
};

/** Fetches in progress, keyed by normalized id. The master image is cached by id
 *  alone, so every caller asking for the same object wants the same file. */
const prefetchInFlight = new Map<string, Promise<string | null>>();

/**
 * Fetch and cache a master sky image for an object. Returns the master file
 * path on success, or null if the image could not be resolved. Always writes
 * at MASTER_WIDTH × MASTER_HEIGHT so all clients share one source file.
 *
 * Concurrent calls for the same object share one fetch. Without that, a page
 * that asks for the same image several times (thumbnails, planner, catalog)
 * started a separate slow CDS request for each, and when CDS is slow they all
 * timed out together. A `force` call never joins one: it exists to replace the
 * cached image, so it runs its own fetch.
 */
export function prefetchSkyImage(id: string, opts: PrefetchSkyImageOpts = {}): Promise<string | null> {
  if (opts.force) return fetchSkyImageUncoalesced(id, opts);
  const key = id.replace(/\s+/g, '').toUpperCase();
  const running = prefetchInFlight.get(key);
  if (running) return running;
  const started = fetchSkyImageUncoalesced(id, opts).finally(() => {
    if (prefetchInFlight.get(key) === started) prefetchInFlight.delete(key);
  });
  prefetchInFlight.set(key, started);
  return started;
}

async function fetchSkyImageUncoalesced(
  id: string,
  opts: PrefetchSkyImageOpts,
): Promise<string | null> {
  const fov = opts.fov || 1.0;
  const cachePath = imageCachePath(id);
  const normalizedId = id.replace(/\s+/g, '').toUpperCase();
  /** The cached picture is a backup one and CDS is worth trying again for it. */
  let upgrading = false;

  if (opts.force) {
    negativeImageCache.delete(normalizedId);
    transientNegativeCache.delete(normalizedId);
    try { fs.unlinkSync(cachePath); } catch { /* not present */ }
    clearFallbackMark(cachePath);
    dropDerivedThumbnails(id);
  } else {
    try {
      const stat = fs.statSync(cachePath);
      if (stat.size > 0) {
        // A backup picture stays until CDS answers again; then the CDS one replaces it.
        if (!isFallbackImage(cachePath) || cdsIsSkipped()) return cachePath;
        upgrading = true;
      }
    } catch { /* no cache */ }

    if (!upgrading) {
      const negCacheTs = negativeImageCache.get(normalizedId);
      if (negCacheTs && Date.now() - negCacheTs < NEGATIVE_CACHE_TTL_MS) {
        return null;
      }
      const transientTs = transientNegativeCache.get(normalizedId);
      if (transientTs && Date.now() - transientTs < TRANSIENT_NEGATIVE_TTL_MS) {
        return null;
      }
    }
  }

  if (isSolarSystemObject(id)) {
    const abImage = await fetchAstroBackyardImage(id);
    if (abImage) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, abImage);
      return cachePath;
    }
    const nasaImage = await fetchNasaImage(id);
    if (nasaImage) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, nasaImage);
      return cachePath;
    }
  }

  let ra: number | undefined = opts.ra;
  let dec: number | undefined = opts.dec;

  // Whether a missing-coords outcome is authoritative. Sesame caches a
  // definitive "no such object" as null but caches nothing on a network
  // error, so sesameCache.has() distinguishes "the resolver said no" from
  // "we couldn't reach the resolver".
  let coordsDefinitive = true;

  if (ra == null || dec == null) {
    const entry = getCatalogEntry(id);
    if (entry?.ra != null && entry?.dec != null) {
      ra = raToDegs(entry.ra);
      dec = decToDegs(entry.dec);
    } else {
      const resolved = await resolveObjectCoords(id);
      if (resolved) {
        ra = resolved.ra;
        dec = resolved.dec;
      } else {
        coordsDefinitive = sesameCache.has(id.toUpperCase().replace(/\s+/g, ''));
      }
    }
  }

  if (ra === undefined || dec === undefined) {
    const nasaImage = await fetchNasaImage(id);
    if (nasaImage) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, nasaImage);
      return cachePath;
    }
    // Only a definitive "no coordinates anywhere" earns the 24h persistent
    // negative entry. When the resolver itself was unreachable (offline),
    // use the short transient cache so the object retries soon after the
    // connection returns instead of being blocked for a day.
    if (coordsDefinitive) {
      negativeImageCache.set(normalizedId, Date.now());
      saveNegativeCache();
    } else {
      transientNegativeCache.set(normalizedId, Date.now());
    }
    return null;
  }

  const query = `?hips=CDS/P/DSS2/color`
    + `&width=${MASTER_WIDTH}&height=${MASTER_HEIGHT}`
    + `&fov=${fov}`
    + `&ra=${ra}&dec=${dec}`
    + `&projection=TAN`
    + `&format=jpg`;

  // What a failed attempt returns: the cached backup picture when this was an upgrade attempt, else nothing.
  const keepWhatWeHave = upgrading ? cachePath : null;

  if (!cdsIsSkipped()) {
    try {
      const resp = await fetchHips2fits(query, opts.timeoutMs ?? 60000);
      if (resp.ok) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, buffer);
        if (upgrading) {
          clearFallbackMark(cachePath);
          dropDerivedThumbnails(id);
        }
        return cachePath;
      }
      // id is request-controlled (catalog id from the URL); keep it out of
      // the format-string position (console.warn %-substitutes its first
      // argument) and pass it as a %s argument instead.
      console.warn('[skyImage] CDS HiPS fetch failed for %s: HTTP %s (ra=%s, dec=%s, fov=%s)', id, resp.status, ra, dec, fov);
      if (resp.status >= 400 && resp.status < 500) {
        if (!upgrading) {
          negativeImageCache.set(normalizedId, Date.now());
          saveNegativeCache();
        }
        return keepWhatWeHave;
      }
      // 5xx: CDS itself is having trouble. Same treatment as a network
      // failure — short transient entry so we stop hammering it but retry
      // within minutes rather than hours.
    } catch (err) {
      console.warn('[skyImage] CDS HiPS fetch error for %s:', id, err instanceof Error ? err.message : err);
      // Network-level failure (timeout, DNS, unreachable). The image likely
      // exists upstream, so remember the failure only briefly — long enough to
      // stop an offline session from re-hanging on every thumbnail request.
    }
    // The failure was counted by fetchHips2fits. Below the limit this request simply fails; at the limit CDS is
    // now being skipped and the backup sources take over, starting with this request.
    if (!cdsIsSkipped()) {
      if (!upgrading) transientNegativeCache.set(normalizedId, Date.now());
      return keepWhatWeHave;
    }
  }

  if (upgrading) return cachePath;
  const backup = await fetchFallbackSkyImage({
    ra, dec, fovDeg: fov, width: MASTER_WIDTH, height: MASTER_HEIGHT,
    timeoutMs: Math.min(opts.timeoutMs ?? 20000, 20000),
  });
  if (backup) {
    console.warn('[skyImage] CDS unavailable, using %s for %s', backup.source, id);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, backup.buffer);
    markFallbackImage(cachePath, backup.source);
    return cachePath;
  }
  transientNegativeCache.set(normalizedId, Date.now());
  return null;
}

// ─── CDS hips2fits hosts ─────────────────────────────────────────────────

// CDS serves hips2fits from several hosts and any one can accept the connection
// then never answer while another responds in about a second. Each host gets a
// slice of the caller's time budget and the last one that worked goes first next
// time, so a hanging host costs one short wait instead of the whole timeout.
const HIPS_HOSTS = ['alaskybis.cds.unistra.fr', 'alasky.cds.unistra.fr', 'alasky.u-strasbg.fr'];

/** GET a hips2fits URL (built from `query`) across the mirrors. A 2xx or 4xx
 *  answer from any host is final (a 4xx means this request is bad, not the
 *  host, unless it is an HTML error page from the web server); timeouts, network errors and 5xx move on to the next host. Throws the
 *  last error only when no host answered at all. */
export async function fetchHips2fits(query: string, totalTimeoutMs: number): Promise<Response> {
  // A host gets an even share of the budget, but never less than half a second and never more than four. The whole
  // loop also runs against one deadline, so the caller's timeout bounds the request even when it is short.
  const perHostMs = Math.max(500, Math.min(4000, Math.ceil(totalTimeoutMs / HIPS_HOSTS.length)));
  const deadline = Date.now() + totalTimeoutMs;
  let lastResp: Response | null = null;
  let lastErr: unknown = new Error('no hips2fits host answered');
  for (const host of [...HIPS_HOSTS]) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const resp = await fetch(`https://${host}/hips-image-services/hips2fits${query}`, { signal: AbortSignal.timeout(Math.min(perHostMs, left)) });
      // hips2fits answers a bad request with a plain-text error. An HTML error page is the web server itself saying the
      // service is not there (an outage or a moved endpoint), which says nothing about this request, so try the next host.
      const serverErrorPage = resp.status >= 400 && (resp.headers.get('content-type') ?? '').includes('text/html');
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && !serverErrorPage)) {
        const i = HIPS_HOSTS.indexOf(host);
        if (i > 0) { HIPS_HOSTS.splice(i, 1); HIPS_HOSTS.unshift(host); }
        recordCdsSuccess();
        return resp;
      }
      lastResp = resp;
    } catch (err) {
      lastErr = err;
    }
  }
  // No host gave a usable answer: one failure for the circuit breaker, however many hosts were tried.
  recordCdsFailure();
  if (lastResp) return lastResp;
  throw lastErr;
}

// ─── fetchSkyCutout ──────────────────────────────────────────────────────

const CUTOUT_DIR = path.join(SKY_CACHE_DIR, 'cutouts');

/** Round a FOV to a coarse bucket so nearby zoom levels share a cache file. */
export function bucketCutoutFov(fovDeg: number): number {
  const f = Math.min(20, Math.max(0.1, fovDeg));
  if (f < 2) return Math.round(f * 10) / 10; // 0.1° steps
  if (f < 6) return Math.round(f * 2) / 2; // 0.5° steps
  return Math.round(f); // 1° steps
}

/**
 * Fetch a SQUARE DSS2 sky cutout centered on ra/dec spanning `fovDeg` degrees,
 * for the framing atlas. Unlike prefetchSkyImage (one master per object at a
 * fixed field), this caches per object + FOV bucket, so the sky can be shown at
 * any zoom. Returns the cached file path, or null on failure.
 */
type SkyCutoutOpts = {
  id: string;
  ra: number; // decimal degrees
  dec: number; // decimal degrees
  fovDeg: number;
  sizePx?: number;
  timeoutMs?: number;
};

/** Cutouts being fetched or rendered, keyed like their cache files. A render decodes up to 64 tiles, so two people
 *  opening the same object on a small container must share one. */
const cutoutInFlight = new Map<string, Promise<string | null>>();

export function fetchSkyCutout(opts: SkyCutoutOpts): Promise<string | null> {
  const size = Math.min(1200, Math.max(256, Math.round(opts.sizePx ?? 800)));
  const key = `${opts.id.replace(/\s+/g, '').toUpperCase()}_${bucketCutoutFov(opts.fovDeg)}_${size}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const running = cutoutInFlight.get(key);
  if (running) return running;
  const started = fetchSkyCutoutUncoalesced(opts).finally(() => {
    if (cutoutInFlight.get(key) === started) cutoutInFlight.delete(key);
  });
  cutoutInFlight.set(key, started);
  return started;
}

async function fetchSkyCutoutUncoalesced(opts: SkyCutoutOpts): Promise<string | null> {
  const size = Math.min(1200, Math.max(256, Math.round(opts.sizePx ?? 800)));
  const fov = bucketCutoutFov(opts.fovDeg);
  const key = `${opts.id.replace(/\s+/g, '').toUpperCase()}_${fov}_${size}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const cachePath = path.join(CUTOUT_DIR, `${key}.jpg`);

  try {
    const stat = fs.statSync(cachePath);
    if (stat.size > 0) return cachePath;
  } catch { /* no cache */ }

  // A backup cutout lives in its own file, used only while CDS is being skipped, so the CDS cutout is fetched and
  // cached as soon as CDS answers again and nothing has to be replaced.
  const backupPath = path.join(CUTOUT_DIR, `${key}.backup.jpg`);
  const backupCutout = async (): Promise<string | null> => {
    try {
      const stat = fs.statSync(backupPath);
      if (stat.size > 0) return backupPath;
    } catch { /* not fetched yet */ }
    const backup = await fetchFallbackSkyImage({
      ra: opts.ra, dec: opts.dec, fovDeg: fov, width: size, height: size,
      timeoutMs: Math.min(opts.timeoutMs ?? 15000, 15000),
    });
    if (!backup) return null;
    fs.mkdirSync(CUTOUT_DIR, { recursive: true });
    fs.writeFileSync(backupPath, backup.buffer);
    return backupPath;
  };

  // Our own rendering of the same survey, from the tile pyramids the partner archives serve. It keeps the DSS2
  // look and exact geometry that CDS gives, where the fallback chain below substitutes a different product. Its
  // own file, so it never shadows a CDS cutout and CDS takes over again as soon as it answers.
  const renderedPath = path.join(CUTOUT_DIR, `${key}.hips.jpg`);
  const renderCutout = async (): Promise<string | null> => {
    try {
      const stat = fs.statSync(renderedPath);
      if (stat.size > 0) return renderedPath;
    } catch { /* not rendered yet */ }
    try {
      const rendered = await renderHipsCutout({ raDeg: opts.ra, decDeg: opts.dec, fovDeg: fov, sizePx: size });
      if (!rendered) return null;
      fs.mkdirSync(CUTOUT_DIR, { recursive: true });
      fs.writeFileSync(renderedPath, rendered.buffer);
      fs.writeFileSync(`${renderedPath}.source`, rendered.source, 'utf8');
      return renderedPath;
    } catch (err) {
      console.warn('[skyImage] hips render failed for %s:', opts.id, err instanceof Error ? err.message : err);
      return null;
    }
  };

  /** What to answer when CDS cannot: our own render first, then the survey substitutes it has always used. */
  const withoutCds = async (): Promise<string | null> => (await renderCutout()) ?? backupCutout();

  if (cdsIsSkipped()) return withoutCds();

  const query = `?hips=CDS/P/DSS2/color`
    + `&width=${size}&height=${size}`
    + `&fov=${fov}`
    + `&ra=${opts.ra}&dec=${opts.dec}`
    + `&projection=TAN`
    + `&format=jpg`;

  try {
    const resp = await fetchHips2fits(query, opts.timeoutMs ?? 15000);
    if (!resp.ok) {
      console.warn('[skyImage] cutout fetch failed for %s: HTTP %s (fov=%s)', opts.id, resp.status, fov);
      return withoutCds();
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.mkdirSync(CUTOUT_DIR, { recursive: true });
    fs.writeFileSync(cachePath, buffer);
    return cachePath;
  } catch (err) {
    console.warn('[skyImage] cutout fetch error for %s:', opts.id, err instanceof Error ? err.message : err);
    return withoutCds();
  }
}
