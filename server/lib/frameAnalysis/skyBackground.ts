/**
 * The sky's own brightness in a sub: in ADU per second above a matching dark, always, and in electrons per second
 * per pixel (and per square arcsecond when the plate scale is known) when the camera's converter depth is known, so
 * frames and nights compare across exposures, gains and optical trains, and a full Moon or a town's glow shows as what
 * it costs.
 *
 * A stored value is:
 *   (offset + dark current + sky) in the camera's own ADU, scaled up to fill 16 bits
 * so three things are taken back out:
 *   - the level of a matching dark (same camera, gain, binning and exposure, close in temperature, same offset): it
 *     holds the offset and the dark current. Without one nothing is shown: an offset guessed from the OFFSET card
 *     would be off by the camera's own scaling;
 *   - the exposure;
 *   - for electrons, the scale between the camera's ADU (what EGAIN is per) and the stored 16-bit values:
 *     2^(16 − converter bits). The step between stored values does NOT tell it: a ZWO ASI585MC (12-bit converter)
 *     stores multiples of 4, while photon transfer on its own frames gives EGAIN / 16 electrons per stored unit, not
 *     EGAIN / 4. So the depth comes from a short list of cameras whose converter is known, or from data that is plainly
 *     16-bit (every value used); otherwise electrons are left out rather than guessed.
 *
 * Nights are compared in magnitudes from the ADU rates, which needs no gain at all (same camera and settings).
 * Absolute magnitudes per square arcsecond need a photometric zero point that headers do not carry.
 */
import type { FrameMetrics, FrameSky } from './measure.js';

/** Converter depth of cameras whose EGAIN is per ADU of a converter narrower than 16 bits. */
const CONVERTER_BITS: { pattern: RegExp; bits: number }[] = [
  { pattern: /\bASI\s?(585|678|715|462|224|120|290|183|1600|482|662|664|220)/i, bits: 12 },
  { pattern: /\bASI\s?(294|071|533|2400|178)/i, bits: 14 },
  { pattern: /\bASI\s?(2600|6200|461|4300)/i, bits: 16 },
];

/** How many stored units one of the camera's own ADU is, or null when that cannot be known. */
export function storedUnitsPerAdu(camera: string | null, aduStep: number | null): number | null {
  if (camera) {
    for (const c of CONVERTER_BITS) if (c.pattern.test(camera)) return 2 ** (16 - c.bits);
  }
  // Every value used: the data is 16-bit whatever the camera.
  return aduStep === 1 ? 1 : null;
}

/** The sky background of a frame, given the level of a matching dark. Null without an exposure. */
export function skyFromDark(m: Pick<FrameMetrics, 'background' | 'rig' | 'sensor'>, darkLevel: number, darkBundle: string): FrameSky | null {
  const s = m.sensor;
  if (!s || s.exposureSec === null) return null;
  const aduPerSecond = Math.max(0, m.background - darkLevel) / s.exposureSec;
  const scale = storedUnitsPerAdu(m.rig.camera, s.aduStep);
  const electronsPerSecond = s.electronsPerAdu !== null && scale !== null ? aduPerSecond * s.electronsPerAdu / scale : null;
  // The rig's scale is per grid pixel; a binned grid pixel is `binning` sensor pixels on a side.
  const arcsecPerPixel = m.rig.scale !== null ? m.rig.scale / s.binning : null;
  return {
    aduPerSecond: round(aduPerSecond, 4),
    electronsPerSecond: electronsPerSecond !== null ? round(electronsPerSecond, 4) : null,
    electronsPerSecondPerArcsec2: electronsPerSecond !== null && arcsecPerPixel ? round(electronsPerSecond / (arcsecPerPixel * arcsecPerPixel), 5) : null,
    darkLevel: round(darkLevel, 2),
    darkBundle,
  };
}

/** How much brighter one sky is than another, in magnitudes (positive: brighter). */
export function magnitudesBrighter(sky: number, reference: number): number | null {
  if (!(sky > 0) || !(reference > 0)) return null;
  return round(2.5 * Math.log10(sky / reference), 2);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
