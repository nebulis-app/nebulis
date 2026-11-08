/**
 * Backup sources for sky images, used while CDS (the DSS2 color source) cannot be reached.
 *
 * CDS in Strasbourg is the only host that serves the whole sky as one color picture, and it has outages. When it
 * fails several times in a row a circuit breaker opens for a while, and sky images come from the SDSS and Legacy
 * Survey cutout services instead. Both are color, but they cover only part of the sky, so NASA's SkyView — which
 * serves the three DSS2 bands for the whole sky — is next, composed into one color picture here. Where DSS2 has no blue
 * plate (parts of the Milky Way) SkyView cannot make a color picture, and Pan-STARRS, which covers the sky north of
 * about -30 degrees including the Galactic plane, is the last resort. All of
 * them look different from the CDS image, so a backup image is marked as one and replaced by the CDS image once CDS
 * answers again.
 *
 * Kept free of `skyImage.ts` imports so it can be tested alone.
 */
import fs from 'fs';
import sharp from 'sharp';
import { analyzeImage, THRESHOLDS } from './catalogPack/imageQuality.js';

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

export const FALLBACK_SOURCES = ['sdss', 'legacy', 'skyview', 'panstarrs'] as const;
export type FallbackSource = (typeof FALLBACK_SOURCES)[number];

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

/**
 * SkyView serves each DSS2 band on its own, so a color picture is three requests
 * composited here. The mapping matches the CDS `DSS2/color` HiPS: near-infrared
 * to red, red to green, blue to blue.
 *
 * Each band is stretched against its own 25th-percentile background but scaled
 * to one shared maximum, so the sky background goes neutral without flattening
 * the colour differences between the bands. Stretching each band to its own full
 * range instead tints every picture (an HII region comes out uniformly green).
 */
const SKYVIEW_URL = 'https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl';
const SKYVIEW_BANDS = ['IR', 'Red', 'Blue'] as const;
/** SkyView runs a small pool of CGI processes and answers the overflow with an
 *  HTML "Too Many Processes" page (HTTP 200). The pool is shared, so a request
 *  can be turned away even when this process is polite: retry with backoff.
 *  Exported so the tests can run the same paths without the real waits. */
export const skyViewTiming = {
  /** A gap between the three band requests, so a build never fills the pool itself. */
  gapMs: 750,
  retryDelays: [1500, 4000, 8000] as readonly number[],
};

let skyViewGate: Promise<unknown> = Promise.resolve();
function inSkyViewSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = skyViewGate.then(task, task);
  skyViewGate = run.then(() => {}, () => {});
  return run;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function skyViewUrl(band: (typeof SKYVIEW_BANDS)[number], r: FallbackRequest): string {
  return `${SKYVIEW_URL}?Survey=DSS2+${band}&position=${r.ra},${r.dec}&size=${r.fovDeg}`
    + `&Pixels=${r.width},${r.height}&return=JPEG`;
}

function histogram(data: Uint8Array): Uint32Array {
  const counts = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) counts[data[i]]++;
  return counts;
}

function percentile(counts: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += counts[value];
    if (seen >= target) return value;
  }
  return 255;
}

