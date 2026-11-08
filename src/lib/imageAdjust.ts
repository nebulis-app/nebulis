/**
 * The image editor's brightness, contrast and saturation, per pixel. The preview runs it in the browser and the
 * server runs the same arithmetic on the full-size picture (`server/lib/library/imageAdjust.ts`), so a saved picture
 * matches what the preview showed. `tests/backend/imageAdjustParity.test.ts` fails if the two differ by a single value.
 * Change both together.
 */
export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Adjusts RGBA pixels in place. `data` is clamped on write, so out-of-range results saturate at 0 and 255. */
export function applyPixelAdjustments(
  data: Uint8ClampedArray,
  brightness: number,
  contrast: number,
  saturation: number,
): void {
  if (brightness === 0 && contrast === 0 && saturation === 0) return;
  const br  = brightness / 100;
  const con = (contrast + 100) / 100;   // 0–2
  const sat = (saturation + 100) / 100; // 0–2

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]     / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    // brightness
    r += br; g += br; b += br;
    // saturation
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    r = gray + sat * (r - gray);
    g = gray + sat * (g - gray);
    b = gray + sat * (b - gray);
    // contrast (pivot at 0.5)
    r = (r - 0.5) * con + 0.5;
    g = (g - 0.5) * con + 0.5;
    b = (b - 0.5) * con + 0.5;

    data[i]     = Math.max(0, Math.min(255, r * 255));
    data[i + 1] = Math.max(0, Math.min(255, g * 255));
    data[i + 2] = Math.max(0, Math.min(255, b * 255));
  }
}
