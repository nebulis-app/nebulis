/**
 * How many more nights an object's integration goals need on a given telescope.
 *
 * The time left on every filter, divided by what that telescope usefully gathers in a night: the median of its
 * nights of light subs, times the share it keeps after review. Goal progress counts every sub, kept or not, so the
 * kept ratio is what turns "time shot" into "time that will end up in the stack". Rounded up: a goal 20 minutes
 * short still needs a night out.
 */
import type { ObjectIntegrationProgress } from './api/library';
import type { TelescopeNightRate } from './api/telescopes';

export interface NightsNeeded {
  nights: number;
  /** Seconds of kept subs a night, the divisor. */
  usableNightSec: number;
}

export function nightsNeeded(progress: ObjectIntegrationProgress, rate: TelescopeNightRate | null | undefined): NightsNeeded | null {
  if (!rate || rate.medianNightSec == null || rate.medianNightSec <= 0 || progress.complete) return null;
  const leftSec = progress.filters.reduce((sum, f) => sum + Math.max(0, f.remainingSec), 0);
  if (leftSec <= 0) return null;
  const usableNightSec = rate.medianNightSec * (rate.keptRatio ?? 1);
  if (usableNightSec <= 0) return null;
  return { nights: Math.ceil(leftSec / usableNightSec), usableNightSec };
}
