import fs from 'fs';
import path from 'path';
import { createGzip, createGunzip } from 'zlib';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { DATA_DIR } from './paths.js';
import { log } from './logger.js';
import { isErrnoException } from './errors.js';
import { isRecord } from './typeGuards.js';
// Bundled cold-start catalog. A fresh install (or a server whose IP is
// firewalled by CelesTrak) has no cache and no archive, so satellite trail
// identification would silently return "no catalog" until the first
// successful fetch. TLEs stay useful for a few weeks, so shipping a snapshot
// keeps identification working out of the box. Regenerate with
// `node scripts/build-tle-seed.mjs` (then bump SEED_EPOCH below) when it ages.
import tleSeedJson from '../data/tle-seed.json';

// Approximate epoch of the bundled seed, shown in the Settings catalog card
// so a user can tell at a glance how old the fallback data is.
const SEED_EPOCH = '2026-09-04';

export interface TLERecord {
  name: string;
  line1: string;
  line2: string;
  noradId: number;
}

function isTLERecord(value: unknown): value is TLERecord {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.line1 === 'string' &&
    typeof value.line2 === 'string' &&
    typeof value.noradId === 'number'
  );
}

function coerceTLEArray(source: string, parsed: unknown): TLERecord[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`[tle] ${source}: expected array, got ${typeof parsed}`);
  }
  const records: TLERecord[] = [];
  for (const entry of parsed) {
    if (isTLERecord(entry)) records.push(entry);
  }
  return records;
}

