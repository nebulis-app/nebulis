/**
 * Backup sources for sky images, used while CDS (the DSS2 color source) cannot be reached.
 *
 * CDS in Strasbourg is the only host that serves the whole sky as one color picture, and it has outages. When it
 * fails several times in a row a circuit breaker opens for a while, and sky images come from the SDSS and Legacy
 * Survey cutout services instead. Both are color, but they cover only part of the sky (an object outside both gets
 * no backup image) and look different from DSS2, so a backup image is marked as one and replaced by the CDS image
 * once CDS answers again.
 *
 * Kept free of `skyImage.ts` imports so it can be tested alone.
 */
import fs from 'fs';
import sharp from 'sharp';

// ─── Circuit breaker for CDS ─────────────────────────────────────────────

/** Consecutive CDS network failures (every host unreachable, or a 5xx) before it is skipped. */
export const CDS_FAILURE_THRESHOLD = 3;
/** How long CDS is skipped once the breaker opens. After that one request tries it again. */
export const CDS_COOLDOWN_MS = 10 * 60 * 1000;

let consecutiveFailures = 0;
let skipUntil = 0;

/** True while CDS is being skipped. After the cooldown it is false again, and a failure on that one retry reopens it. */
export function cdsIsSkipped(now = Date.now()): boolean {
  return consecutiveFailures >= CDS_FAILURE_THRESHOLD && now < skipUntil;
}

export function recordCdsSuccess(): void {
  consecutiveFailures = 0;
  skipUntil = 0;
}

export function recordCdsFailure(now = Date.now()): void {
  consecutiveFailures++;
  if (consecutiveFailures >= CDS_FAILURE_THRESHOLD) skipUntil = now + CDS_COOLDOWN_MS;
}

/** For tests. */
export function resetCdsBreaker(): void {
  consecutiveFailures = 0;
  skipUntil = 0;
}

// ─── Backup sources ──────────────────────────────────────────────────────

export type FallbackSource = 'sdss' | 'legacy';

export interface FallbackImage {
  buffer: Buffer;
  source: FallbackSource;
}

export interface FallbackRequest {
  /** Decimal degrees. */
  ra: number;
  dec: number;
  /** Width of the field in degrees. */
  fovDeg: number;
  width: number;
  height: number;
  /** Deadline for each source. */
  timeoutMs?: number;
}

const SDSS_URL = 'https://skyserver.sdss.org/dr18/SkyServerWS/ImgCutout/getjpeg';
const LEGACY_URL = 'https://www.legacysurvey.org/viewer/cutout.jpg';
const LIMIT_INPUT_PIXELS = 20_000_000;

/**
 * A picture with no variation at all is a "no data" tile, not the sky: Legacy Survey answers 200 with a flat gray
 * square for a position outside its footprint.
 */
async function hasPicture(buffer: Buffer): Promise<boolean> {
  try {
    const { channels } = await sharp(buffer, { limitInputPixels: LIMIT_INPUT_PIXELS }).stats();
    return channels.some(c => c.stdev >= 1);
  } catch {
    return false;
  }
}

/** SDSS answers 404 outside its footprint, and the picture is the size and field asked for. */
async function fetchSdss(r: FallbackRequest): Promise<Buffer | null> {
  const scale = (r.fovDeg * 3600) / r.width;
  const url = `${SDSS_URL}?ra=${r.ra}&dec=${r.dec}&scale=${scale}&width=${r.width}&height=${r.height}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(r.timeoutMs ?? 20000) });
  if (!resp.ok) return null;
  const buffer = Buffer.from(await resp.arrayBuffer());
  return (await hasPicture(buffer)) ? buffer : null;
}

/** Legacy Survey only makes square cutouts, so ask for the longer side and cut the middle out to the size wanted. */
async function fetchLegacy(r: FallbackRequest): Promise<Buffer | null> {
  const size = Math.max(r.width, r.height);
  const scale = (r.fovDeg * 3600) / r.width;
  const url = `${LEGACY_URL}?ra=${r.ra}&dec=${r.dec}&layer=ls-dr10&pixscale=${scale}&size=${size}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(r.timeoutMs ?? 20000) });
  if (!resp.ok) return null;
  const square = Buffer.from(await resp.arrayBuffer());
  if (!(await hasPicture(square))) return null;
  return sharp(square, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .extract({ left: Math.floor((size - r.width) / 2), top: Math.floor((size - r.height) / 2), width: r.width, height: r.height })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Tried in this order: SDSS matches the framing of the CDS image exactly and has the cleaner look. */
const SOURCES: { source: FallbackSource; fetch: (r: FallbackRequest) => Promise<Buffer | null> }[] = [
  { source: 'sdss', fetch: fetchSdss },
  { source: 'legacy', fetch: fetchLegacy },
];

/** The first backup source that has a picture for this position, or null when none does (outside both footprints, or offline). */
export async function fetchFallbackSkyImage(r: FallbackRequest): Promise<FallbackImage | null> {
  for (const { source, fetch: get } of SOURCES) {
    try {
      const buffer = await get(r);
      if (buffer) return { buffer, source };
    } catch (err) {
      console.warn('[skyImage] %s backup fetch error:', source, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

// ─── Marking a backup image ──────────────────────────────────────────────

function markerPath(imagePath: string): string {
  return `${imagePath}.fallback`;
}

/** Records that the image at `imagePath` came from a backup source, so the CDS image can replace it later. */
export function markFallbackImage(imagePath: string, source: FallbackSource): void {
  try { fs.writeFileSync(markerPath(imagePath), source); } catch { /* the image is still usable without the mark */ }
}

export function isFallbackImage(imagePath: string): boolean {
  try { return fs.statSync(markerPath(imagePath)).isFile(); } catch { return false; }
}

export function clearFallbackMark(imagePath: string): void {
  try { fs.unlinkSync(markerPath(imagePath)); } catch { /* not marked */ }
}
