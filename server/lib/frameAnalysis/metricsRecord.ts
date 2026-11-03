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
  let target: FrameMetrics['target'] = null;
  if (isRecord(value.target)) {
    const t = value.target;
    const x = numberOrNull(t.x), y = numberOrNull(t.y), radius = numberOrNull(t.radius);
    const signal = numberOrNull(t.signal), snr = numberOrNull(t.snr);
    if (x !== null && y !== null && radius !== null && signal !== null && snr !== null) target = { x, y, radius, signal, snr };
  }
  const spots: FrameMetrics['spots'] = [];
  if (Array.isArray(value.spots)) {
    for (const s of value.spots) {
      if (!isRecord(s)) continue;
      const x = numberOrNull(s.x), y = numberOrNull(s.y), diameter = numberOrNull(s.diameter), depth = numberOrNull(s.depth);
      if (x !== null && y !== null && diameter !== null && depth !== null) spots.push({ x, y, diameter, depth });
    }
  }
  const rigRaw = isRecord(value.rig) ? value.rig : {};
  const rig: FrameMetrics['rig'] = {
    camera: typeof rigRaw.camera === 'string' ? rigRaw.camera : null,
    focal: numberOrNull(rigRaw.focal),
    scale: numberOrNull(rigRaw.scale),
  };
  return {
    width, height, starCount,
    fwhm: numberOrNull(value.fwhm),
    elongation: numberOrNull(value.elongation),
    orientation: numberOrNull(value.orientation),
    background, noise, gradient,
    peakSNR: numberOrNull(value.peakSNR),
    signal: numberOrNull(value.signal),
    streak, saturatedFraction, target, spots, rig,
    ra: numberOrNull(value.ra),
    dec: numberOrNull(value.dec),
  };
}
