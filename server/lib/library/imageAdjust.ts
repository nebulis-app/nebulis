/**
 * The image editor's brightness, contrast and saturation, per pixel, on a full-size picture.
 *
 * A copy of `src/lib/imageAdjust.ts` (the server cannot import from `src/`), generalized to 3 or 4 channels. The
 * arithmetic must stay identical: `tests/backend/imageAdjustParity.test.ts` runs both on the same pixels. Change both
 * together.
 */
export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Adjusts interleaved 8-bit pixels in place. `channels` is 3 (RGB) or 4 (RGBA, alpha left alone). */
export function applyPixelAdjustments(data: Uint8Array, channels: 3 | 4, adjust: Adjustments): void {
  const { brightness, contrast, saturation } = adjust;
  if (brightness === 0 && contrast === 0 && saturation === 0) return;
  const br  = brightness / 100;
  const con = (contrast + 100) / 100;   // 0–2
  const sat = (saturation + 100) / 100; // 0–2
  // Writes through a clamped view so rounding and saturation match the browser's canvas exactly.
  const out = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);

  for (let i = 0; i < out.length; i += channels) {
    let r = out[i]     / 255;
    let g = out[i + 1] / 255;
    let b = out[i + 2] / 255;

    r += br; g += br; b += br;
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    r = gray + sat * (r - gray);
    g = gray + sat * (g - gray);
    b = gray + sat * (b - gray);
    r = (r - 0.5) * con + 0.5;
    g = (g - 0.5) * con + 0.5;
    b = (b - 0.5) * con + 0.5;

    out[i]     = Math.max(0, Math.min(255, r * 255));
    out[i + 1] = Math.max(0, Math.min(255, g * 255));
    out[i + 2] = Math.max(0, Math.min(255, b * 255));
  }
}
