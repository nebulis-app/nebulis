import { isRecord } from '../typeGuards.js';
import type { FrameMetrics } from './measure.js';

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Read a measurement back from untyped data (the worker's reply, a stored JSON column), field by field. Anything
 * that does not fit the current shape is refused, so an old row can never be mistaken for a current one.
 */
export function coerceMetrics(value: unknown): FrameMetrics | null {
  if (!isRecord(value)) return null;
  const width = numberOrNull(value.width), height = numberOrNull(value.height), starCount = numberOrNull(value.starCount);
  const background = numberOrNull(value.background), noise = numberOrNull(value.noise);
  const gradient = numberOrNull(value.gradient), saturatedFraction = numberOrNull(value.saturatedFraction);
  if (width === null || height === null || starCount === null || background === null || noise === null
    || gradient === null || saturatedFraction === null) return null;
  let streak: FrameMetrics['streak'] = null;
  if (isRecord(value.streak)) {
    const angle = numberOrNull(value.streak.angle), strength = numberOrNull(value.streak.strength);
    if (angle !== null && strength !== null) streak = { angle, strength };
  }
  return {
    width, height, starCount,
    fwhm: numberOrNull(value.fwhm),
    elongation: numberOrNull(value.elongation),
    orientation: numberOrNull(value.orientation),
    background, noise, gradient,
    peakSNR: numberOrNull(value.peakSNR),
    streak, saturatedFraction,
    ra: numberOrNull(value.ra),
    dec: numberOrNull(value.dec),
  };
}
