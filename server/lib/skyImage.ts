/**
 * Sky image resolution — fetches and caches master images for astronomical objects.
 *
 * Three-tier resolution:
 *   1. Solar system objects → NASA Image Library (public domain)
 *   2. Objects in local catalog → CDS HiPS DSS2 color survey
 *   3. Any astronomical name → CDS Sesame resolver → CDS HiPS
 *
 * Extracted from server/routes/catalog.ts to break the upward lib→route dependency
 * that existed when catalogPrefetch.ts imported prefetchSkyImage from a route file.
 */

import fs from 'fs';
import path from 'path';
import { getCatalogEntry } from '../data/catalog.js';
import { SOLAR_SYSTEM_LOOKUP_KEYS, SOLAR_SYSTEM_NASA_TERMS, SOLAR_SYSTEM_ASTROBACKYARD_URLS } from '../data/solar-system-catalog.js';
import { raToDegs, decToDegs } from './astroCalc.js';
import { DATA_DIR } from './paths.js';

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

// ─── Sesame coordinate resolver ──────────────────────────────────────

const sesameCache = new Map<string, { ra: number; dec: number } | null>();
const SESAME_CACHE_FILE = path.join(SKY_CACHE_DIR, '_sesame_cache.json');

function pluck(obj: object, key: string): unknown {
  return key in obj ? (obj as Record<string, unknown>)[key] : undefined;
}

function isCoords(v: unknown): v is { ra: number; dec: number } {
  if (v === null || typeof v !== 'object') return false;
  return typeof pluck(v, 'ra') === 'number' && typeof pluck(v, 'dec') === 'number';
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

async function resolveObjectCoords(name: string): Promise<{ ra: number; dec: number } | null> {
  const key = name.toUpperCase().replace(/\s+/g, '');
  if (sesameCache.has(key)) return sesameCache.get(key)!;

  try {
    const url = `https://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-ox/SNV?${encodeURIComponent(name)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) { sesameCache.set(key, null); return null; }

    const xml = await resp.text();
    const raMatch = xml.match(/<jradeg>([\d.+-]+)<\/jradeg>/);
    const decMatch = xml.match(/<jdedeg>([\d.+-]+)<\/jdedeg>/);

    if (raMatch && decMatch) {
      const coords = { ra: parseFloat(raMatch[1]), dec: parseFloat(decMatch[1]) };
      sesameCache.set(key, coords);
      saveSesameCache();
      return coords;
    }

    sesameCache.set(key, null);
    saveSesameCache();
    return null;
  } catch {
    return null;
  }
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

    const data: unknown = await resp.json();
    if (data === null || typeof data !== 'object') return null;
    const collection = pluck(data, 'collection');
    if (collection === null || typeof collection !== 'object') return null;
    const items = pluck(collection, 'items');
    if (!Array.isArray(items)) return null;

    const isPreviewLink = (l: unknown): l is { href: string; rel: string } => {
      if (l === null || typeof l !== 'object') return false;
      const href = pluck(l, 'href');
      const rel = pluck(l, 'rel');
      return typeof href === 'string' && typeof rel === 'string'
        && rel === 'preview' && href.endsWith('.jpg');
    };

    for (const item of items) {
      if (item === null || typeof item !== 'object') continue;
      const links = pluck(item, 'links');
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

/**
 * Fetch and cache a master sky image for an object. Returns the master file
 * path on success, or null if the image could not be resolved. Always writes
 * at MASTER_WIDTH × MASTER_HEIGHT so all clients share one source file.
 */
export async function prefetchSkyImage(
  id: string,
  opts: {
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
  } = {},
): Promise<string | null> {
  const fov = opts.fov || 1.0;
  const cachePath = imageCachePath(id);
  const normalizedId = id.replace(/\s+/g, '').toUpperCase();

  if (opts.force) {
    negativeImageCache.delete(normalizedId);
    transientNegativeCache.delete(normalizedId);
    try { fs.unlinkSync(cachePath); } catch { /* not present */ }
  } else {
    try {
      const stat = fs.statSync(cachePath);
      if (stat.size > 0) return cachePath;
    } catch { /* no cache */ }

    const negCacheTs = negativeImageCache.get(normalizedId);
    if (negCacheTs && Date.now() - negCacheTs < NEGATIVE_CACHE_TTL_MS) {
      return null;
    }
    const transientTs = transientNegativeCache.get(normalizedId);
    if (transientTs && Date.now() - transientTs < TRANSIENT_NEGATIVE_TTL_MS) {
      return null;
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

  const url = `https://alasky.cds.unistra.fr/hips-image-services/hips2fits`
    + `?hips=CDS/P/DSS2/color`
    + `&width=${MASTER_WIDTH}&height=${MASTER_HEIGHT}`
    + `&fov=${fov}`
    + `&ra=${ra}&dec=${dec}`
    + `&projection=TAN`
    + `&format=jpg`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60000) });
    if (!resp.ok) {
      console.warn(`[skyImage] CDS HiPS fetch failed for ${id}: HTTP ${resp.status} (ra=${ra}, dec=${dec}, fov=${fov})`);
      if (resp.status >= 400 && resp.status < 500) {
        negativeImageCache.set(normalizedId, Date.now());
        saveNegativeCache();
      } else {
        // 5xx: CDS itself is having trouble. Same treatment as a network
        // failure — short transient entry so we stop hammering it but retry
        // within minutes rather than hours.
        transientNegativeCache.set(normalizedId, Date.now());
      }
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, buffer);
    return cachePath;
  } catch (err) {
    console.warn(`[skyImage] CDS HiPS fetch error for ${id}:`, err instanceof Error ? err.message : err);
    // Network-level failure (timeout, DNS, unreachable). The image likely
    // exists upstream, so remember the failure only briefly — long enough to
    // stop an offline session from re-hanging on every thumbnail request.
    transientNegativeCache.set(normalizedId, Date.now());
    return null;
  }
}
