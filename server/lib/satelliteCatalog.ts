import fs from 'fs';
import path from 'path';
import { createGzip, createGunzip } from 'zlib';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DATA_DIR } from './paths.js';
import { log } from './logger.js';

export interface TLERecord {
  name: string;
  line1: string;
  line2: string;
  noradId: number;
}

function isTLERecord(value: unknown): value is TLERecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.line1 === 'string' &&
    typeof v.line2 === 'string' &&
    typeof v.noradId === 'number'
  );
}

function parseTLECatalog(source: string, raw: string): TLERecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[tle] ${source}: invalid JSON (${message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[tle] ${source}: expected array, got ${typeof parsed}`);
  }
  const records: TLERecord[] = [];
  for (const entry of parsed) {
    if (isTLERecord(entry)) records.push(entry);
  }
  return records;
}

const ARCHIVE_DIR = path.join(DATA_DIR, 'tle-archive');
const ARCHIVE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch { /* ignore */ }

const CELESTRAK_URLS = [
  // Celestrak GP API groups — 'active' and 'starlink' return 403; Starlink is
  // covered by the supplemental URL below.
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=oneweb&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=science&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=engineering&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=military&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=geo&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=tle',
  // LEO constellations — common trail sources in astrophotos, not covered by
  // the groups above. kuiper/qianfan are actively growing; planet doves
  // (~475 km) are among the most frequently seen trails.
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=kuiper&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=qianfan&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=planet&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-NEXT&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=spire&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=cubesat&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=globalstar&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=orbcomm&FORMAT=tle',
  // Supplemental data (includes recently launched, updated more frequently)
  'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?SPECIAL=gpz&FORMAT=tle',
];

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SatelliteCatalog {
  private catalogPath: string;
  private catalog: TLERecord[] = [];
  private lastFetch: Date | null = null;
  private isStaleFallback: boolean = false;

  constructor() {
    this.catalogPath = path.join(DATA_DIR, 'tle-catalog.json');
  }

  async loadCatalog(): Promise<TLERecord[]> {
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

    // Cache missing or stale — fetch fresh
    try {
      return await this.fetchFromCelestrak();
    } catch (err) {
      console.error('Failed to fetch from Celestrak:', err);

      // Fall back to stale cache if available
      if (fs.existsSync(this.catalogPath)) {
        try {
          const raw = fs.readFileSync(this.catalogPath, 'utf-8');
          this.catalog = parseTLECatalog('stale cache', raw);
          this.lastFetch = fs.statSync(this.catalogPath).mtime;
          this.isStaleFallback = true;
          console.warn('Using stale TLE cache as fallback — data may be outdated');
          return this.catalog;
        } catch (cacheErr) {
          console.error('Failed to read stale TLE cache:', cacheErr);
        }
      }

      return this.catalog;
    }
  }

  async fetchFromCelestrak(): Promise<TLERecord[]> {
    const allRecords: TLERecord[] = [];

    for (let i = 0; i < CELESTRAK_URLS.length; i++) {
      const url = CELESTRAK_URLS[i];
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        log.debug({ url }, `[tle] Fetching ${url}`);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(30000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Nebulis/1.0; +https://github.com/nebulis)' },
        });
        if (!response.ok) {
          log.debug({ status: response.status, url }, '[tle] Celestrak non-200, skipping group');
          continue;
        }
        const text = await response.text();
        const records = this.parseTLEText(text);
        log.debug(
          { count: records.length, group: url.split('GROUP=')[1]?.split('&')[0] || url },
          `[tle] Got ${records.length} records`,
        );
        allRecords.push(...records);
      } catch (err) {
        console.warn(`Failed to fetch TLE data from ${url}:`, err);
      }
    }

    // Deduplicate by NORAD ID, keeping the first occurrence
    const seen = new Map<number, TLERecord>();
    for (const record of allRecords) {
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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
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
