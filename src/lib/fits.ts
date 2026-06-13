// Shared FITS file parsing and rendering utilities

export interface FitsHeader {
  BITPIX?: number;
  NAXIS1?: number;
  NAXIS2?: number;
  BZERO?: number;
  BSCALE?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface FitsData {
  header: FitsHeader;
  imageData: Float64Array;
  width: number;
  height: number;
}

export type Colormap = 'gray' | 'heat' | 'cool';

export function parseFits(buffer: ArrayBuffer): FitsData {
  const view = new DataView(buffer);
  const header: FitsHeader = {};
  let offset = 0;

  let headerDone = false;
  while (!headerDone) {
    for (let i = 0; i < 36 && !headerDone; i++) {
      const card = new TextDecoder('ascii').decode(new Uint8Array(buffer, offset, 80));
      offset += 80;

      if (card.startsWith('END')) {
        headerDone = true;
        break;
      }

      const key = card.substring(0, 8).trim();
      if (card[8] === '=' && key) {
        let valStr = card.substring(10, 80).trim();
        const slashIdx = valStr.indexOf('/');
        if (slashIdx > 0 && !valStr.startsWith("'")) {
          valStr = valStr.substring(0, slashIdx).trim();
        }
        if (valStr === 'T') {
          header[key] = true;
        } else if (valStr === 'F') {
          header[key] = false;
        } else if (valStr.startsWith("'")) {
          header[key] = valStr.replace(/^'|'.*$/g, '').trim();
        } else if (valStr) {
          const num = parseFloat(valStr);
          if (!isNaN(num)) header[key] = num;
        }
      }
    }
    if (!headerDone) continue;
    const remainder = offset % 2880;
    if (remainder !== 0) offset += 2880 - remainder;
  }

  const bitpix = typeof header.BITPIX === 'number' ? header.BITPIX : 16;
  const width = typeof header.NAXIS1 === 'number' ? header.NAXIS1 : 0;
  const height = typeof header.NAXIS2 === 'number' ? header.NAXIS2 : 0;
  const bzero = typeof header.BZERO === 'number' ? header.BZERO : 0;
  const bscale = typeof header.BSCALE === 'number' ? header.BSCALE : 1;

  const pixelCount = width * height;
  const imageData = new Float64Array(pixelCount);
  const bytesPerPixel = Math.abs(bitpix) / 8;
  const dataOffset = offset;

  for (let i = 0; i < pixelCount; i++) {
    const bytePos = dataOffset + i * bytesPerPixel;
    if (bytePos + bytesPerPixel > buffer.byteLength) break;

    let rawVal: number;
    switch (bitpix) {
      case 8:   rawVal = view.getUint8(bytePos); break;
      case 16:  rawVal = view.getInt16(bytePos, false); break;
      case 32:  rawVal = view.getInt32(bytePos, false); break;
      case -32: rawVal = view.getFloat32(bytePos, false); break;
      case -64: rawVal = view.getFloat64(bytePos, false); break;
      default:  rawVal = view.getInt16(bytePos, false);
    }

    imageData[i] = rawVal * bscale + bzero;
  }

  return { header, imageData, width, height };
}

// Interpolate between color stops for a value in [0,1]
function lerpStops(v: number, stops: number[][]): [number, number, number] {
  const n = stops.length - 1;
  const pos = Math.max(0, Math.min(n, v * n));
  const i = Math.min(Math.floor(pos), n - 1);
  const t = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function applyColormap(v: number, cm: Colormap): [number, number, number] {
  switch (cm) {
    case 'gray': {
      const b = Math.round(Math.max(0, Math.min(1, v)) * 255);
      return [b, b, b];
    }
    case 'heat': {
      // Inferno-inspired: black → purple → orange → yellow → white
      return lerpStops(v, [
        [0, 0, 4],
        [20, 11, 53],
        [58, 9, 99],
        [96, 19, 110],
        [132, 33, 107],
        [166, 54, 89],
        [197, 83, 62],
        [224, 120, 29],
        [241, 164, 12],
        [249, 210, 60],
        [252, 255, 164],
      ]);
    }
    case 'cool': {
      // Blue → cyan → white (cool astronomical palette)
      return lerpStops(v, [
        [0, 0, 0],
        [0, 0, 128],
        [0, 64, 200],
        [0, 160, 255],
        [100, 210, 255],
        [255, 255, 255],
      ]);
    }
  }
}

/** Compute auto-stretch bounds by sampling the image data (every Nth pixel for speed). */
function computeStretchBounds(
  imageData: Float64Array,
  stretch: number,
  sampleRate = 8
): { lo: number; hi: number } {
  const sampled: number[] = [];
  for (let i = 0; i < imageData.length; i += sampleRate) {
    sampled.push(imageData[i]);
  }
  sampled.sort((a, b) => a - b);
  const lo = sampled[Math.floor(sampled.length * 0.02)];
  const hi = sampled[Math.floor(sampled.length * (0.98 + stretch * 0.019))];
  return { lo, hi };
}

/**
 * Render a FITS image to a canvas at full resolution (for FitsViewer).
 */
export function renderFitsToCanvas(
  canvas: HTMLCanvasElement,
  imageData: Float64Array,
  width: number,
  height: number,
  stretch: number,
  colormap: Colormap = 'gray',
  dpr = 1,
) {
  const pw = Math.round(width * dpr);
  const ph = Math.round(height * dpr);
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { lo, hi } = computeStretchBounds(imageData, stretch);
  const range = hi - lo || 1;
  const gamma = 1.0 / (1.0 + stretch * 0.5);

  const imgData = ctx.createImageData(pw, ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / dpr));
      const srcY = Math.min(height - 1, Math.floor(y / dpr));
      const srcIdx = (height - 1 - srcY) * width + srcX; // FITS bottom-up
      const dstIdx = (y * pw + x) * 4;
      const normalized = (imageData[srcIdx] - lo) / range;
      const val = Math.max(0, Math.min(1, Math.pow(Math.max(0, normalized), gamma)));
      const [r, g, b] = applyColormap(val, colormap);
      imgData.data[dstIdx] = r;
      imgData.data[dstIdx + 1] = g;
      imgData.data[dstIdx + 2] = b;
      imgData.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Render a FITS image to a square canvas of size `size x size`.
 * The image is scaled to fit inside the square with black letterboxing so the
 * canvas is always square — required because CSS object-cover doesn't apply to
 * <canvas> and a non-square canvas stretches badly in a square tile grid.
 */
export function renderFitsThumbnail(
  canvas: HTMLCanvasElement,
  imageData: Float64Array,
  srcWidth: number,
  srcHeight: number,
  stretch: number,
  colormap: Colormap,
  size = 512,
  dpr = 1,
) {
  const physical = Math.round(size * dpr);
  canvas.width = physical;
  canvas.height = physical;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Scale to fit within the square, preserving aspect ratio
  const scale = Math.min(physical / srcWidth, physical / srcHeight);
  const dstWidth = Math.max(1, Math.round(srcWidth * scale));
  const dstHeight = Math.max(1, Math.round(srcHeight * scale));
  const offsetX = Math.floor((physical - dstWidth) / 2);
  const offsetY = Math.floor((physical - dstHeight) / 2);

  // Black background for letterbox bars
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, physical, physical);

  const { lo, hi } = computeStretchBounds(imageData, stretch);
  const range = hi - lo || 1;
  const gamma = 1.0 / (1.0 + stretch * 0.5);

  const imgData = ctx.createImageData(dstWidth, dstHeight);
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.min(srcWidth - 1, Math.floor(x / scale));
      const srcY = Math.min(srcHeight - 1, Math.floor(y / scale));
      const srcIdx = (srcHeight - 1 - srcY) * srcWidth + srcX; // FITS bottom-up
      const normalized = (imageData[srcIdx] - lo) / range;
      const val = Math.max(0, Math.min(1, Math.pow(Math.max(0, normalized), gamma)));
      const [r, g, b] = applyColormap(val, colormap);
      const dstIdx = (y * dstWidth + x) * 4;
      imgData.data[dstIdx] = r;
      imgData.data[dstIdx + 1] = g;
      imgData.data[dstIdx + 2] = b;
      imgData.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, offsetX, offsetY);
}
