/**
 * Which filter to shoot an object through on a given block: the one with
 * the most integration time left toward its goal (integration goals, see
 * server/lib/library/integration.ts), among the filters the Moon allows.
 *
 * The Moon allows every filter when the block clears the broadband
 * threshold; otherwise only narrowband filters (by name, see filterBands.ts).
 * A filter whose name says nothing about its band is treated as broadband,
 * the cautious reading.
 */
import type { FilterRemaining, ObjectIntegrationProgress } from './api/library';
import { bandForFilterName } from './filterBands';
import { moonThresholdForIllumination, moonVerdictFor, type FilterBand } from './moonProximity';

export interface FilterSuggestion {
  /** Canonical filter name; null = the "no filter" goal. */
  filter: string | null;
  remainingSec: number;
  band: FilterBand;
  /** Filters with time left that the Moon rules out for this block. */
  ruledOutByMoon: FilterRemaining[];
}

export function suggestFilter(
  progress: ObjectIntegrationProgress | undefined,
  moon: { minSeparation: number; illumination: number },
): FilterSuggestion | null {
  if (!progress) return null;
  const left = progress.filters.filter(f => f.remainingSec > 0);
  if (left.length === 0) return null;

  const broadbandOk = moonVerdictFor(moon.minSeparation, moonThresholdForIllumination(moon.illumination, 'broadband')) === 'ok';
  const bandOf = (f: FilterRemaining): FilterBand => bandForFilterName(f.filter) ?? 'broadband';
  const allowed = broadbandOk ? left : left.filter(f => bandOf(f) === 'narrowband');
  const ruledOutByMoon = broadbandOk ? [] : left.filter(f => bandOf(f) !== 'narrowband');
  if (allowed.length === 0) return null;

  const best = allowed.reduce((a, b) => (b.remainingSec > a.remainingSec ? b : a));
  return { filter: best.filter, remainingSec: best.remainingSec, band: bandOf(best), ruledOutByMoon };
}
