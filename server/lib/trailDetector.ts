import { assertNever } from './typeGuards.js';

/**
 * True median of a pre-sorted typed array. Returns the average of the two
 * middle values for even-length arrays — `arr[len >> 1]` alone picks the
 * upper middle, which biases sigma estimates upward on small samples.
 */
function trueMedian(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Detector thresholds ─────────────────────────────────────────────
// Documented in docs/trail-detection.md (Thresholds table).
// These values are wired into validateTrail's filter chain and exported so
// trailDetector.test.ts can assert them, turning any change here into a test
// failure that forces a deliberate docs update + re-test on real frames.
// Reasoning behind each value is in the table in docs/trail-detection.md —
// do not edit without consulting it.

/** Hard reject if the perpendicular FWHM of the trail exceeds this. */
export const FWHM_HARD_REJECT_PX = 12;
/** Trail span (gap-tolerant) must be at least this fraction of the diagonal. */
export const MIN_LENGTH_FRACTION_OF_DIAGONAL = 0.10;
/** Of the gap-tolerant span, at least this fraction of bins must be above threshold. */
export const FILL_FRACTION_MIN = 0.40;
/** Longest UNBRIDGED above-threshold run must be at least this fraction of diagonal. */
export const CONTIGUOUS_RUN_FRACTION_OF_DIAGONAL = 0.03;
/** Gap tolerance for bridging star-masked holes inside a trail. */
export const GAP_TOLERANCE_FRACTION_OF_DIAGONAL = 0.06;
/** Reject detections scoring below this confidence. Floor-level detections
 *  (≤0.1) are artifact-class in practice: moon limbs, mosaic border edges.
 *  Real trails score 0.3+ (length and thinness both contribute). */
export const MIN_CONFIDENCE = 0.15;

// ─── Star-mask shape thresholds ──────────────────────────────────────
// `linearity` in createStarMask is pixelCount / bboxDiagonal, which for an
// elongated feature reads out as its WIDTH in pixels. These two constants are
// therefore both measured in working-image pixels.

/** A connected component whose bbox diagonal reaches this fraction of the
 *  image diagonal is never masked: it is already long enough to be the trail
 *  we are looking for, so no shape test may reclassify it as a star. Set to
 *  half MIN_LENGTH_FRACTION_OF_DIAGONAL so a trail broken in two by a star
 *  crossing still protects both halves. */
export const LONG_COMPONENT_FRACTION = MIN_LENGTH_FRACTION_OF_DIAGONAL / 2;

/** Widest an elongated component may be and still be spared as a trail.
 *  Satellite trails run 1–8 px across in the working image depending on plate
 *  scale and how bright the pass was; a round star of this width has a bbox
 *  diagonal far below the 20 px length floor the same test applies. */
export const LINEARITY_MAX_WIDTH_PX = 10;

/**
 * Minimum major/minor axis ratio (via PCA on the component's pixel
 * coordinates) for a component to be spared as a trail candidate.
 *
 * `linearity = pixelCount / bboxDiagonal` was meant to read out as WIDTH, but
 * it is really `pixelCount / bboxDiagonal`, which a big enough ROUND blob
 * satisfies just as easily as a thin elongated one — a filled disk of radius
 * r has linearity ≈ 1.1·r, so any star whose bbox diagonal happens to clear
 * the 20px floor (a moderately bright, moderately large star in the working
 * image — nothing exotic) sails through the `linearity <= 10` gate despite
 * being perfectly round. Confirmed on a real frame: a saturated star with
 * bbox 15×14, elongation 1.06 (i.e., a near-perfect circle), was left
 * unmasked and its halo/wing structure was picked up by the projection
 * search as a 27%-confidence "trail" with an endpoint 12px from the star's
 * center. `linearity` cannot tell "big and round" from "long and thin"; true
 * elongation can, at any size. A trail at the worst plausible corner of the
 * existing gate (LINEARITY_MAX_WIDTH_PX-wide, bbox diagonal right at the 20px
 * floor) still has elongation ≈2.3, so 1.8 clears real trails with margin
 * while rejecting anything within reach of "round."
 */
export const MIN_ELONGATION_RATIO = 1.8;

/** Bounds on the padding added around a masked star, in working pixels. */
export const STAR_PAD_MIN_PX = 2;
export const STAR_PAD_MAX_PX = 8;

/** If the star mask covers more than this fraction of the frame there is no
 *  sky left to search, so the mask is rebuilt at a stricter sigma cut rather
 *  than reporting "no trail" on an image that was simply star-rich. */
export const MAX_MASK_COVERAGE = 0.45;

/**
 * Projection bins holding less than this fraction of the mean geometric pixel
 * count are discarded rather than normalized.
 *
 * The count normalization multiplies each bin by `meanCount / counts[i]`, so a
 * bin fed by a handful of pixels gets its flux — and its noise — amplified by
 * a large factor. That is harmless for the interior of the projection, where
 * every bin sees a full chord across the frame, but the end bins correspond to
 * the image CORNERS and can hold a single pixel. On a square frame at exactly
 * 45°/135° the projection axis lands on the image diagonal, the extreme bins
 * degenerate to one corner pixel each, and the amplified corner outranked the
 * real trail in the perpendicular profile — a hard dead band at those two
 * angles (verified on 1024², 3008² ASI533; rectangular frames were unaffected
 * because no integer angle aligns with their diagonal). A bin this sparse
 * cannot be measured, so it reads as empty instead of as a spike.
 */
export const MIN_BIN_COVERAGE = 0.25;

/**
 * Shortest streak, in degrees on the sky, that is still worth reporting as a
 * trail. Used only to relax MIN_LENGTH_FRACTION_OF_DIAGONAL on wide fields —
 * see the `minLengthFraction` calculation in detect(). A satellite covers
 * ~0.3–1.2°/s, so 0.25° is roughly a quarter-second of motion: short enough
 * that no plausible pass is excluded, long enough that a cosmic-ray hit or a
 * diffraction spike is not mistaken for one.
 */
export const MIN_TRAIL_ANGULAR_DEG = 0.25;

/** Optional per-frame hints. Everything here is derived from the FITS header
 *  by the caller; the detector works without any of it. */
export interface TrailDetectOptions {
  /** Plate scale in degrees per NATIVE pixel (before binning/downsampling).
   *  Supplying it lets the length gate be expressed on the sky instead of as
   *  a fraction of whatever sensor happened to take the picture. */
  degreesPerPixel?: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

/**
 * Detector output, as a discriminated union on `trailDetected`.
 *
 * It used to be one interface with `trailDetected: boolean` and six optional
 * measurement fields, which made two impossible states representable and,
 * worse, made every real measurement `T | undefined` at every call site — so
 * callers wrote `result.lengthPixels != null ? ... : undefined` branches that
 * can never be taken. Splitting the two outcomes means a `trailDetected` check
 * *proves* the measurements are present, and forgetting the check is a compile
 * error instead of a silent `undefined`.
 */
export interface NoTrailDetected {
  trailDetected: false;
}

export interface TrailDetected {
  trailDetected: true;
  angleDegrees: number;
  lengthPixels: number;
  midpoint: ImagePoint;
  endpoints: [ImagePoint, ImagePoint];
  confidence: number;
  /** FWHM of the trail in pixels. */
  profileWidth: number;
}

export type TrailDetectionResult = NoTrailDetected | TrailDetected;

/**
 * The BITPIX values this parser can decode, as a closed union rather than a
 * bare `number`. FITS also defines BITPIX=64 (64-bit integer); Node reads it
 * as `bigint`, which none of the Float64 pipeline below can consume, so it is
 * deliberately absent and rejected at the guard instead of falling into a
 * `default:` branch further downstream.
 */
export const SUPPORTED_BITPIX = [8, 16, 32, -32, -64] as const;
export type FitsBitpix = typeof SUPPORTED_BITPIX[number];

/** Narrows a parsed BITPIX header value to one this detector can decode. */
export function isFitsBitpix(value: number): value is FitsBitpix {
  return (SUPPORTED_BITPIX as readonly number[]).includes(value);
}

/**
 * Bytes each BITPIX consumes in the data unit. Exhaustive by construction:
 * add a value to SUPPORTED_BITPIX and this stops compiling until the size is
 * declared, which is what keeps the truncation check below honest.
 */
function bytesPerPixel(bitpix: FitsBitpix): number {
  switch (bitpix) {
    case 8:   return 1;
    case 16:  return 2;
    case 32:  return 4;
    case -32: return 4;
    case -64: return 8;
    default:  return assertNever(bitpix, 'No pixel size declared for BITPIX');
  }
}

export const CFA_PATTERNS = ['RGGB', 'BGGR', 'GRBG', 'GBRG'] as const;
export type BayerPattern = typeof CFA_PATTERNS[number];

/** Narrows a raw BAYERPAT header string to a known CFA layout. */
export function isBayerPattern(value: string): value is BayerPattern {
  return (CFA_PATTERNS as readonly string[]).includes(value);
}

export interface FitsImageData {
  width: number;
  height: number;
  pixels: Float64Array | Float32Array | Int32Array | Int16Array | Uint8Array;
  bitpix: FitsBitpix;
  /** Bayer pattern (e.g. 'GRBG') when the frame is an un-debayered CFA mosaic. */
  bayerPattern: BayerPattern | null;
}

/**
 * FITS header values are free text in a fixed-width field, so every numeric
 * card can be blank, malformed, or a comment fragment. `parseInt`/`parseFloat`
 * answer NaN for all of those, and a NaN BZERO/BSCALE multiplies through into
 * every pixel — the frame becomes all-NaN and the detector reports "no trail"
 * instead of failing. These return null so the caller can keep the FITS-spec
 * default (BZERO 0, BSCALE 1, NAXIS3 1) that an *absent* card would have used.
 */
function parseHeaderInt(raw: string): number | null {
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHeaderFloat(raw: string): number | null {
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Precomputed per-pixel data for every unmasked pixel in the working image,
 * built once per `detect()` call and shared across the 180-angle search and
 * every candidate's validation pass.
 *
 * Before this, the angle search and each of up to 15 validation passes
 * re-walked the entire W×H grid and re-tested the star mask on every pixel,
 * every time — roughly 195 full-frame passes per file. The star mask alone
 * commonly excludes up to 45% of the frame (MAX_MASK_COVERAGE), and every one
 * of those passes was also redoing the same `x - cx` / `y - cy` subtraction
 * 195 times over. Compacting the surviving pixels into flat arrays once, and
 * having every consumer iterate that instead of the grid, removes both: only
 * real candidate pixels are ever touched, and only once.
 *
 * Built in raster (y-then-x) order — the same order the old grid loops
 * visited pixels in — so every summation below reproduces the exact same
 * floating-point accumulation order. This is a representation change, not a
 * different computation: same pixels, same order, same numbers.
 */
interface UnmaskedPoints {
  /** x - cx for each unmasked pixel. */
  dx: Float64Array;
  /** y - cy for each unmasked pixel. */
  dy: Float64Array;
  /** max(0, residual) — the clamped flux the angle search and the
   *  perpendicular profile use; both only care about positive signal. */
  flux: Float64Array;
  /** Unclamped residual — the line/flank extraction needs the real value,
   *  since averaging clamped-positive noise in a flank would bias it high. */
  raw: Float64Array;
  count: number;
}

/**
 * Satellite trail detector using projection analysis.
 *
 * Instead of edge detection (which picks up nebulosity, noise, star halos),
 * this detector looks for bright, thin, linear features directly:
 *
 * 1. Background subtraction using tiled median to remove nebulosity/gradients
 * 2. Star masking using morphological compactness (stars are round, trails are not)
 * 3. Angle search via Radon-like projection — project the cleaned image onto
 *    the perpendicular axis for each angle. A satellite trail creates a narrow
 *    spike in the projection at the correct angle.
 * 4. Trail validation:
 *    - Perpendicular profile must be narrow (FWHM < 12 pixels hard reject;
 *      < 8 pixels for full confidence score — wider trails score 0 on thinness)
 *    - Must be significantly brighter than surroundings (> 5σ)
 *    - Must span > 10% of the image diagonal
 *    - Brightness along the trail must be reasonably consistent
 */
class TrailDetector {
  // ─── FITS Parsing ──────────────────────────────────────────────────

  parseFitsPixels(buffer: Buffer): FitsImageData {
    let width = 0, height = 0, naxis3 = 1, bitpixRaw = 0, bzero = 0, bscale = 1, headerEnd = 0;
    let bayerRaw = '';

    let foundEnd = false;
    for (let block = 0; !foundEnd; block++) {
      const blockStart = block * 2880;
      if (blockStart >= buffer.length) throw new Error('FITS header END not found');

      for (let record = 0; record < 36; record++) {
        const offset = blockStart + record * 80;
        if (offset + 80 > buffer.length) break;
        const line = buffer.subarray(offset, offset + 80).toString('ascii');
        const kw = line.substring(0, 8).trim();

        if (kw === 'END') { foundEnd = true; headerEnd = (block + 1) * 2880; break; }
        if (line[8] === '=' && line[9] === ' ') {
          const v = line.substring(10, 30).trim();
          // `?? <current>` keeps the spec default when a card is unparseable
          // (see parseHeaderInt) instead of latching NaN into the pipeline.
          switch (kw) {
            case 'NAXIS1': width = parseHeaderInt(v) ?? width; break;
            case 'NAXIS2': height = parseHeaderInt(v) ?? height; break;
            case 'NAXIS3': naxis3 = parseHeaderInt(v) ?? naxis3; break;
            case 'BITPIX': bitpixRaw = parseHeaderInt(v) ?? bitpixRaw; break;
            case 'BZERO':  bzero = parseHeaderFloat(v) ?? bzero; break;
            case 'BSCALE': bscale = parseHeaderFloat(v) ?? bscale; break;
            case 'BAYERPAT': bayerRaw = v.replace(/'/g, '').trim().toUpperCase(); break;
          }
        }
      }
    }

    // BAYERPAT only means "un-debayered mosaic" for 2-D data. RGB cubes
    // (NAXIS3=3, stacked files) carry the keyword too but are already
    // demosaiced — we read their first plane, which has no CFA periodicity.
    const bayerPattern = naxis3 <= 1 && isBayerPattern(bayerRaw) ? bayerRaw : null;

    if (!width || !height || !bitpixRaw) throw new Error(`Invalid FITS: ${width}x${height} bitpix=${bitpixRaw}`);
    // Narrow once, here, so the decode switch below is exhaustive over a
    // closed union instead of guessing at an open `number`.
    if (!isFitsBitpix(bitpixRaw)) throw new Error(`Unsupported BITPIX: ${bitpixRaw}`);
    const bitpix: FitsBitpix = bitpixRaw;

    const n = width * height;
    const d = buffer.subarray(headerEnd);

    // Reading past the end of a Buffer is not an error in every path: the
    // `d[i]` byte reads below answer `undefined`, which becomes 0 in a
    // Uint8Array and NaN in a Float64Array. A truncated file would therefore
    // decode into a plausible-looking image rather than failing. Check the
    // data unit is actually there before decoding a single pixel.
    const expectedBytes = n * bytesPerPixel(bitpix);
    if (d.length < expectedBytes) {
      throw new Error(`Invalid FITS: pixel data truncated (${d.length} of ${expectedBytes} bytes)`);
    }

    let pixels: FitsImageData['pixels'];

    switch (bitpix) {
      case 8: {
        // BITPIX=8 with non-trivial BSCALE/BZERO would overflow a Uint8Array
        // (negative values, fractions, or values > 255). Promote to Float64
        // when scaling is in play; keep the cheap Uint8 path otherwise.
        if (bscale === 1 && bzero === 0) {
          const u8 = new Uint8Array(n);
          for (let i = 0; i < n; i++) u8[i] = d[i];
          pixels = u8;
        } else {
          const f64 = new Float64Array(n);
          for (let i = 0; i < n; i++) f64[i] = d[i] * bscale + bzero;
          pixels = f64;
        }
        break;
      }
      case 16:  { pixels = new Float64Array(n);  for (let i = 0; i < n; i++) pixels[i] = d.readInt16BE(i * 2) * bscale + bzero; break; }
      case 32:  { pixels = new Float64Array(n);  for (let i = 0; i < n; i++) pixels[i] = d.readInt32BE(i * 4) * bscale + bzero; break; }
      case -32: { pixels = new Float32Array(n);  for (let i = 0; i < n; i++) pixels[i] = d.readFloatBE(i * 4) * bscale + bzero; break; }
      case -64: { pixels = new Float64Array(n);  for (let i = 0; i < n; i++) pixels[i] = d.readDoubleBE(i * 8) * bscale + bzero; break; }
      // Exhaustive: `bitpix` is `never` here. Widen SUPPORTED_BITPIX without
      // adding a decode branch and this line stops compiling.
      default: return assertNever(bitpix, 'No decoder for BITPIX');
    }
    return { width, height, pixels, bitpix, bayerPattern };
  }

  /**
   * Clip isolated single-pixel spikes (hot pixels) in a raw CFA mosaic.
   *
   * Uncooled sensors litter 20s sub-frames with thousands of hot pixels. They
   * survive background subtraction (they ARE small-scale signal) and are too
   * small to star-mask, so they pile into the validation line profile and
   * inflate fill fractions along arbitrary lines — one of the two drivers of
   * the M16 false positives.
   *
   * CFA-aware: a pixel is compared to the median of its 4 same-color
   * neighbors (2 px away in x/y). A hot pixel towers over all of them; a real
   * trail 2+ px wide has bright same-color neighbors along the trail, so its
   * pixels are never clipped. Replacement value is the neighbor median.
   */
  private despeckleCfa(pixels: FitsImageData['pixels'], w: number, h: number): Float64Array {
    const out = new Float64Array(w * h);
    // Robust global sigma from a sparse sample for the spike threshold.
    const sampleStep = 7;
    const sample: number[] = [];
    for (let i = 0; i < pixels.length; i += sampleStep) sample.push(pixels[i]);
    sample.sort((a, b) => a - b);
    // Indexing an empty array yields undefined, and `undefined - x` is NaN,
    // which would make every spike comparison below false-but-silent. An empty
    // sample means an empty frame; 0 keeps the arithmetic defined.
    const med = sample.length > 0 ? sample[sample.length >> 1] : 0;
    const devs = sample.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    const sigma = (devs[devs.length >> 1] || 1) * 1.4826;
    const spikeMargin = 4 * sigma;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = pixels[i];
        const n1 = x >= 2 ? pixels[i - 2] : v;
        const n2 = x < w - 2 ? pixels[i + 2] : v;
        const n3 = y >= 2 ? pixels[i - 2 * w] : v;
        const n4 = y < h - 2 ? pixels[i + 2 * w] : v;
        // Median of 4 = mean of the two middle values.
        const lo1 = Math.min(n1, n2), hi1 = Math.max(n1, n2);
        const lo2 = Math.min(n3, n4), hi2 = Math.max(n3, n4);
        const m4 = (Math.max(lo1, lo2) + Math.min(hi1, hi2)) / 2;
        out[i] = v - m4 > spikeMargin ? m4 : v;
      }
    }
    return out;
  }

  /**
   * Collapse each 2x2 CFA block to its mean, producing a half-resolution
   * luminance image with no Bayer periodicity.
   *
   * Why this matters: box-filtering a raw mosaic at a fractional ratio (e.g.
   * 1080→288 is 3.75x) aliases the 2-pixel CFA period into diagonal moiré
   * stripes at exactly 45°/135° — the box's R:G:B mix drifts in phase equally
   * in x and y. Over a bright red emission nebula (R >> G) the stripes are
   * strong, thin, and perfectly straight: they validated as 135° "trails" with
   * ~0.5 confidence on M16 LP sub-frames. Block-aligned 2x2 binning has zero
   * phase drift, so the moiré never forms; trail S/N at the final 512-px
   * working scale is unchanged (the same pixel area is averaged either way).
   */
  private binCfa2x2(pixels: FitsImageData['pixels'], w: number, h: number): { pixels: Float64Array; w: number; h: number } {
    const w2 = Math.floor(w / 2);
    const h2 = Math.floor(h / 2);
    const out = new Float64Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const r0 = (y * 2) * w;
      const r1 = (y * 2 + 1) * w;
      for (let x = 0; x < w2; x++) {
        const x0 = x * 2;
        out[y * w2 + x] = (pixels[r0 + x0] + pixels[r0 + x0 + 1] + pixels[r1 + x0] + pixels[r1 + x0 + 1]) / 4;
      }
    }
    return { pixels: out, w: w2, h: h2 };
  }

  // ─── Image Statistics ──────────────────────────────────────────────

  /** Robust sigma-clipped statistics. */
  private stats(data: Float64Array): { median: number; sigma: number } {
    const sorted = Float64Array.from(data).sort();
    const median = trueMedian(sorted);

    // Median absolute deviation → σ estimate (robust to outliers)
    const absDevs = Float64Array.from(data, v => Math.abs(v - median)).sort();
    const mad = trueMedian(absDevs);
    const sigma = mad * 1.4826; // MAD to σ conversion factor

    return { median, sigma };
  }

  // ─── Background Subtraction ────────────────────────────────────────

  /**
   * Subtract a tiled median background to remove nebulosity, gradients,
   * and large-scale structure. Returns a residual image where only
   * small-scale features (stars, trails) remain.
   */
  private subtractBackground(pixels: FitsImageData['pixels'], w: number, h: number): Float64Array {
    const tileSize = 64;
    const tilesX = Math.ceil(w / tileSize);
    const tilesY = Math.ceil(h / tileSize);

    // Compute median for each tile
    const tileMedians = new Float64Array(tilesX * tilesY);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const vals: number[] = [];
        const y0 = ty * tileSize, y1 = Math.min(y0 + tileSize, h);
        const x0 = tx * tileSize, x1 = Math.min(x0 + tileSize, w);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++)
            vals.push(pixels[y * w + x]);
        vals.sort((a, b) => a - b);
        tileMedians[ty * tilesX + tx] = vals[vals.length >> 1];
      }
    }

    // Bilinear interpolation of tile medians to full resolution, then subtract
    const result = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Tile center coordinates
        const ftx = (x + 0.5) / tileSize - 0.5;
        const fty = (y + 0.5) / tileSize - 0.5;
        const tx0 = Math.max(0, Math.floor(ftx));
        const ty0 = Math.max(0, Math.floor(fty));
        const tx1 = Math.min(tilesX - 1, tx0 + 1);
        const ty1 = Math.min(tilesY - 1, ty0 + 1);
        const fx = ftx - tx0;
        const fy = fty - ty0;

        const bg =
          tileMedians[ty0 * tilesX + tx0] * (1 - fx) * (1 - fy) +
          tileMedians[ty0 * tilesX + tx1] * fx * (1 - fy) +
          tileMedians[ty1 * tilesX + tx0] * (1 - fx) * fy +
          tileMedians[ty1 * tilesX + tx1] * fx * fy;

        result[y * w + x] = pixels[y * w + x] - bg;
      }
    }
    return result;
  }

  // ─── Star Masking ──────────────────────────────────────────────────

  /**
   * Create a mask of compact bright sources (stars), leaving linear bright
   * features (satellite trails) untouched.
   *
   * The previous implementation masked every >5σ pixel and dilated each one
   * by a brightness-proportional radius. That erased the trail along with
   * the stars — the trail is also bright, so its pixels triggered dilation
   * and got swallowed by the mask, leaving nothing for the projection
   * search to find.
   *
   * Now: flood-fill each bright connected component and inspect its shape:
   *   - aspect ratio = longer bbox edge / shorter bbox edge
   *   - fill ratio   = pixel count / bbox area
   * Linear features (high aspect, low fill — typical of trails) are skipped.
   * Compact features (low aspect or high fill — typical of stars) get masked
   * with padding sized to the component's brightness so star halos are
   * covered but trail-adjacent pixels stay available.
   *
   * Two scale-dependence defects fixed here (see docs/trail-detection.md):
   *
   *  - `linearity = pixelCount / bboxDiag` is, for a line, exactly the line's
   *    WIDTH in pixels. The old `linearity <= 2.5` spare-clause therefore only
   *    spared trails ≤2.5 px wide; anything wider fell into the "compact
   *    source" branch and had its bounding box — the whole frame, for a
   *    full-frame diagonal — masked. That deleted the brightest, most obvious
   *    trails (ISS, flares) and got worse the less an image was downsampled.
   *    LONG_COMPONENT_FRACTION below is the hard escape: a component that
   *    already spans a trail's minimum length is a trail candidate whatever
   *    its width, and is never masked.
   *
   *  - padding was `maxIntensity / sigma`, a ratio that grows with the
   *    downsample factor (box-filtering suppresses noise faster than star
   *    peaks). On a 61 MP frame every star saturated the 12 px cap and ate a
   *    ~25×25 working block, masking 76% of the frame where a 1 MP frame of
   *    the same sky masked 1%. Padding is now driven by the component's own
   *    measured radius, with the brightness ratio only as a mild bonus.
   */
  private createStarMask(residual: Float64Array, w: number, h: number, sigma: number, sigmaMultiple = 5): Uint8Array {
    const threshold = sigmaMultiple * sigma;
    const imageDiag = Math.sqrt(w * w + h * h);
    const mask = new Uint8Array(w * h);
    const visited = new Uint8Array(w * h);

    // Pre-allocated stack. Size = w * h is sufficient because we mark pixels
    // visited at PUSH time (not pop time), guaranteeing each pixel enters the
    // stack at most once. The previous code marked at pop time and pushed
    // unconditionally, allowing each pixel to be pushed up to 4× — a large
    // bright component would silently overflow the stack (typed arrays drop
    // out-of-bounds writes with no error), truncating the flood fill and
    // mis-measuring the component's shape.
    const stack = new Int32Array(w * h);

    const pushIfFresh = (idx: number) => {
      if (!visited[idx]) {
        visited[idx] = 1;
        stack[stackTopRef.value++] = idx;
      }
    };
    // Mutable wrapper so the closure can update the outer stackTop counter.
    const stackTopRef = { value: 0 };

    for (let seed = 0; seed < residual.length; seed++) {
      if (visited[seed] || residual[seed] <= threshold) continue;

      // ── Flood-fill the connected component (4-neighbor) ──
      stackTopRef.value = 0;
      visited[seed] = 1;
      stack[stackTopRef.value++] = seed;

      let pixelCount = 0;
      let maxIntensity = 0;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      // Raw sums for a PCA/second-moment shape check (see MIN_ELONGATION_RATIO)
      // — bbox diagonal and pixel count alone can't tell a big round star from
      // a thin elongated trail once the star is large enough.
      let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;

      while (stackTopRef.value > 0) {
        const idx = stack[--stackTopRef.value];
        // visited was set at push time. We may still hit a non-bright pixel
        // that was queued only as a neighbor of a bright one — skip those.
        if (residual[idx] <= threshold) continue;

        pixelCount++;
        if (residual[idx] > maxIntensity) maxIntensity = residual[idx];
        const x = idx % w;
        const y = (idx - x) / w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x; sumY += y;
        sumXX += x * x; sumYY += y * y; sumXY += x * y;

        if (x > 0)     pushIfFresh(idx - 1);
        if (x < w - 1) pushIfFresh(idx + 1);
        if (y > 0)     pushIfFresh(idx - w);
        if (y < h - 1) pushIfFresh(idx + w);
      }

      // Tiny blobs (1–3 px) are noise spikes or hot-pixel clusters. They were
      // previously left unmasked ("not worth masking"), but thousands of them
      // survive background subtraction and pile into the validation line
      // profile — chains of them along a chance diagonal assembled into
      // "trails" on M16 sub-frames. Mask them (no padding). A real trail can
      // never be a 3-px island: it is one long connected component, spared by
      // the linearity check below; a faint continuous trail keeps its
      // sub-threshold flux in the sum-based line profile either way.
      if (pixelCount < 4) {
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            mask[y * w + x] = 1;
          }
        }
        continue;
      }

      const bbW = maxX - minX + 1;
      const bbH = maxY - minY + 1;
      // Escape hatch, checked before any shape reasoning: a component whose
      // bbox diagonal already reaches the minimum length a trail must have is
      // a trail candidate by definition. Width, fill and brightness cannot
      // make it a star. Without this a thick trail is masked as "compact" and
      // takes the whole frame's bounding box with it.
      const bbDiag = Math.sqrt(bbW * bbW + bbH * bbH);
      if (bbDiag >= imageDiag * LONG_COMPONENT_FRACTION) continue;

      // Pixels-per-bbox-diagonal is ~1 for a thin line at any orientation
      // (axis-aligned, diagonal, or anywhere in between) and grows roughly
      // linearly with radius for round compact features. The previous
      // aspect/fill formulation rejected axis-aligned trails (bbox 200×1 has
      // fill = 1.0) and diagonal trails (bbox 200×200 has aspect ≈ 1).
      // Linearity handles both regimes uniformly.
      const diag = bbDiag;
      const linearity = pixelCount / Math.max(diag, 1);

      // Linear iff: pixels track the bbox diagonal closely, the feature is
      // long enough to plausibly be a trail (not a 5-pixel speckle that
      // happens to be thin), AND it is actually elongated.
      //
      // The cap is LINEARITY_MAX_WIDTH_PX, not 2.5, because `linearity` reads
      // out as the feature's width: 2.5 declared every trail wider than 2.5 px
      // a star. A bright satellite trail is routinely 4–8 px across in the
      // working image.
      //
      // linearity/diag alone are NOT enough: `linearity ≈ 1.1·r` for a round
      // source of radius r assumes such a star only reaches the cap (10) at
      // r≈9, by which point diag is supposedly "well under" 20 — but that
      // reasoning was wrong. Confirmed on a real frame: a saturated star with
      // bbox 15×14 (r≈7.25) already has diag=20.5 (at the floor) while its
      // linearity is only 6.82 (nowhere near the cap) — both gates pass for a
      // shape that is, by direct measurement, a near-perfect circle
      // (elongation 1.06). `linearity` cannot distinguish "big and round"
      // from "long and thin"; true elongation can, at any size. Requiring it
      // is what actually enforces "this looks like a trail," which the two
      // size-derived numbers above were only ever a proxy for.
      const meanX = sumX / pixelCount, meanY = sumY / pixelCount;
      const cxx = sumXX / pixelCount - meanX * meanX;
      const cyy = sumYY / pixelCount - meanY * meanY;
      const cxy = sumXY / pixelCount - meanX * meanY;
      const trace = cxx + cyy;
      const disc = Math.sqrt(Math.max(0, (trace / 2) ** 2 - (cxx * cyy - cxy * cxy)));
      const lambdaMajor = trace / 2 + disc;
      const lambdaMinor = Math.max(trace / 2 - disc, 1e-9);
      const elongation = Math.sqrt(lambdaMajor / lambdaMinor);
      if (linearity <= LINEARITY_MAX_WIDTH_PX && diag >= 20 && elongation >= MIN_ELONGATION_RATIO) continue;

      // Compact source — likely a star. Mask the bounding box plus padding
      // sized to the component's own radius so halos and faint diffraction
      // spikes get covered too, without the padding growing just because the
      // frame came off a bigger sensor. `maxIntensity / sigma` alone did
      // exactly that: after a 12× downsample the ratio saturates for every
      // star and each one claimed the 12 px cap.
      const compRadius = Math.max(bbW, bbH) / 2;
      const brightnessBonus = Math.log2(Math.max(2, maxIntensity / Math.max(sigma, 1e-9)));
      const padding = Math.min(
        STAR_PAD_MAX_PX,
        Math.max(STAR_PAD_MIN_PX, Math.round(compRadius + brightnessBonus)),
      );
      const x0 = Math.max(0, minX - padding);
      const x1 = Math.min(w - 1, maxX + padding);
      const y0 = Math.max(0, minY - padding);
      const y1 = Math.min(h - 1, maxY + padding);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          mask[y * w + x] = 1;
        }
      }
    }

    return mask;
  }

  /**
   * Star mask with a coverage guard.
   *
   * A rich star field (wide field, low galactic latitude, or simply a big
   * sensor) can drive the 5σ mask past 95% coverage, at which point there is
   * no unmasked sky left for the projection search and every frame reports
   * "no trail". Escalating the sigma cut leaves the faintest stars in the
   * residual — noise the sum-based profile tolerates — in exchange for
   * keeping the frame searchable at all. Returns the first mask under the
   * coverage ceiling, or the sparsest one tried.
   */
  private buildStarMask(residual: Float64Array, w: number, h: number): Uint8Array {
    // Sigma depends only on `residual`, which is identical across every
    // escalation attempt below. Computing it once here — instead of inside
    // createStarMask, where it was recomputed (2 full sorts) on every one of
    // up to 4 attempts — removes up to 3 redundant full-image sorts per file.
    const { sigma } = this.stats(residual);
    let best: Uint8Array | null = null;
    let bestCoverage = Infinity;
    for (const sigmaMultiple of [5, 8, 12, 20]) {
      const mask = this.createStarMask(residual, w, h, sigma, sigmaMultiple);
      let covered = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) covered++;
      const coverage = covered / mask.length;
      if (coverage < bestCoverage) {
        bestCoverage = coverage;
        best = mask;
      }
      if (coverage <= MAX_MASK_COVERAGE) return mask;
    }
    // Non-null by construction: the loop body runs at least once.
    return best ?? new Uint8Array(w * h);
  }

  /**
   * Compact every unmasked pixel into flat, index-free arrays (see
   * UnmaskedPoints). Built once per detect() call in the same raster
   * (y-then-x) order the grid loops used, so every consumer below reproduces
   * bit-identical floating-point summation order to walking the grid
   * directly — this changes how pixels are iterated, not which pixels or in
   * what order they are summed.
   */
  private collectUnmasked(residual: Float64Array, starMask: Uint8Array, w: number, h: number): UnmaskedPoints {
    const cx = w / 2, cy = h / 2;
    let n = 0;
    for (let i = 0; i < starMask.length; i++) if (!starMask[i]) n++;

    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    const flux = new Float64Array(n);
    const raw = new Float64Array(n);

    let k = 0;
    for (let y = 0; y < h; y++) {
      const dyv = y - cy;
      const rowStart = y * w;
      for (let x = 0; x < w; x++) {
        const idx = rowStart + x;
        if (starMask[idx]) continue;
        const val = residual[idx];
        dx[k] = x - cx;
        dy[k] = dyv;
        flux[k] = val > 0 ? val : 0;
        raw[k] = val;
        k++;
      }
    }

    return { dx, dy, flux, raw, count: n };
  }

  // ─── Projection-Based Trail Search ─────────────────────────────────

  /**
   * Search for satellite trail angles by projecting the image onto the
   * perpendicular axis for each candidate angle, then returning the top-N
   * angles ranked by absolute projection peak height.
   *
   * We rank by raw peak flux (not σ-relative) because the MAD-based sigma
   * of a mostly-zero projection approaches zero regardless of image content,
   * making σ-relative ranking unstable. A bright star halo or the trail
   * itself both dominate the projection — the one that piles up more total
   * flux in a single bin ranks higher.
   *
   * Returning multiple candidates (not just rank-1) is critical: a faint
   * trail may rank 5th or 10th if brighter star halos happen to align more
   * strongly at other angles. validateTrail then filters the halo-driven
   * angles (via fill-fraction and contiguous-run checks) and finds the
   * trail at whichever rank it appears.
   */
  private findTrailAngles(
    unmasked: UnmaskedPoints,
    w: number,
    h: number,
    topN = 15,
  ): Array<{ angle: number; peakStrength: number }> {
    const diagonal = Math.sqrt(w * w + h * h);
    const nBins = Math.ceil(diagonal);
    const { dx, dy, flux: pxFlux, count } = unmasked;

    const candidates: Array<{ angle: number; peakStrength: number }> = [];

    for (let angleDeg = 0; angleDeg < 180; angleDeg++) {
      const theta = angleDeg * Math.PI / 180;
      const perpX = Math.cos(theta);
      const perpY = Math.sin(theta);

      const bins = new Float64Array(nBins);
      // Geometric pixel count per bin (all unmasked pixels, not just positive
      // ones). The pixel lattice projects onto the bin axis at angle-dependent
      // spacings (1/√2 at 45°, exactly 0.5 at 30°, ...), and floor-binning
      // turns that into comb patterns: alternating overfull/empty bins that
      // manufacture thin fake "peaks" at diagonal angles (every M16 false
      // positive was at exactly 45°/135°) and starve bins at other angles.
      // Two defenses: anti-aliased deposit (each pixel's flux splits between
      // its two nearest bins — see depositLinear) and normalization of each
      // bin to the mean geometric count. A real trail's flux is
      // count-independent and survives both.
      const counts = new Float64Array(nBins);

      // Iterates only unmasked pixels (see UnmaskedPoints) instead of the
      // full W×H grid with a per-pixel mask test — same pixels, same order,
      // same math, just without re-walking pixels that can never contribute.
      for (let i = 0; i < count; i++) {
        const proj = dx[i] * perpX + dy[i] * perpY;
        const pos = proj + nBins / 2 - 0.5;
        const b0 = Math.floor(pos);
        const frac = pos - b0;
        const flux = pxFlux[i];
        if (b0 >= 0 && b0 < nBins) {
          counts[b0] += 1 - frac;
          bins[b0] += flux * (1 - frac);
        }
        if (b0 + 1 >= 0 && b0 + 1 < nBins) {
          counts[b0 + 1] += frac;
          bins[b0 + 1] += flux * frac;
        }
      }

      let totalCount = 0, occupied = 0;
      for (let i = 0; i < nBins; i++) {
        if (counts[i] > 0) { totalCount += counts[i]; occupied++; }
      }
      const meanCount = occupied > 0 ? totalCount / occupied : 1;
      const minCount = meanCount * MIN_BIN_COVERAGE;
      for (let i = 0; i < nBins; i++) {
        // Under-covered bins (image corners) would be amplified into fake
        // peaks by the division — see MIN_BIN_COVERAGE.
        if (counts[i] < minCount) bins[i] = 0;
        else bins[i] *= meanCount / counts[i];
      }

      const { median: bgMedian } = this.stats(bins);
      let peakVal = 0;
      for (let i = 0; i < nBins; i++) {
        const excess = bins[i] - bgMedian;
        if (excess > peakVal) peakVal = excess;
      }

      candidates.push({ angle: angleDeg, peakStrength: peakVal });
    }

    return candidates
      .sort((a, b) => b.peakStrength - a.peakStrength)
      .slice(0, topN);
  }

  // ─── Trail Validation ──────────────────────────────────────────────

  /**
   * Once we have a candidate angle, validate and measure the trail:
   * - Measure perpendicular profile width (FWHM must be < 8px)
   * - Measure trail length along the line direction
   * - Check brightness consistency along the trail
   */
  private validateTrail(
    unmasked: UnmaskedPoints,
    pxSigma: number,
    w: number,
    h: number,
    angleDeg: number,
    minLengthFraction: number = MIN_LENGTH_FRACTION_OF_DIAGONAL,
  ): TrailDetectionResult {
    const theta = angleDeg * Math.PI / 180;
    const perpX = Math.cos(theta), perpY = Math.sin(theta);
    const lineX = -Math.sin(theta), lineY = Math.cos(theta); // along the trail
    const cx = w / 2, cy = h / 2;
    const diagonal = Math.sqrt(w * w + h * h);

    // ── Step 1: Build perpendicular profile to find trail position ──
    // Sum-based (not mean) — same reasoning as findTrailAngle. A trail is
    // identified by piled-up flux at one perpendicular distance, not by
    // per-pixel intensity.
    const nPerp = Math.ceil(diagonal);
    const perpProfile = new Float64Array(nPerp);
    // Anti-aliased deposit + geometric count normalization — same
    // lattice-comb compensation as in findTrailAngles (see comment there).
    const perpCounts = new Float64Array(nPerp);
    const { dx: pxDx, dy: pxDy, flux: pxFlux, raw: pxRaw, count: pxCount } = unmasked;

    // Iterates only unmasked pixels (see UnmaskedPoints), same as
    // findTrailAngles — same pixels, same order, same math.
    for (let i = 0; i < pxCount; i++) {
      const proj = pxDx[i] * perpX + pxDy[i] * perpY;
      const pos = proj + nPerp / 2 - 0.5;
      const b0 = Math.floor(pos);
      const frac = pos - b0;
      const flux = pxFlux[i];
      if (b0 >= 0 && b0 < nPerp) {
        perpCounts[b0] += 1 - frac;
        perpProfile[b0] += flux * (1 - frac);
      }
      if (b0 + 1 >= 0 && b0 + 1 < nPerp) {
        perpCounts[b0 + 1] += frac;
        perpProfile[b0 + 1] += flux * frac;
      }
    }

    let perpTotal = 0, perpOccupied = 0;
    for (let i = 0; i < nPerp; i++) {
      if (perpCounts[i] > 0) { perpTotal += perpCounts[i]; perpOccupied++; }
    }
    const perpMeanCount = perpOccupied > 0 ? perpTotal / perpOccupied : 1;
    const perpMinCount = perpMeanCount * MIN_BIN_COVERAGE;
    for (let i = 0; i < nPerp; i++) {
      // Same corner-amplification guard as findTrailAngles — see MIN_BIN_COVERAGE.
      if (perpCounts[i] < perpMinCount) perpProfile[i] = 0;
      else perpProfile[i] *= perpMeanCount / perpCounts[i];
    }

    // Find the best peak in the perpendicular profile, scored by a
    // height-AND-thinness combo. Pure "narrowest above threshold" preferred
    // 2-px noise spikes over real trails; pure "tallest" would pick M42's
    // wide halo over a thin trail. The combined score
    // height / (fwhm + 2) rewards both axes — wide halos lose on thinness,
    // noise spikes lose on height. The +2 in the denominator caps the
    // effect of vanishingly thin peaks (numerical precision around 0).
    // Threshold also bumped from 2σ → 3σ to suppress noise spikes that
    // were getting through under the looser cutoff.
    const { median: perpBg, sigma: perpSigma } = this.stats(perpProfile);
    const peakMinHeight = perpBg + 2.5 * perpSigma;

    let bestPeakBin = -1;
    let bestFwhm = Infinity;
    let bestScore = -Infinity;

    for (let i = 1; i < nPerp - 1; i++) {
      // Must be a local maximum above the significance threshold
      if (perpProfile[i] <= peakMinHeight) continue;
      if (perpProfile[i] < perpProfile[i - 1] || perpProfile[i] < perpProfile[i + 1]) continue;

      const halfMax = (perpProfile[i] - perpBg) / 2 + perpBg;
      let left = i, right = i;
      while (left > 0 && perpProfile[left] > halfMax) left--;
      while (right < nPerp - 1 && perpProfile[right] > halfMax) right++;
      const fw = right - left;

      const heightAboveBg = perpProfile[i] - perpBg;
      const score = heightAboveBg / (fw + 2);
      if (score > bestScore) {
        bestScore = score;
        bestFwhm = fw;
        bestPeakBin = i;
      }
    }

    if (bestPeakBin < 0 || bestFwhm > FWHM_HARD_REJECT_PX) {
      return { trailDetected: false };
    }

    const peakBin = bestPeakBin;
    const fwhm = bestFwhm;

    // ── Step 3: Extract pixels along the trail ──
    // Collect pixels within ±fwhm of the trail center line
    const trailRho = peakBin - nPerp / 2; // perpendicular distance from center
    const tolerance = Math.max(fwhm, 3);

    // Project along the line direction to measure length. Sum-based again:
    // bins along the trail accumulate flux from many trail pixels, bins
    // outside the trail's extent see only sky-residual sum (≈ 0). The
    // previous mean-per-bin profile was dominated by per-pixel noise on the
    // off-trail bins (few contributing pixels → high variance), making the
    // 2σ threshold essentially test pixel noise instead of trail signal.
    const nLine = Math.ceil(diagonal);
    const lineProfile = new Float64Array(nLine);

    // Flanking strips on both sides of the trail, same width, offset far
    // enough to clear the trail's own FWHM. A real trail is bright relative
    // to its immediate surroundings (flanks ≈ sky); residual nebulosity
    // texture is just as bright in the flanks. Subtracting the flank average
    // per bin cancels texture-driven flux while leaving true trail flux
    // intact — this is what stopped M16's nebula rim from validating as a
    // 135° "trail". Per-flank pixel counts are tracked so the subtraction
    // stays calibrated when a flank is partially star-masked or off-image.
    const flankOffset = 3 * tolerance + 2;
    const flankSum = new Float64Array(nLine);
    const flankCount = new Float64Array(nLine);
    const lineCount = new Float64Array(nLine);

    // Same compact iteration as above. Uses the unclamped `raw` value (not
    // `flux`): a flank average built from clamped-positive noise would be
    // biased high, undercounting how much brighter the line strip really is.
    for (let i = 0; i < pxCount; i++) {
      const perpDist = pxDx[i] * perpX + pxDy[i] * perpY - trailRho;
      const onLine = Math.abs(perpDist) <= tolerance;
      const onFlank = Math.abs(Math.abs(perpDist) - flankOffset) <= tolerance;
      if (!onLine && !onFlank) continue;

      const val = pxRaw[i];
      const lineProj = pxDx[i] * lineX + pxDy[i] * lineY;
      // Anti-aliased deposit (see findTrailAngles): floor-binning starves
      // alternating bins at lattice-resonant angles (e.g. every other bin
      // empty at 30°), inflating profile sigma until real trails fail the
      // threshold. Splitting each pixel between its two nearest bins keeps
      // the profile smooth at every angle.
      const pos = lineProj + nLine / 2 - 0.5;
      const b0 = Math.floor(pos);
      const frac = pos - b0;
      for (const [bin, wgt] of [[b0, 1 - frac], [b0 + 1, frac]] as const) {
        if (bin < 0 || bin >= nLine || wgt === 0) continue;
        if (onLine) {
          lineProfile[bin] += val * wgt;
          lineCount[bin] += wgt;
        } else {
          flankSum[bin] += val * wgt;
          flankCount[bin] += wgt;
        }
      }
    }

    // Subtract the flank's mean flux scaled to the line strip's pixel count.
    // Bins with too little flank coverage (flanks star-masked or off-image)
    // can't be verified as locally bright — zero them so they read as gaps.
    // Without this, a line threading the unmasked fringe BETWEEN star-mask
    // blocks (nebula cores are a patchwork of masks) keeps its full texture
    // flux exactly where verification is impossible. Real trails crossing a
    // masked star lose those bins too, but gap bridging already covers that.
    for (let i = 0; i < nLine; i++) {
      if (lineCount[i] === 0) continue;
      if (flankCount[i] >= lineCount[i] * 0.5) {
        lineProfile[i] -= (flankSum[i] / flankCount[i]) * lineCount[i];
      } else {
        lineProfile[i] = 0;
      }
    }

    // Convert bin sums to z-scores: sum / (σ_px · √count). A bin's sum is a
    // sum of `count` pixels, so its noise scales with √count — the raw-sum
    // profile mixes bins of different occupancy, and its global sigma is
    // inflated by structure (masked gaps, nebula regions), which silently
    // raised the effective per-bin requirement to ~10 statistical sigma at
    // shallow angles where a trail spreads across many bins. As z-scores,
    // the 2.5σ threshold below means an honest 2.5σ everywhere.
    //
    // pxSigma is passed in rather than recomputed here: it depends only on
    // the frame's residual/mask, not on this candidate's angle, so detect()
    // computes it once and every one of up to 15 candidates reuses it instead
    // of each re-sorting the whole unmasked pixel set from scratch.
    const sigmaSafe = pxSigma > 0 ? pxSigma : 1;
    for (let i = 0; i < nLine; i++) {
      if (lineCount[i] > 0) {
        lineProfile[i] = lineProfile[i] / (sigmaSafe * Math.sqrt(lineCount[i]));
      }
    }

    // ── Step 4: Measure trail length ──
    // Find the extent of the trail: contiguous region above background,
    // tolerating short gaps caused by star-masked pixels along the trail.
    // Without gap tolerance, a trail that crosses a bright star is split
    // into two short segments each of which individually fails the minimum
    // length check, even though the combined trail is clearly real.
    //
    // The threshold is an absolute 2.5 in z units. It must NOT be derived
    // from the profile's own median/sigma: a trail that crosses the whole
    // frame fills every bin, so the profile median IS the trail level and a
    // median-relative threshold rejects the trail it is trying to measure
    // (this killed full-frame trails at shallow angles). Each bin is already
    // zero-referenced against its local background by the flank subtraction.
    const lineThreshold = 2.5;

    // maxGap: a single masked star in the downsampled image can blank up to
    // ~30 bins (star width + padding on both sides). 6% of diagonal covers
    // even the brightest star without risking merging truly separate features.
    const maxGap = Math.max(10, Math.ceil(diagonal * GAP_TOLERANCE_FRACTION_OF_DIAGONAL));

    let trailStart = -1, trailEnd = -1;
    let currentStart = -1, currentEnd = -1, currentGap = 0;
    let bestSpan = 0;

    for (let i = 0; i < nLine; i++) {
      if (lineProfile[i] > lineThreshold) {
        if (currentStart < 0) currentStart = i;
        currentEnd = i;
        currentGap = 0;
        const span = currentEnd - currentStart + 1;
        if (span > bestSpan) {
          bestSpan = span;
          trailStart = currentStart;
          trailEnd = currentEnd;
        }
      } else if (currentStart >= 0) {
        currentGap++;
        if (currentGap > maxGap) {
          currentStart = -1;
          currentEnd = -1;
          currentGap = 0;
        }
      }
    }

    const trailLength = trailEnd - trailStart;

    // Must span at least `minLengthFraction` of the image diagonal — 10% by
    // default, lowered by detect() when the caller supplies a plate scale and
    // 10% of the frame would be a far larger angle on the sky than any
    // satellite covers in one exposure (see MIN_TRAIL_ANGULAR_DEG).
    if (trailLength < diagonal * minLengthFraction) {
      return { trailDetected: false };
    }

    // A real satellite trail is a continuous bright line. Gap tolerance can
    // bridge star-masked holes in a genuine trail, but it also bridges
    // scattered star halos into fake trails. Two extra checks weed those out:
    //
    //  fill fraction  — at least 40% of the gap-tolerant span must be
    //                   above threshold. Sparse halo chains (a few bright
    //                   blobs separated by wide sky gaps) have ~20-30% fill.
    //                   Real trails hit 70-95% even with several star crossings.
    //
    //  contiguous run — the longest UNBRIDGED run above threshold must be
    //                   ≥ 3% of diagonal. Individual star halos contribute
    //                   8-14 bins; they would need to physically overlap to
    //                   reach 17+ bins. Real trails always have long stretches
    //                   between star crossings that satisfy this comfortably.
    let aboveThresholdBins = 0;
    let longestContiguous = 0;
    let runLen = 0;
    for (let i = trailStart; i <= trailEnd; i++) {
      if (lineProfile[i] > lineThreshold) {
        aboveThresholdBins++;
        if (++runLen > longestContiguous) longestContiguous = runLen;
      } else {
        runLen = 0;
      }
    }
    const fillFraction = aboveThresholdBins / (trailEnd - trailStart + 1);
    // The contiguous-run floor rides along with the length floor: it is 30% of
    // it by construction (3% of 10%), so a wide-field frame whose length gate
    // was lowered doesn't keep an unreachable run requirement.
    const contiguousFraction =
      minLengthFraction * (CONTIGUOUS_RUN_FRACTION_OF_DIAGONAL / MIN_LENGTH_FRACTION_OF_DIAGONAL);
    if (fillFraction < FILL_FRACTION_MIN || longestContiguous < diagonal * contiguousFraction) {
      return { trailDetected: false };
    }

    // ── Step 5: Compute endpoints in image coordinates ──
    const startLineProj = trailStart - nLine / 2;
    const endLineProj = trailEnd - nLine / 2;

    const x1 = Math.round(cx + startLineProj * lineX + trailRho * perpX);
    const y1 = Math.round(cy + startLineProj * lineY + trailRho * perpY);
    const x2 = Math.round(cx + endLineProj * lineX + trailRho * perpX);
    const y2 = Math.round(cy + endLineProj * lineY + trailRho * perpY);

    const lengthPx = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

    // ── Step 6: Confidence score ──
    // Two unit-interval signals combined, weights summing to 1. The previous
    // formula added a hardcoded +0.3 floor so even a marginal trail reported
    // 30%+ confidence — visually misleading. Now confidence == 0 means the
    // signals were absent; the line above has already gated detection on
    // length ≥ 10% diagonal, so any returned result will be at least ~0.06.
    const lengthRatio = Math.min(lengthPx / diagonal, 1);
    const thinness = Math.max(0, 1 - fwhm / 8); // thinner = better
    const confidence = Math.min(lengthRatio * 0.6 + thinness * 0.4, 1);

    // Floor-level scores are artifact-class (moon limb, mosaic border edge):
    // verified on real frames where both signals are nearly absent yet the
    // geometric gates technically pass. Real trails score well above this.
    if (confidence < MIN_CONFIDENCE) {
      return { trailDetected: false };
    }

    return {
      trailDetected: true,
      // The search parameterises a trail by its NORMAL (`angleDeg` defines
      // perpX/perpY); the trail itself runs along (-sin θ, cos θ), i.e. 90°
      // away. We used to return the normal, so the API field and the UI's
      // "· 110° angle" were both 90° off from the streak the user can see —
      // a trail drawn horizontally reported 90°. Report the direction the
      // trail actually runs, measured like any image angle: 0° = +x (image
      // rows), increasing towards +y, folded into [0, 180) because a trail
      // has an orientation but no direction.
      angleDegrees: (angleDeg + 90) % 180,
      lengthPixels: Math.round(lengthPx),
      midpoint: {
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
      },
      endpoints: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
      confidence: Math.round(confidence * 1000) / 1000,
      profileWidth: Math.round(fwhm * 10) / 10,
    };
  }

  // ─── Downsample ────────────────────────────────────────────────────

  /**
   * Box-filter downsample to at most MAX_DIM pixels on the longer side.
   * Averaging suppresses noise so S/N in the projection actually improves.
   * For a 1920×1080 Seestar frame → 512×288: ~14× fewer pixels to process.
   */
  private downsample(
    pixels: FitsImageData['pixels'],
    w: number,
    h: number,
  ): { pixels: Float64Array; w: number; h: number; scale: number } {
    const MAX_DIM = 512;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    if (scale >= 1) {
      const f64 = pixels instanceof Float64Array ? pixels : Float64Array.from(pixels);
      return { pixels: f64, w, h, scale: 1 };
    }

    const nw = Math.max(1, Math.floor(w * scale));
    const nh = Math.max(1, Math.floor(h * scale));
    const scaleX = w / nw;
    const scaleY = h / nh;
    const out = new Float64Array(nw * nh);

    for (let y = 0; y < nh; y++) {
      const sy0 = Math.floor(y * scaleY);
      const sy1 = Math.min(h, Math.ceil((y + 1) * scaleY));
      for (let x = 0; x < nw; x++) {
        const sx0 = Math.floor(x * scaleX);
        const sx1 = Math.min(w, Math.ceil((x + 1) * scaleX));
        let sum = 0, count = 0;
        for (let sy = sy0; sy < sy1; sy++)
          for (let sx = sx0; sx < sx1; sx++) {
            sum += pixels[sy * w + sx];
            count++;
          }
        out[y * nw + x] = count > 0 ? sum / count : 0;
      }
    }

    return { pixels: out, w: nw, h: nh, scale };
  }

  // ─── Main Detection ────────────────────────────────────────────────

  detect(buffer: Buffer, options: TrailDetectOptions = {}): TrailDetectionResult {
    const img = this.parseFitsPixels(buffer);

    // How long a trail must be, as a fraction of the frame diagonal.
    //
    // 10% of the diagonal is scale-free, but a trail's length is not: it is
    // `angular rate × exposure` degrees whatever optics produced the frame. On
    // a Seestar 10% of the diagonal is 0.15°, well under the several degrees a
    // satellite sweeps in one sub, so the rule never bites. On a camera-lens
    // field (63° diagonal) 10% is 6.3° and real trails were being discarded
    // for being "too short". Where the caller knows the plate scale, take
    // whichever floor is LOWER — this can only make the detector more
    // sensitive on wide fields, never stricter than it is today.
    let minLengthFraction = MIN_LENGTH_FRACTION_OF_DIAGONAL;
    const degPerPx = options.degreesPerPixel;
    if (degPerPx !== undefined && Number.isFinite(degPerPx) && degPerPx > 0) {
      const diagonalNativePx = Math.sqrt(img.width * img.width + img.height * img.height);
      const angularFloorPx = MIN_TRAIL_ANGULAR_DEG / degPerPx;
      minLengthFraction = Math.min(
        MIN_LENGTH_FRACTION_OF_DIAGONAL,
        angularFloorPx / Math.max(diagonalNativePx, 1),
      );
    }

    // CFA mosaics: bin 2x2 blocks first so the generic fractional downsample
    // below never sees Bayer periodicity (see binCfa2x2 for the moiré story).
    let work: { pixels: FitsImageData['pixels']; w: number; h: number } =
      { pixels: img.pixels, w: img.width, h: img.height };
    let binFactor = 1;
    if (img.bayerPattern && img.width >= 2 && img.height >= 2) {
      const despeckled = this.despeckleCfa(img.pixels, img.width, img.height);
      work = this.binCfa2x2(despeckled, img.width, img.height);
      binFactor = 2;
    }

    // Work on a downsampled copy — ~14× fewer pixels for a typical Seestar frame,
    // with no loss in detection quality (trails are still many pixels long).
    const ds = this.downsample(work.pixels, work.w, work.h);

    const residual = this.subtractBackground(ds.pixels, ds.w, ds.h);
    const starMask = this.buildStarMask(residual, ds.w, ds.h);
    // Every full-frame pass from here on (the 180-angle search, plus up to 15
    // more for candidate validation — ~195 total) only ever visits unmasked
    // pixels. Compacting them once, instead of re-walking the whole W×H grid
    // and re-testing the mask on every single one of those ~195 passes, is
    // what turns a multi-second-per-frame scan into a fraction of a second.
    // See UnmaskedPoints.
    const unmasked = this.collectUnmasked(residual, starMask, ds.w, ds.h);
    // Robust per-pixel sigma over unmasked pixels, needed by every
    // candidate's z-score normalization in validateTrail. It depends only on
    // `residual`/`starMask`, both fixed for this frame, so it's computed once
    // here instead of once per candidate (up to 15 redundant full sorts).
    const { sigma: pxSigma } = this.stats(unmasked.raw);
    const candidates = this.findTrailAngles(unmasked, ds.w, ds.h);

    // Detection ran at ds.scale relative to the (possibly binned) input;
    // multiply by binFactor to express results in original pixel coordinates.
    const totalScale = ds.scale / binFactor;

    for (const { angle } of candidates) {
      const result = this.validateTrail(unmasked, pxSigma, ds.w, ds.h, angle, minLengthFraction);
      if (!result.trailDetected) continue;

      if (totalScale < 1) {
        // `result` is narrowed to TrailDetected by the guard above, so every
        // measurement below is known-present. The old code re-tested each one
        // for null and fell back to `undefined` — branches the type system now
        // proves are dead.
        const inv = 1 / totalScale;
        const scalePoint = (p: ImagePoint): ImagePoint => ({
          x: Math.round(p.x * inv),
          y: Math.round(p.y * inv),
        });
        return {
          ...result,
          lengthPixels: Math.round(result.lengthPixels * inv),
          midpoint: scalePoint(result.midpoint),
          endpoints: [scalePoint(result.endpoints[0]), scalePoint(result.endpoints[1])],
        };
      }
      return result;
    }

    return { trailDetected: false };
  }
}

export const trailDetector = new TrailDetector();
