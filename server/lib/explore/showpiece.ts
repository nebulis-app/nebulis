/**
 * "Showpiece" score: a static, location-independent measure of how
 * rewarding an object is to photograph with a small telescope. Location is
 * applied separately (visibility.ts), so ranking and visibility stay
 * independent.
 *
 * Computed once at first use from data already in the catalog; there is no
 * generated file to keep in sync. Weights were tuned by eye against a
 * known-good list (see tests/backend/explore.test.ts).
 */
import { getPlannerCatalog, designationsFor, type DsoEntry } from '../dsoCatalog.js';
import { getCuratedRecord } from '../catalogStore.js';
import { resolveCanonicalId } from '../catalogAliases.js';

/** Hand-picked "if you only shoot a hundred things" list, balanced across the sky: roughly as many objects that are well placed from
 *  the southern hemisphere as from the northern, with the equatorial ones counting for both. It used to be northern-skewed (41
 *  objects north of +20 degrees, 10 south of -20), which left a Sydney observer 43 of 67. Ids are resolved through the alias index,
 *  so "NGC1976" and "M42" are one entry; unknown ids are skipped rather than failing. */
export const SHOWPIECE_BOOSTS: readonly string[] = [
  'M31', 'M33', 'M42', 'M45', 'M1', 'M8', 'M13', 'M16', 'M17', 'M20', 'M27', 'M51', 'M57', 'M63', 'M64',
  'M66', 'M81', 'M82', 'M97', 'M101', 'M104', 'M106', 'M3', 'M5', 'M22', 'M78', 'NGC7000', 'IC5070',
  'NGC6992', 'NGC2237', 'NGC2244', 'NGC1499', 'B33', 'NGC2024', 'IC405', 'IC410', 'NGC7293', 'NGC891',
  'NGC253', 'NGC4565', 'NGC5139', 'NGC3372', 'NGC6888', 'IC1805', 'IC1848', 'NGC281', 'NGC7635', 'NGC6946',
  'NGC4631', 'NGC2392', 'NGC3628', 'NGC6543', 'NGC7331', 'IC1396', 'NGC6188', 'NGC3576', 'NGC2070',
  'NGC4258', 'NGC6826', 'NGC2359', 'NGC1333', 'ESO56-115', 'NGC292', 'NGC104', 'NGC3532', 'NGC4755',
  'IC2944', 'NGC5128', 'NGC3766', 'NGC6231', 'NGC6334', 'NGC6357', 'IC4628', 'IC4592', 'M4', 'M6', 'M7',
  'NGC6752', 'NGC6397', 'NGC2808', 'M83', 'NGC55', 'NGC300', 'NGC1365', 'NGC1097', 'NGC4945', 'NGC6744',
  'NGC1316', 'NGC4038',
];

const canon = (id: string) => resolveCanonicalId(id).toUpperCase().replace(/\s+/g, '');

let boostSet: Set<string> | null = null;
function boosts(): Set<string> {
  if (!boostSet) boostSet = new Set(SHOWPIECE_BOOSTS.map(canon));
  return boostSet;
}

/** Whether an entry is on the hand-picked list. */
export function isBoosted(entry: DsoEntry): boolean {
  return boosts().has(canon(entry.id));
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

/** Pure scoring function; exported for tests. Roughly 0-130; higher is better. */
export function computeShowpieceScore(entry: DsoEntry, aliases: readonly string[]): number {
  const size = entry.majorAxisArcmin;
  const mag = entry.magnitude;

  // Brightness: mag 4 -> 1.0, mag 13 -> 0. Unknown is a weak middle.
  const magTerm = mag == null ? 0.15 : clamp01((13 - mag) / 9);

  // Size: sub-arcminute targets are specks in a small scope; a few degrees is
  // more than the field holds. Ramp up to 6', flat to 120', soft decline after.
  let sizeTerm = 0;
  if (size != null && size >= 1) {
    if (size < 6) sizeTerm = (size - 1) / 5;
    else if (size <= 120) sizeTerm = 1;
    else sizeTerm = Math.max(0.5, 1 - (size - 120) / 600);
  }

  // Surface brightness (mag per arcmin^2): a big faint smudge should lose to
  // a smaller, punchier object of the same total magnitude.
  let sbTerm = 0.3;
  if (mag != null && size != null && size > 0) {
    const sb = mag + 2.5 * Math.log10((Math.PI / 4) * size * size);
    sbTerm = clamp01((17 - sb) / 5);
  }

  let score = magTerm * 30 + sizeTerm * 25 + sbTerm * 15;

  const named = entry.commonNames.length > 0 || (entry.name !== entry.id && !/^(NGC|IC)\s?\d+$/i.test(entry.name));
  if (named) score += 8;
  if (entry.messier != null) score += 14;
  if (aliases.some(a => /^C\d+$/i.test(a))) score += 7;
  const curated = getCuratedRecord(entry.id);
  if (curated) score += curated.description ? 8 : 4;
  if (isBoosted(entry)) score += 30;

  // Deliberately not capped at 100: boosted and Messier objects would all tie
  // there and lose their relative order. Only the ordering matters to callers.
  return Math.round(score * 10) / 10;
}

let scores: Map<string, number> | null = null;

function scoreIndex(): Map<string, number> {
  if (!scores) {
    scores = new Map();
    for (const entry of getPlannerCatalog()) {
      scores.set(entry.id, computeShowpieceScore(entry, designationsFor(entry)));
    }
  }
  return scores;
}

/** 0-100, or 0 for an id the catalog doesn't know. */
export function showpieceScore(entry: DsoEntry): number {
  return scoreIndex().get(entry.id) ?? computeShowpieceScore(entry, designationsFor(entry));
}

/** The Showpieces tile is the hand-picked list, not a score cutoff: a cutoff
 *  would grow to hundreds of Messier/NGC objects and stop being a short list. */
export function isShowpiece(entry: DsoEntry): boolean {
  return isBoosted(entry);
}
