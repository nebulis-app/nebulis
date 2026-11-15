/**
 * Renders a sky cutout from HiPS tiles, standing in for the CDS hips2fits service when it cannot be reached.
 *
 * The output is deliberately the same shape the framing planner already assumes: a square, north-up, gnomonic
 * (TAN) picture whose width is exactly the requested field of view, centered on the object. The client draws the
 * sensor rectangle and the fit verdict from that assumption (the framing and mosaic planner), so a projection
 * or scale mistake here does not look like a bug, it looks like a telescope that does not fit the object.
 *
 * The tiles are `CDS/P/DSS2/color`, served by partner archives as a plain pyramid, so the picture is the same
 * product users saw from CDS rather than a stand-in survey.
 */
import sharp from 'sharp';
import { skyToTile, TILE_PIXELS } from './healpix.js';
import { loadTiles, type TileSource, type TileImage } from './tiles.js';

/** The route caps the request at 1200 already; this is the same ceiling, enforced here so the renderer is safe alone. */
const MAX_SIZE_PX = 1200;
const MIN_SIZE_PX = 64;
/**
 * Roughly how much sky one tile pixel covers. A HEALPix cell is not a square, so this uses the side of the
 * equal-area square with the same area, which is about 0.7% off the raster's own axis pitch. That error only ever
 * picks an order, where one step is a factor of two, so it cannot matter here.
 */
const TILE_PIXEL_DEG = 58.63 / TILE_PIXELS;
const MAX_TILE_LIMIT = 64;
const DEG = Math.PI / 180;

export interface CutoutRequest {
  raDeg: number;
  decDeg: number;
  /** Degrees across the picture. The picture is square, so this is both width and height. */
  fovDeg: number;
  sizePx: number;
  fetchImpl?: typeof fetch;
  sources?: readonly TileSource[];
  cacheRoot?: string;
  budgetMs?: number;
  concurrency?: number;
  /** Defaults to the point where a cutout would need more than 8x8 tiles, which means something is wrong upstream. */
  maxTiles?: number;
}

export interface CutoutResult {
  /** JPEG bytes, ready to write. */
  buffer: Buffer;
  /** Host that supplied the tiles. */
  source: string;
  /** Tiles actually used. */
  tiles: number;
  order: number;
}

/**
 * The HiPS order whose tile pixels are closest to the size of an output pixel.
 *
 * One output pixel should cover about one tile pixel: a coarser order upsamples and blurs, a finer one downloads
 * detail the picture cannot show. Rounding (rather than flooring) keeps the error symmetric and within one step.
 */
export function orderForPixelScale(fovDeg: number, sizePx: number): number {
  const degPerPixel = fovDeg / sizePx;
  if (!Number.isFinite(degPerPixel) || degPerPixel <= 0) return 0;
  const wanted = Math.log2(TILE_PIXEL_DEG / degPerPixel);
  return Math.min(8, Math.max(0, Math.round(wanted)));
}

/**
 * Pixel (i, j) of the output to the sky position it looks at, for a north-up TAN grid centered on ra0/dec0.
 *
 * East is to the left, which is the convention for a sky picture and the one hips2fits returns: a picture of the
 * sky is seen from the inside, so right ascension grows toward the left. Getting this backwards mirrors every
 * cutout, which is invisible on a round nebula and obvious on a pair like the Heart and the Fish Head. The scale is
 * degrees per pixel on the tangent plane, so the width spans exactly `fovRad` in the linear sense hips2fits uses.
 */
function gridToSky(sizePx: number, fovRad: number, ra0: number, dec0: number): (i: number, j: number) => { ra: number; dec: number } {
  const scale = fovRad / sizePx;
  const sin0 = Math.sin(dec0);
  const cos0 = Math.cos(dec0);
  return (i, j) => {
    const xi = (sizePx / 2 - (i + 0.5)) * scale;
    const eta = (sizePx / 2 - (j + 0.5)) * scale;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return { ra: ra0, dec: dec0 };
    const c = Math.atan(rho);
    const sinC = Math.sin(c);
    const cosC = Math.cos(c);
    const dec = Math.asin(Math.max(-1, Math.min(1, cosC * sin0 + (eta * sinC * cos0) / rho)));
    const ra = ra0 + Math.atan2(xi * sinC, rho * cos0 * cosC - eta * sin0 * sinC);
    return { ra, dec };
  };
}

