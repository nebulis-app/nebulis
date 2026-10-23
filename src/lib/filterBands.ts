/**
 * Broadband or narrowband: for an object type (what it is usually shot
 * through) and for a filter name (what a filter is).
 *
 * The object rule follows src/lib/filterRecommendations.ts: the types it
 * recommends "Ha or dual narrowband" for on a colour camera (emission,
 * planetary and supernova-remnant nebulae, nebulae in clusters, generic
 * nebulae) are narrowband targets; galaxies, star clusters, reflection and
 * dark nebulae are broadband. Mirrored in server/lib/filterBands.ts.
 */
import type { FilterBand } from './moonProximity';

/** Ordered: the first matching rule wins, like filterRecommendations.ts. */
const TYPE_RULES: readonly { match: readonly string[]; all?: boolean; band: FilterBand }[] = [
  { match: ['emission', 'reflection'], all: true, band: 'narrowband' },
  { match: ['cluster', 'nebula'], all: true, band: 'narrowband' },
  { match: ['emission'], band: 'narrowband' },
  { match: ['reflection'], band: 'broadband' },
  { match: ['planetary'], band: 'narrowband' },
  { match: ['supernova'], band: 'narrowband' },
  { match: ['dark'], band: 'broadband' },
  { match: ['nebula'], band: 'narrowband' },
];

export function bandForObjectType(type: string | null | undefined): FilterBand {
  const t = (type ?? '').toLowerCase();
  for (const rule of TYPE_RULES) {
    const hit = rule.all ? rule.match.every(m => t.includes(m)) : rule.match.some(m => t.includes(m));
    if (hit) return rule.band;
  }
  return 'broadband';
}

/** Whole-token names of narrowband filters: lines (Ha, OIII, SII, Hb, NII),
 *  their short forms, multi-band words and common dual-band products
 *  (Askar Colour Magic D1/D2, Optolong L-eXtreme / L-Ultimate / L-Enhance,
 *  Antlia ALP-T, IDAS NBZ). */
const NARROWBAND_TOKENS = new Set([
  'h', 'ha', 'halpha', 'hα', 'hb', 'hbeta', 'oiii', 'o3', 'sii', 's2', 'nii', 'n2',
  'nb', 'narrowband', 'dual', 'duo', 'dualband', 'duoband', 'tri', 'triband', 'quad', 'quadband',
  'd1', 'd2', 'lextreme', 'lultimate', 'lenhance', 'alpt', 'nbz', 'sho', 'hoo',
]);

/** Band of a filter by its name; null when the name says nothing (no filter,
 *  or a label the list above does not know). */
export function bandForFilterName(name: string | null | undefined): FilterBand | null {
  if (!name) return null;
  const raw = name.toLowerCase();
  // "L-eXtreme" → "lextreme"; "Ha 7nm" → "ha", "7nm"; "SII/OIII" → "sii", "oiii".
  const tokens = raw.split(/[\s/_,+()]+/).map(t => t.replace(/[-.]/g, '')).filter(Boolean);
  if (tokens.some(t => NARROWBAND_TOKENS.has(t) || /^\d+(\.\d+)?nm$/.test(t))) return 'narrowband';
  if (tokens.some(t => ['l', 'lum', 'luminance', 'r', 'g', 'b', 'rgb', 'lrgb', 'uvir', 'uv', 'ir', 'ircut', 'clear', 'cls', 'lpro'].includes(t))) {
    return 'broadband';
  }
  return null;
}