function parseTLECatalog(source: string, raw: string): TLERecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[tle] ${source}: invalid JSON (${message})`);
  }
  return coerceTLEArray(source, parsed);
}

// Parsed once, lazily. The seed is a plain JSON array bundled at build time.
let seedRecords: TLERecord[] | null = null;
function loadSeedRecords(): TLERecord[] {
  if (seedRecords === null) {
    try {
      seedRecords = coerceTLEArray('bundled seed', tleSeedJson);
    } catch (err) {
      log.warn({ err }, '[tle] Bundled seed catalog failed to parse');
      seedRecords = [];
    }
  }
  return seedRecords;
}

/** A non-200 from CelesTrak. Its message carries the server's stated reason. */
export class CelestrakError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CelestrakError';
  }
}

const ARCHIVE_DIR = path.join(DATA_DIR, 'tle-archive');
const ARCHIVE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch { /* ignore */ }

// CelesTrak firewalls any IP that sends it too many non-200 responses (their
// stated limit: ~50 HTTP 301/403/404 in a 2-hour window, or 1000 in a day,
// after which removal needs a manual review that takes days). See
// https://www.celestrak.org/usage-policy.php. The old code fetched ~21 URLs
// per sweep — several of which returned 403/404 by the module's own admission
// ("'active' and 'starlink' return 403") — on every server start, every
// manual refresh, and the first trail-positive frame of a stale-cache scan.
// That is exactly the traffic pattern that earns a ban, and a banned IP sees
// every request time out (packets dropped), not a 403.
//
// The fix: one request. GROUP=active is CelesTrak's canonical bulk feed and
// already contains stations, visual, oneweb, starlink, planet, the LEO
// constellations, etc. The supplemental Starlink file is fetched only as an
// additive second request for fresher Starlink elements, and only if the
// primary succeeded.
const CELESTRAK_PRIMARY_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
const CELESTRAK_SUPPLEMENTAL_URLS = [
  'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle',
];

// Contact info per CelesTrak's request that automated clients identify
// themselves. Kept in the Mozilla-compatible form so a UA filter does not
// bounce it.
const CELESTRAK_USER_AGENT =
  'Mozilla/5.0 (compatible; Nebulis/2.0; +https://github.com/nebulis-app/nebulis)';

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// After a failed live fetch, wait before trying again — exponential from 1h,
// doubling per consecutive failure, capped at 24h. A real CelesTrak block
// lasts days, so the old flat 10-minute cooldown just meant the app kept
// poking a firewalled endpoint (and, while a scan was running, re-hanging on
// it) for the whole outage. A single successful fetch resets the backoff.
// The manual "Refresh catalog" button bypasses this (user-initiated, one
// request, aborts on the first non-200).
const FETCH_BACKOFF_BASE_MS = 60 * 60 * 1000; // 1 hour
const FETCH_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

// Per-request bounds. celestrak.org answers a healthy request in a couple of
// seconds; 15s to connect and 30s overall is generous. A longer timeout only
// means a dead/blocked endpoint stalls the caller (a scan, server startup)
// for longer before falling back to the cache.
const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

// One Agent per request (not shared) so every fetch does a fresh TCP+TLS
// handshake, the way a browser page load does — a keep-alive socket that a
// load balancer silently dropped can never be handed to the next request.
function newCelestrakAgent(): Agent {
  return new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
}

export class SatelliteCatalog {
  private catalogPath: string;
  private catalog: TLERecord[] = [];
  private lastFetch: Date | null = null;
  private isStaleFallback: boolean = false;
  // Set when fetchFromCelestrak() fails outright. consecutiveFailures widens
  // the backoff exponentially (FETCH_BACKOFF_BASE_MS doubling per failure, up
  // to FETCH_BACKOFF_MAX_MS) rather than retrying on a flat interval — see
  // the comment on those constants for why a flat cooldown isn't enough.
  private lastFetchFailure: Date | null = null;
  private consecutiveFailures = 0;
  // Human-readable reason the last live fetch failed, surfaced in the Settings
  // catalog card. When CelesTrak blocks an IP it returns the explanation in
  // the response body (see fetchOneGroup); a firewall-level ban instead shows
  // up here as a connect timeout string. Cleared on the next success.
  private lastFetchError: string | null = null;

  constructor() {
    this.catalogPath = path.join(DATA_DIR, 'tle-catalog.json');
  }

  async loadCatalog(): Promise<TLERecord[]> {
    // Already loaded and still within the freshness window — reuse it rather
    // than re-reading and re-parsing the same multi-thousand-record JSON file
    // from disk. A session re-scan calls this once per sub-frame, so without
    // this a scan across many frames repeats the same disk read every time.
    if (
      this.catalog.length > 0 &&
      this.lastFetch &&
      Date.now() - this.lastFetch.getTime() < CACHE_MAX_AGE_MS
    ) {
      return this.catalog;
    }

    // Check if cached file exists and is fresh enough
    if (fs.existsSync(this.catalogPath)) {
      try {
        const stat = fs.statSync(this.catalogPath);
        const age = Date.now() - stat.mtimeMs;

        if (age < CACHE_MAX_AGE_MS) {
          const raw = fs.readFileSync(this.catalogPath, 'utf-8');
          this.catalog = parseTLECatalog('fresh cache', raw);
          this.lastFetch = stat.mtime;
          this.isStaleFallback = false;
          return this.catalog;
        }
      } catch (err) {
        console.warn('Failed to read TLE cache, will fetch fresh:', err);
      }
    }

    // A live fetch failed recently — back off exponentially rather than
    // retrying immediately (see FETCH_BACKOFF_BASE_MS/MAX_MS). Skip straight
    // to whatever's available offline instead of repeating a sweep that may
    // itself be the reason CelesTrak is blocking this IP.
    if (this.backoffRemainingMs() > 0) {
      return this.fallbackCatalog('cooldown');
    }

    // Cache missing or stale — fetch fresh
    try {
      return await this.fetchFromCelestrak();
    } catch (err) {
      console.error('Failed to fetch from Celestrak:', err);
      return this.fallbackCatalog('post-failure');
    }
  }

  /** Milliseconds until the exponential backoff from the last failed fetch
   *  expires, or 0 if a live fetch is allowed right now. */
  backoffRemainingMs(): number {
    if (!this.lastFetchFailure) return 0;
    const window = Math.min(
      FETCH_BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1),
      FETCH_BACKOFF_MAX_MS,
    );
    return Math.max(0, this.lastFetchFailure.getTime() + window - Date.now());
  }

  getLastFetchError(): string | null {
    return this.lastFetchError;
  }

  /** True when the catalog currently in memory is the bundled seed, not
   *  anything fetched or cached on this machine. */
  isUsingSeed(): boolean {
    return this.isStaleFallback && this.lastFetch === null && this.catalog.length > 0;
  }

  getSeedEpoch(): string {
    return SEED_EPOCH;
  }

  /**
   * Best catalog available without a live fetch: stale on-disk cache, else
   * the bundled seed, else whatever's already in memory (possibly empty on a
   * cold start with no network at all). Shared by both the pre-fetch backoff
   * short-circuit and the post-failure path so they can't drift apart.
   */
  private fallbackCatalog(reason: string): TLERecord[] {
    if (fs.existsSync(this.catalogPath)) {
      try {
        const raw = fs.readFileSync(this.catalogPath, 'utf-8');
        this.catalog = parseTLECatalog(`stale cache (${reason})`, raw);
        this.lastFetch = fs.statSync(this.catalogPath).mtime;
        this.isStaleFallback = true;
        return this.catalog;
      } catch (cacheErr) {
        console.error(`Failed to read stale TLE cache (${reason}):`, cacheErr);
      }
    }
    if (this.catalog.length === 0) {
      const seed = loadSeedRecords();
      if (seed.length > 0) {
        console.warn(`[tle] No cache available — using bundled seed catalog (epoch ${SEED_EPOCH})`);
        this.catalog = seed;
        this.isStaleFallback = true;
        // lastFetch stays null: this is bundled data, not something we
        // actually fetched, and getLastFetch() should say so.
      }
    }
    return this.catalog;
  }

  // Shared across concurrent callers so a cold start (the module-level eager
  // load and server/index.ts both call loadCatalog()) or a scan racing the
  // manual refresh button can never open two CelesTrak requests at once.
  private inFlightFetch: Promise<TLERecord[]> | null = null;

  /** One request, not twenty. See the CELESTRAK_PRIMARY_URL comment: hitting
   *  ~20 URLs (several already known to 403) on every server start, manual
   *  refresh, and trail-positive scan file is exactly the traffic pattern
   *  CelesTrak's usage policy bans an IP for. */
  fetchFromCelestrak(): Promise<TLERecord[]> {
    if (this.inFlightFetch) return this.inFlightFetch;
    this.inFlightFetch = this.runFetch().finally(() => {
      this.inFlightFetch = null;
    });
    return this.inFlightFetch;
  }

  private async runFetch(): Promise<TLERecord[]> {
    try {
      const records = await this.doFetchFromCelestrak();
      // Success resets the backoff for every caller (automatic loadCatalog and
      // the manual "Refresh catalog" button alike).
      this.lastFetchError = null;
      this.lastFetchFailure = null;
      this.consecutiveFailures = 0;
      return records;
    } catch (err) {
      // A failure here — including a manual refresh — starts/widens the
      // backoff, so the automatic path doesn't immediately re-hit an endpoint
      // that just refused us.
      this.lastFetchError = err instanceof Error ? err.message : String(err);
      this.lastFetchFailure = new Date();
      this.consecutiveFailures++;
      throw err;
    }
  }

  private async doFetchFromCelestrak(): Promise<TLERecord[]> {
    const primaryRecords = await this.fetchOneGroup(CELESTRAK_PRIMARY_URL, true);

    // Supplemental groups are fetched only after the primary succeeds (we
    // already have a usable catalog at this point) and a supplemental
    // failure never fails the whole fetch — the primary group already
    // contains Starlink, just potentially staler.
    const supplementalRecords: TLERecord[] = [];
    for (const url of CELESTRAK_SUPPLEMENTAL_URLS) {
      try {
        supplementalRecords.push(...await this.fetchOneGroup(url, false));
      } catch (err) {
        console.warn(`Failed to fetch supplemental TLE data from ${url}:`, err);
      }
    }

    // Supplemental first so its (fresher) entries win the keep-first dedupe
    // below; the primary group fills in everything supplemental doesn't cover.
    const seen = new Map<number, TLERecord>();
    for (const record of [...supplementalRecords, ...primaryRecords]) {
      if (!seen.has(record.noradId)) {
        seen.set(record.noradId, record);
      }
    }
    this.catalog = Array.from(seen.values());
    this.lastFetch = new Date();
    this.isStaleFallback = false;

    // Save to cache
    try {
      fs.writeFileSync(this.catalogPath, JSON.stringify(this.catalog, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Failed to write TLE cache:', err);
    }

    // Archive a dated gzip copy
    this.archiveCatalog(this.catalog).catch(err => {
      console.warn('[tle] Failed to archive catalog:', err);
    });

    // Prune old archives
    this.pruneArchives();

    return this.catalog;
  }

  /**
   * Fetch and parse one CelesTrak group URL with a fresh Agent (see
   * newCelestrakAgent). `required` controls what an empty/failed result
   * means: the primary group throws (routing loadCatalog() to its
   * stale-cache/seed fallback — an empty primary means the fetch effectively
   * failed even if the HTTP request itself succeeded), a supplemental group
   * just returns nothing and lets the caller decide.
   */
  private async fetchOneGroup(url: string, required: boolean): Promise<TLERecord[]> {
    const agent = newCelestrakAgent();
    try {
      log.debug({ url }, `[tle] Fetching ${url}`);
      const response = await undiciFetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'User-Agent': CELESTRAK_USER_AGENT },
        dispatcher: agent,
      });
      if (!response.ok) {
        // CelesTrak puts a human-readable explanation (usually the block
        // notice, with instructions) in the body of a non-200. Capture a
        // snippet for the logs and the Settings card so a block is
        // actionable rather than just "fetch failed".
        const body = (await response.text().catch(() => ''))
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400);
        const message = `CelesTrak returned HTTP ${response.status}${body ? `: ${body}` : ''}`;
        if (required) throw new CelestrakError(message, response.status);
        log.debug({ status: response.status, url }, '[tle] Celestrak non-200, skipping supplemental group');
        return [];
      }
      const text = await response.text();
      const records = this.parseTLEText(text);
      log.debug(
        { count: records.length, group: url.split('GROUP=')[1]?.split('&')[0] || url },
        `[tle] Got ${records.length} records`,
      );
      if (required && records.length === 0) {
        // Do NOT let an empty result become the new catalog: that would
        // overwrite a good on-disk cache with `[]` and permanently disable
        // satellite ID until the next successful fetch.
        throw new Error(`[tle] Celestrak primary catalog returned zero parseable records from ${url}`);
      }
      return records;
    } finally {
      // Immediate teardown, not graceful close: the request is already
      // finished (or was just aborted), so there's nothing left to drain,
      // and destroy() guarantees the socket can't linger into a later
      // request's pool the way a shared, long-lived Agent's did.
      void agent.destroy().catch(() => { /* best-effort */ });
    }
  }

  parseTLEText(text: string): TLERecord[] {
    const records: TLERecord[] = [];
    const lines = text
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim().length > 0);

    for (let i = 0; i < lines.length - 2; i += 3) {
      const nameLine = lines[i].trim();
      const line1 = lines[i + 1];
      const line2 = lines[i + 2];

      // Validate that lines start with expected characters
      if (!line1.startsWith('1') || !line2.startsWith('2')) {
        continue;
      }

      const noradId = parseInt(line1.substring(2, 7).trim(), 10);
      if (isNaN(noradId)) {
        continue;
      }

      records.push({
        name: nameLine,
        line1,
        line2,
        noradId,
      });
    }

    return records;
  }

  getCatalog(): TLERecord[] {
    return this.catalog;
  }

  getByNoradId(id: number): TLERecord | undefined {
    return this.catalog.find((r) => r.noradId === id);
  }

  getLastFetch(): Date | null {
    return this.lastFetch;
  }

  isUsingStaleFallback(): boolean {
    return this.isStaleFallback;
  }

  search(query: string): TLERecord[] {
    const q = query.toLowerCase();
    return this.catalog.filter((r) => r.name.toLowerCase().includes(q));
  }

  // ─── Archive management ──────────────────────────────────────────

  private _archiving = false;

  /** Save a dated gzip archive of the current catalog. */
  private async archiveCatalog(records: TLERecord[]): Promise<void> {
    if (this._archiving) return;
    this._archiving = true;
    try {
      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const archivePath = path.join(ARCHIVE_DIR, `${dateStr}.json.gz`);
      if (fs.existsSync(archivePath)) return;

      // Ensure the archive directory exists before creating any streams.
      // The purge operation deletes this directory; without mkdirSync here,
      // createWriteStream below produces a stream with no error listener, and
      // when Node tries to open the missing path it emits an unhandled 'error'
      // event that crashes the process.
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

      const json = JSON.stringify(records);
      const tmpPath = archivePath + '.tmp';
      const readable = Readable.from([Buffer.from(json, 'utf-8')]);
      const writeStream = fs.createWriteStream(tmpPath);
      const gzip = createGzip({ level: 9 });
      await pipeline(readable, gzip, writeStream);
      fs.renameSync(tmpPath, archivePath);

      const size = fs.statSync(archivePath).size;
      console.log(`[tle] Archived ${records.length} records → ${archivePath} (${(size / 1024).toFixed(0)} KB)`);
    } finally {
      this._archiving = false;
    }
  }

  /** Remove archive files older than 1 year. */
  private pruneArchives(): void {
    try {
      const files = fs.readdirSync(ARCHIVE_DIR);
      const cutoff = Date.now() - ARCHIVE_MAX_AGE_MS;
      let pruned = 0;

      for (const file of files) {
        if (!file.endsWith('.json.gz')) continue;
        const dateStr = file.replace('.json.gz', '');
        const fileDate = new Date(dateStr + 'T00:00:00Z').getTime();
        if (isNaN(fileDate)) continue;

        if (fileDate < cutoff) {
          fs.unlinkSync(path.join(ARCHIVE_DIR, file));
          pruned++;
        }
      }

      if (pruned > 0) {
        console.log(`[tle] Pruned ${pruned} archive(s) older than 1 year`);
      }
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'ENOENT') {
        console.warn('[tle] Failed to prune archives:', err);
      }
    }
  }

  /**
   * Load the archived TLE catalog closest to the given date.
   * Returns null if no archive is within range.
   */
  async loadCatalogForDate(targetDate: Date): Promise<TLERecord[] | null> {
    // If the target date is within 3 days of now, just use the current catalog
    const now = Date.now();
    const targetMs = targetDate.getTime();
    if (Math.abs(now - targetMs) < 3 * 24 * 60 * 60 * 1000) {
      return this.loadCatalog();
    }

    // Find the closest archive
    let bestFile: string | null = null;
    let bestDiff = Infinity;

    try {
      const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json.gz'));

      for (const file of files) {
        const dateStr = file.replace('.json.gz', '');
        const archiveDate = new Date(dateStr + 'T12:00:00Z').getTime();
        if (isNaN(archiveDate)) continue;

        const diff = Math.abs(archiveDate - targetMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestFile = file;
        }
      }
    } catch {
      return null;
    }

    if (!bestFile) return null;

    // If the closest archive is more than 7 days from the target, it's too stale
    if (bestDiff > 7 * 24 * 60 * 60 * 1000) return null;

    // Decompress and parse
    try {
      const archivePath = path.join(ARCHIVE_DIR, bestFile);
      const chunks: Buffer[] = [];
      const gunzip = createGunzip();
      const input = fs.createReadStream(archivePath);

      await new Promise<void>((resolve, reject) => {
        input.pipe(gunzip);
        gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
        gunzip.on('end', resolve);
        gunzip.on('error', reject);
        input.on('error', reject);
      });

      const json = Buffer.concat(chunks).toString('utf-8');
      const records = parseTLECatalog(`archive ${bestFile}`, json);
      console.log(`[tle] Loaded ${records.length} archived records from ${bestFile} (${(bestDiff / 86400000).toFixed(1)} days from target)`);
      return records;
    } catch (err) {
      console.warn(`[tle] Failed to load archive ${bestFile}:`, err);
      return null;
    }
  }

  /** Get the date range of available archives. */
  getArchiveRange(): { oldest: string | null; newest: string | null; count: number } {
    try {
      const files = fs.readdirSync(ARCHIVE_DIR)
        .filter(f => f.endsWith('.json.gz'))
        .map(f => f.replace('.json.gz', ''))
        .sort();

      return {
        oldest: files[0] || null,
        newest: files[files.length - 1] || null,
        count: files.length,
      };
    } catch {
      return { oldest: null, newest: null, count: 0 };
    }
  }
}

export const satelliteCatalog = new SatelliteCatalog();

// Eager-load TLE catalog on startup so detection never blocks on a first fetch
satelliteCatalog.loadCatalog().then(records => {
  console.log(`[tle] Catalog ready: ${records.length} satellites loaded`);
}).catch(err => {
  console.warn('[tle] Failed to pre-load catalog on startup:', err);
});
