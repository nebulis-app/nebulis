/**
 * Fetching and decoding the HiPS tiles a cutout needs.
 *
 * The same `CDS/P/DSS2/color` survey is served as a plain tile pyramid by several partner archives. Those are
 * reachable when CDS's own cutout service is not, which is the whole reason this module exists: the tiles are the
 * product, and the pyramid is served over HTTP with no service behind it.
 *
 * Tiles are cached on disk under the same `sky-cache` tree as every other sky picture, keyed by host so one host
 * cannot answer with another's bytes, and so a bad host can be emptied on its own.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { DATA_DIR } from '../paths.js';

export interface TileSource {
  /** Short name written to the cache sidecar, so a cached cutout says where it came from. */
  name: string;
  /** HiPS root. Tile URLs are `root/Norder{N}/Dir{D}/Npix{P}.jpg`. */
  root: string;
}

/**
 * In order of preference. ESA and MAST were byte-identical when this was written (same MD5 per tile), so a cutout
 * does not change appearance when one of them is down. CASDA is the Australian mirror of the same survey. China-VO
 * is listed by CDS but did not answer from here, so it is not in the list.
 */
export const TILE_SOURCES: readonly TileSource[] = [
  { name: 'esa', root: 'https://skies.esac.esa.int/DSSColor' },
  { name: 'mast', root: 'https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/DSSColor' },
  { name: 'casda', root: 'https://casda.csiro.au/hips/DSS2/color' },
];

/** A DSS2 tile at 512 x 512 is about 100 KB. Anything near this size is not a tile. */
export const MAX_TILE_BYTES = 2 * 1024 * 1024;

/**
 * The response body, or null when it is larger than `limit`. Reads the stream and stops at the limit, because a host
 * that sends no Content-Length (chunked) would otherwise be read whole before any size check could run.
 */
async function readCapped(resp: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(resp.headers.get('content-length') ?? '0');
  if (declared > limit) {
    await resp.body?.cancel().catch(() => {});
    return null;
  }
  if (!resp.body) {
    const whole = Buffer.from(await resp.arrayBuffer());
    return whole.byteLength > limit ? null : whole;
  }
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** Source names become a folder name, so they are limited to what a folder name can safely be. */
const SAFE_SOURCE_NAME = /^[a-z0-9-]+$/i;

/** Where a tile lives on disk. `Dir` is the HiPS convention: thousands of the pixel index. */
export function tileCachePath(source: TileSource, order: number, tile: number, cacheRoot: string): string {
  if (!SAFE_SOURCE_NAME.test(source.name)) throw new Error(`Unsafe tile source name: ${JSON.stringify(source.name)}`);
  return path.join(cacheRoot, source.name, `Norder${order}`, `Dir${Math.floor(tile / 10000) * 10000}`, `Npix${tile}.jpg`);
}

export function tileUrl(source: TileSource, order: number, tile: number): string {
  return `${source.root}/Norder${order}/Dir${Math.floor(tile / 10000) * 10000}/Npix${tile}.jpg`;
}

/** A decoded tile: three channels, 512 by 512, row major. */
export interface TileImage {
  data: Buffer;
  width: number;
  height: number;
}

/** Three bytes per pixel, whatever the JPEG happened to carry. */
async function decodeTile(buffer: Buffer): Promise<TileImage | null> {
  try {
    const { data, info } = await sharp(buffer)
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || info.width === 0 || info.height === 0) return null;
    return { data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

async function readCachedTile(file: string): Promise<Buffer | null> {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export interface TileRequest {
  order: number;
  tiles: readonly number[];
  fetchImpl?: typeof fetch;
  /** Milliseconds for the whole set, not per tile. */
  budgetMs?: number;
  /** Requests in flight at once. The host is a public archive, so this stays low. */
  concurrency?: number;
  /** First host that answers every tile is the one used. */
  sources?: readonly TileSource[];
  cacheRoot?: string;
}

export interface TileSet {
  order: number;
  /** Tile number to decoded raster. Tiles the host did not answer are absent, not null. */
  tiles: Map<number, TileImage>;
  source: string;
}

/**
 * Fetch and decode every tile in `tiles`, trying each host in turn. A host that answers all of them wins; a host
 * that misses any is abandoned, so a cutout is never stitched from two archives.
 *
 * Returns null when no host delivers the whole set inside the budget, which the caller treats as "this source has
 * nothing" and moves on to the next one.
 */
export async function loadTiles(request: TileRequest): Promise<TileSet | null> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const sources = request.sources ?? TILE_SOURCES;
  const cacheRoot = request.cacheRoot ?? path.join(DATA_DIR, 'sky-cache', 'hips-tiles');
  const concurrency = Math.max(1, request.concurrency ?? 6);
  const deadline = Date.now() + (request.budgetMs ?? 20_000);
  const ordered = [...request.tiles];

  for (const [index, source] of sources.entries()) {
    // Each host gets a share of what is left, so a host that accepts the connection and then hangs costs one
    // share rather than the whole budget. Without this, the first host's stall leaves nothing for the other two,
    // which is the most likely shape of a real outage.
    const hostsLeft = sources.length - index;
    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 0) return null;
    const hostDeadline = Date.now() + Math.max(1, Math.floor(remainingBudget / hostsLeft));
    const decoded = new Map<number, TileImage>();
    let failed = false;

    const worker = async (): Promise<void> => {
      for (;;) {
        const tile = ordered.shift();
        if (tile === undefined || failed) return;
        const file = tileCachePath(source, request.order, tile, cacheRoot);
        const cached = await readCachedTile(file);
        if (cached) {
          const image = await decodeTile(cached);
          if (image) { decoded.set(tile, image); continue; }
        }
        const timeLeft = hostDeadline - Date.now();
        if (timeLeft <= 0) { failed = true; return; }
        try {
          const resp = await fetchImpl(tileUrl(source, request.order, tile), { signal: AbortSignal.timeout(timeLeft) });
          if (!resp.ok) { failed = true; return; }
          const buffer = await readCapped(resp, MAX_TILE_BYTES);
          if (!buffer) { failed = true; return; }
          const image = await decodeTile(buffer);
          if (!image) { failed = true; return; }
          // The cache is an optimisation. A full or read-only disk must not cost us a tile we already have.
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, buffer);
          } catch { /* served from memory this time */ }
          decoded.set(tile, image);
        } catch {
          failed = true;
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, ordered.length) }, worker));
    if (!failed && decoded.size === request.tiles.length) {
      return { order: request.order, tiles: decoded, source: source.name };
    }
    // A partial answer is discarded: the next host starts from the full list again.
    ordered.splice(0, ordered.length, ...request.tiles);
  }

  return null;
}
