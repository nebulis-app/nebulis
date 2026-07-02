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

export interface TrailDetectionResult {
  trailDetected: boolean;
  angleDegrees?: number;
  lengthPixels?: number;
  midpoint?: { x: number; y: number };
  endpoints?: [{ x: number; y: number }, { x: number; y: number }];
  confidence?: number;
  profileWidth?: number; // FWHM of the trail in pixels
}

export interface FitsImageData {
  width: number;
  height: number;
  pixels: Float64Array | Float32Array | Int32Array | Int16Array | Uint8Array;
  bitpix: number;
  /** Bayer pattern (e.g. 'GRBG') when the frame is an un-debayered CFA mosaic. */
  bayerPattern: string | null;
}

const CFA_PATTERNS = new Set(['RGGB', 'BGGR', 'GRBG', 'GBRG']);

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
    let width = 0, height = 0, naxis3 = 1, bitpix = 0, bzero = 0, bscale = 1, headerEnd = 0;
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
          switch (kw) {
            case 'NAXIS1': width = parseInt(v, 10); break;
            case 'NAXIS2': height = parseInt(v, 10); break;
            case 'NAXIS3': naxis3 = parseInt(v, 10); break;
            case 'BITPIX': bitpix = parseInt(v, 10); break;
            case 'BZERO':  bzero = parseFloat(v); break;
            case 'BSCALE': bscale = parseFloat(v); break;
            case 'BAYERPAT': bayerRaw = v.replace(/'/g, '').trim().toUpperCase(); break;
          }
        }
      }
    }

    // BAYERPAT only means "un-debayered mosaic" for 2-D data. RGB cubes
    // (NAXIS3=3, stacked files) carry the keyword too but are already
    // demosaiced — we read their first plane, which has no CFA periodicity.
    const bayerPattern = naxis3 <= 1 && CFA_PATTERNS.has(bayerRaw) ? bayerRaw : null;

    if (!width || !height || !bitpix) throw new Error(`Invalid FITS: ${width}x${height} bitpix=${bitpix}`);

    const n = width * height;
    const d = buffer.subarray(headerEnd);
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
      default: throw new Error(`Unsupported BITPIX: ${bitpix}`);
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
    const med = sample[sample.length >> 1];
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

  /** Robust per-pixel statistics over unmasked pixels only. */
  private statsUnmasked(data: Float64Array, mask: Uint8Array): { median: number; sigma: number } {
    const vals: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (!mask[i]) vals.push(data[i]);
    }
    if (vals.length === 0) return { median: 0, sigma: 0 };
    vals.sort((a, b) => a - b);
    const median = trueMedian(vals);
    const absDevs = vals.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    return { median, sigma: trueMedian(absDevs) * 1.4826 };
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
   */
  private createStarMask(residual: Float64Array, w: number, h: number): Uint8Array {
    const { sigma } = this.stats(residual);
    const threshold = 5 * sigma;
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
      // Pixels-per-bbox-diagonal is ~1 for a thin line at any orientation
      // (axis-aligned, diagonal, or anywhere in between) and grows roughly
      // linearly with radius for round compact features. The previous
      // aspect/fill formulation rejected axis-aligned trails (bbox 200×1 has
      // fill = 1.0) and diagonal trails (bbox 200×200 has aspect ≈ 1).
      // Linearity handles both regimes uniformly.
      const diag = Math.sqrt(bbW * bbW + bbH * bbH);
      const linearity = pixelCount / Math.max(diag, 1);

      // Linear iff: pixels track the bbox diagonal closely AND the feature is
      // long enough to plausibly be a trail (not a 5-pixel speckle that
      // happens to be thin).
      if (linearity <= 2.5 && diag >= 20) continue;

      // Compact source — likely a star. Mask the bounding box plus padding
      // sized to the component's brightness so halos and faint diffraction
      // spikes get covered too. Capped to avoid eating big chunks of sky
      // around blooming-bright stars.
      const padding = Math.min(12, Math.max(3, Math.round(maxIntensity / sigma)));
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
    residual: Float64Array,
    starMask: Uint8Array,
    w: number,
    h: number,
    topN = 15,
  ): Array<{ angle: number; peakStrength: number }> {
    const diagonal = Math.sqrt(w * w + h * h);
    const cx = w / 2, cy = h / 2;
    const nBins = Math.ceil(diagonal);

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

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (starMask[y * w + x]) continue;
          const proj = (x - cx) * perpX + (y - cy) * perpY;
          const pos = proj + nBins / 2 - 0.5;
          const b0 = Math.floor(pos);
          const frac = pos - b0;
          const val = residual[y * w + x];
          const flux = val > 0 ? val : 0;
          if (b0 >= 0 && b0 < nBins) {
            counts[b0] += 1 - frac;
            bins[b0] += flux * (1 - frac);
          }
          if (b0 + 1 >= 0 && b0 + 1 < nBins) {
            counts[b0 + 1] += frac;
            bins[b0 + 1] += flux * frac;
          }
        }
      }

      let totalCount = 0, occupied = 0;
      for (let i = 0; i < nBins; i++) {
        if (counts[i] > 0) { totalCount += counts[i]; occupied++; }
      }
      const meanCount = occupied > 0 ? totalCount / occupied : 1;
      for (let i = 0; i < nBins; i++) {
        if (counts[i] > 0) bins[i] *= meanCount / counts[i];
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
    residual: Float64Array,
    starMask: Uint8Array,
    w: number,
    h: number,
    angleDeg: number,
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

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (starMask[y * w + x]) continue;
        const proj = (x - cx) * perpX + (y - cy) * perpY;
        const pos = proj + nPerp / 2 - 0.5;
        const b0 = Math.floor(pos);
        const frac = pos - b0;
        const val = residual[y * w + x];
        const flux = val > 0 ? val : 0;
        if (b0 >= 0 && b0 < nPerp) {
          perpCounts[b0] += 1 - frac;
          perpProfile[b0] += flux * (1 - frac);
        }
        if (b0 + 1 >= 0 && b0 + 1 < nPerp) {
          perpCounts[b0 + 1] += frac;
          perpProfile[b0 + 1] += flux * frac;
        }
      }
    }

    let perpTotal = 0, perpOccupied = 0;
    for (let i = 0; i < nPerp; i++) {
      if (perpCounts[i] > 0) { perpTotal += perpCounts[i]; perpOccupied++; }
    }
    const perpMeanCount = perpOccupied > 0 ? perpTotal / perpOccupied : 1;
    for (let i = 0; i < nPerp; i++) {
      if (perpCounts[i] > 0) perpProfile[i] *= perpMeanCount / perpCounts[i];
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

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (starMask[y * w + x]) continue;
        const perpDist = (x - cx) * perpX + (y - cy) * perpY - trailRho;
        const onLine = Math.abs(perpDist) <= tolerance;
        const onFlank = Math.abs(Math.abs(perpDist) - flankOffset) <= tolerance;
        if (!onLine && !onFlank) continue;

        const val = residual[y * w + x];
        const lineProj = (x - cx) * lineX + (y - cy) * lineY;
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
    const { sigma: pxSigma } = this.statsUnmasked(residual, starMask);
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

    // Must span at least 10% of the image diagonal
    if (trailLength < diagonal * MIN_LENGTH_FRACTION_OF_DIAGONAL) {
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
    if (fillFraction < FILL_FRACTION_MIN || longestContiguous < diagonal * CONTIGUOUS_RUN_FRACTION_OF_DIAGONAL) {
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
      angleDegrees: angleDeg,
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

  detect(buffer: Buffer): TrailDetectionResult {
    const img = this.parseFitsPixels(buffer);

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
    const starMask = this.createStarMask(residual, ds.w, ds.h);
    const candidates = this.findTrailAngles(residual, starMask, ds.w, ds.h);

    // Detection ran at ds.scale relative to the (possibly binned) input;
    // multiply by binFactor to express results in original pixel coordinates.
    const totalScale = ds.scale / binFactor;

    for (const { angle } of candidates) {
      const result = this.validateTrail(residual, starMask, ds.w, ds.h, angle);
      if (!result.trailDetected) continue;

      if (totalScale < 1) {
        const inv = 1 / totalScale;
        return {
          ...result,
          lengthPixels: result.lengthPixels != null ? Math.round(result.lengthPixels * inv) : undefined,
          midpoint: result.midpoint
            ? { x: Math.round(result.midpoint.x * inv), y: Math.round(result.midpoint.y * inv) }
            : undefined,
          endpoints: result.endpoints
            ? [
                { x: Math.round(result.endpoints[0].x * inv), y: Math.round(result.endpoints[0].y * inv) },
                { x: Math.round(result.endpoints[1].x * inv), y: Math.round(result.endpoints[1].y * inv) },
              ]
            : undefined,
        };
      }
      return result;
    }

    return { trailDetected: false };
  }
}

export const trailDetector = new TrailDetector();