async function composeDss2Color(bands: Buffer[], width: number, height: number): Promise<Buffer | null> {
  const raws = await Promise.all(bands.map(band =>
    sharp(band, { limitInputPixels: LIMIT_INPUT_PIXELS }).greyscale().raw().toBuffer({ resolveWithObject: true })));
  // SkyView answers a position it has no plate for with a small "no data" card
  // rather than the size asked for.
  if (raws.some(raw => raw.info.width !== width || raw.info.height !== height)) return null;

  const total = width * height;
  const counts = raws.map(raw => histogram(raw.data));
  const backgrounds = counts.map(c => percentile(c, total, 0.25));
  const highs = counts.map(c => percentile(c, total, 0.995));
  const commonHigh = Math.max(...highs);
  // A flat band is the placeholder card (or an empty patch), not sky.
  if (highs.some((high, i) => high - backgrounds[i] < 3)) return null;

  const out = Buffer.alloc(total * 3);
  for (let channel = 0; channel < 3; channel++) {
    const { data } = raws[channel];
    const low = backgrounds[channel];
    const span = Math.max(1, commonHigh - low);
    for (let i = 0; i < total; i++) {
      out[i * 3 + channel] = Math.max(0, Math.min(255, Math.round(((data[i] - low) / span) * 255)));
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** DSS2 from SkyView: all-sky, so it catches the positions SDSS and Legacy do not cover. */
async function fetchSkyView(r: FallbackRequest): Promise<Buffer | null> {
  const timeoutMs = Math.min(r.timeoutMs ?? 20000, 15000);
  const bands: Buffer[] = [];
  for (const [index, band] of SKYVIEW_BANDS.entries()) {
    if (index > 0) await sleep(skyViewTiming.gapMs);
    const picture = await inSkyViewSlot(async () => {
      for (let attempt = 0; attempt <= skyViewTiming.retryDelays.length; attempt++) {
        const resp = await fetch(skyViewUrl(band, r), { signal: AbortSignal.timeout(timeoutMs) });
        if (!resp.ok) return null;
        const type = resp.headers.get('content-type') ?? '';
        if (type.startsWith('image/')) return Buffer.from(await resp.arrayBuffer());
        // Not a picture: the process pool was full. Back off and try again.
        if (attempt < skyViewTiming.retryDelays.length) await sleep(skyViewTiming.retryDelays[attempt]);
      }
      return null;
    });
    if (!picture) return null;
    bands.push(picture);
  }
  return composeDss2Color(bands, r.width, r.height);
}


/**
 * Pan-STARRS1 3pi color (z, r, g as red, green, blue) from the STScI cutout service. It reaches the Galactic plane
 * where DSS2 has no blue plate, but only north of about -30 degrees. A cutout is cut from one survey tile, so a field
 * that crosses a tile edge comes back with a flat strip along it: ask again for a tighter field until it is whole.
 */
const PS1_FILENAMES_URL = 'https://ps1images.stsci.edu/cgi-bin/ps1filenames.py';
const PS1_CUTOUT_URL = 'https://ps1images.stsci.edu/cgi-bin/fitscut.cgi';
const PS1_ARCSEC_PER_PIXEL = 0.25;
const PS1_MIN_DEC = -30;
const PS1_MAX_CUTOUT_PIXELS = 6000;
/** Fractions of the wanted field tried in turn; the first whole picture wins. */
const PS1_FIELD_STEPS = [1, 0.6, 0.35, 0.15] as const;
/** The tightest step shows about 3 arcminutes, so it is only for a small object: the catalog's smallest field is
 *  0.3 degrees, and anything wider would have the object cropped. A tile corner can leave a target with no clean
 *  field wider than that (Abell 44 has about 3 arcminutes). */
const PS1_TIGHT_STEP = 0.15;
const PS1_TIGHT_STEP_MAX_FOV_DEG = 0.31;

/** The stack file for each of g, r and z at a position, from the service's table of skycells; null when any is missing. */
async function ps1StackFiles(r: FallbackRequest, signal: AbortSignal): Promise<{ g: string; r: string; z: string } | null> {
  const resp = await fetch(`${PS1_FILENAMES_URL}?ra=${r.ra}&dec=${r.dec}&filters=grz`, { signal });
  if (!resp.ok) return null;
  const files: Record<string, string> = {};
  for (const line of (await resp.text()).split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    // projcell subcell ra dec filter mjd type filename shortname badflag
    if (cols.length >= 8 && cols[6] === 'stack' && ['g', 'r', 'z'].includes(cols[4])) files[cols[4]] ??= cols[7];
  }
  return files.g && files.r && files.z ? { g: files.g, r: files.r, z: files.z } : null;
}

async function fetchPanstarrs(r: FallbackRequest): Promise<Buffer | null> {
  if (r.dec < PS1_MIN_DEC) return null;
  const signal = AbortSignal.timeout(Math.min(r.timeoutMs ?? 30000, 30000));
  const files = await ps1StackFiles(r, signal);
  if (!files) return null;

  const side = Math.max(r.width, r.height);
  // Pixels across the longer side for the full field, at the survey's own scale.
  const fullPixels = Math.min(PS1_MAX_CUTOUT_PIXELS, Math.round(((r.fovDeg * 3600) / PS1_ARCSEC_PER_PIXEL) * (side / r.width)));
  for (const step of PS1_FIELD_STEPS) {
    if (step === PS1_TIGHT_STEP && r.fovDeg > PS1_TIGHT_STEP_MAX_FOV_DEG) continue;
    const size = Math.max(64, Math.round(fullPixels * step));
    const url = `${PS1_CUTOUT_URL}?red=${files.z}&green=${files.r}&blue=${files.g}&x=${r.ra}&y=${r.dec}`
      + `&size=${size}&wcs=1&asinh=True&autoscale=99.5&format=jpg&output_size=${side}`;
    const resp = await fetch(url, { signal });
    if (!resp.ok || !(resp.headers.get('content-type') ?? '').startsWith('image/')) return null;
    const square = Buffer.from(await resp.arrayBuffer());
    if (!(await hasPicture(square))) return null;
    if (await hasNoDataHole(square)) continue;
    return sharp(square, { limitInputPixels: LIMIT_INPUT_PIXELS })
      .resize(side, side, { fit: 'fill' })
      .extract({ left: Math.floor((side - r.width) / 2), top: Math.floor((side - r.height) / 2), width: r.width, height: r.height })
      .jpeg({ quality: 90 })
      .toBuffer();
  }
  return null;
}

/** Tried in this order: SDSS matches the framing of the CDS image exactly and has the cleaner look. */
const SOURCES: { source: FallbackSource; fetch: (r: FallbackRequest) => Promise<Buffer | null> }[] = [
  { source: 'sdss', fetch: fetchSdss },
  { source: 'legacy', fetch: fetchLegacy },
  { source: 'skyview', fetch: fetchSkyView },
  { source: 'panstarrs', fetch: fetchPanstarrs },
];

/**
 * True when part of the picture is a solid block with no data. SDSS and Legacy Survey answer 200 for a position
 * that only partly overlaps their survey stripes, with the rest of the cutout black. That has variation, so
 * `hasPicture` accepts it, and the all-sky SkyView source behind it was never asked.
 */
async function hasNoDataHole(buffer: Buffer): Promise<boolean> {
  try {
    return (await analyzeImage(buffer)).blackEdgeShare >= THRESHOLDS.notchShare;
  } catch {
    return false;
  }
}

/**
 * The first backup source that has a whole picture for this position. A picture with a no-data hole does not count
 * as an answer while another source is left to try; it is kept and returned only when no source does better.
 * Null when none has a picture at all (outside every footprint, or offline).
 */
export async function fetchFallbackSkyImage(r: FallbackRequest): Promise<FallbackImage | null> {
  let partial: FallbackImage | null = null;
  for (const { source, fetch: get } of SOURCES) {
    try {
      const buffer = await get(r);
      if (!buffer) continue;
      if (await hasNoDataHole(buffer)) {
        partial ??= { buffer, source };
        continue;
      }
      return { buffer, source };
    } catch (err) {
      console.warn('[skyImage] %s backup fetch error:', source, err instanceof Error ? err.message : err);
    }
  }
  return partial;
}

// ─── Marking a backup image ──────────────────────────────────────────────

function markerPath(imagePath: string): string {
  return `${imagePath}.fallback`;
}

/** Records that the image at `imagePath` came from a backup source, so the CDS image can replace it later. */
export function markFallbackImage(imagePath: string, source: FallbackSource): void {
  try { fs.writeFileSync(markerPath(imagePath), source); } catch { /* the image is still usable without the mark */ }
}

/** Which backup source made the image at `imagePath`, or null when it is not a backup picture. */
export function fallbackSourceOf(imagePath: string): FallbackSource | null {
  try {
    const text = fs.readFileSync(markerPath(imagePath), 'utf-8').trim();
    return FALLBACK_SOURCES.find(source => source === text) ?? null;
  } catch {
    return null;
  }
}

export function isFallbackImage(imagePath: string): boolean {
  try { return fs.statSync(markerPath(imagePath)).isFile(); } catch { return false; }
}

export function clearFallbackMark(imagePath: string): void {
  try { fs.unlinkSync(markerPath(imagePath)); } catch { /* not marked */ }
}