/** Bilinear sample with the edges clamped, which costs at most the outermost half pixel of a tile. */
function sampleTile(tile: TileImage, column: number, row: number, out: Buffer, offset: number): void {
  const x = Math.max(0, Math.min(tile.width - 1, column));
  const y = Math.max(0, Math.min(tile.height - 1, row));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, tile.width - 1);
  const y1 = Math.min(y0 + 1, tile.height - 1);
  const dx = x - x0;
  const dy = y - y0;
  const rowStride = tile.width * 3;
  const p00 = y0 * rowStride + x0 * 3;
  const p10 = y0 * rowStride + x1 * 3;
  const p01 = y1 * rowStride + x0 * 3;
  const p11 = y1 * rowStride + x1 * 3;
  for (let channel = 0; channel < 3; channel++) {
    const top = tile.data[p00 + channel] * (1 - dx) + tile.data[p10 + channel] * dx;
    const bottom = tile.data[p01 + channel] * (1 - dx) + tile.data[p11 + channel] * dx;
    out[offset + channel] = Math.round(top * (1 - dy) + bottom * dy);
  }
}

/**
 * Render the cutout, or return null when no host can supply the tiles it needs.
 *
 * Two passes: project every output pixel once (which also tells us exactly which tiles the field touches), then
 * sample. Projecting inside the sampling loop would either double the trigonometry or force a guess at the tile
 * set from the field's corners, which is wrong near a face edge where a square field can span three faces.
 */
export async function renderHipsCutout(request: CutoutRequest): Promise<CutoutResult | null> {
  if (!Number.isFinite(request.raDeg) || !Number.isFinite(request.decDeg)) return null;
  if (!Number.isFinite(request.fovDeg) || request.fovDeg <= 0) return null;
  if (!Number.isFinite(request.sizePx)) return null;
  const sizePx = Math.max(MIN_SIZE_PX, Math.min(MAX_SIZE_PX, Math.round(request.sizePx)));
  const order = orderForPixelScale(request.fovDeg, sizePx);
  const maxTiles = request.maxTiles ?? MAX_TILE_LIMIT;

  const toSky = gridToSky(sizePx, request.fovDeg * DEG, request.raDeg * DEG, request.decDeg * DEG);
  const pixelCount = sizePx * sizePx;
  const tileOfPixel = new Int32Array(pixelCount);
  const fractionX = new Float32Array(pixelCount);
  const fractionY = new Float32Array(pixelCount);
  const tilesNeeded = new Set<number>();

  for (let j = 0; j < sizePx; j++) {
    for (let i = 0; i < sizePx; i++) {
      const { ra, dec } = toSky(i, j);
      const position = skyToTile(ra, dec, order);
      const index = j * sizePx + i;
      tileOfPixel[index] = position.tile;
      fractionX[index] = position.fx;
      fractionY[index] = position.fy;
      tilesNeeded.add(position.tile);
      // Bail while projecting rather than after: a field that needs more tiles than the cap is not worth finishing.
      if (tilesNeeded.size > maxTiles) return null;
    }
  }

  if (tilesNeeded.size === 0) return null;

  const loaded = await loadTiles({
    order,
    tiles: [...tilesNeeded],
    fetchImpl: request.fetchImpl,
    budgetMs: request.budgetMs,
    concurrency: request.concurrency,
    sources: request.sources,
    cacheRoot: request.cacheRoot,
  });
  if (!loaded) return null;

  const rgb = Buffer.alloc(pixelCount * 3);
  for (let index = 0; index < pixelCount; index++) {
    const tile = loaded.tiles.get(tileOfPixel[index]);
    if (!tile) continue;
    // The raster is transposed against the face plane: a tile's columns run along the face's q axis and its rows
    // along p. Sampling it the other way round stitches each tile back to front and leaves dark bands along every
    // tile edge. Checked against SkyView's north-up DSS2 of the same field, where the two line up pixel for pixel.
    const column = fractionY[index] * TILE_PIXELS - 0.5;
    const row = fractionX[index] * TILE_PIXELS - 0.5;
    sampleTile(tile, column, row, rgb, index * 3);
  }

  const buffer = await sharp(rgb, { raw: { width: sizePx, height: sizePx, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  return { buffer, source: loaded.source, tiles: tilesNeeded.size, order };
}
