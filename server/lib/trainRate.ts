/**
 * What one telescope really gathers in a night, and which filters it can shoot, for optics-aware planning.
 *
 * - The night rate: the light subs this telescope brought into the library, summed per observing night, and the
 *   median of those nights. A median rather than a mean, so the odd short night (clouds at midnight) or long winter
 *   night does not swing it.
 * - The kept ratio: of the subs reviewed in Frame Analysis (keep or reject recorded), the share kept. Only reported
 *   past `MIN_REVIEWED` reviews; before that one bad night would decide it.
 *
 * Both come from what is already in the database (no file is read here): sub exposure from the header cache the
 * integration totals fill, else the exposure in the file name.
 */
import db from './db.js';
import { listGear, hasNarrowbandCapableFilter } from './gear.js';
import { bandForFilterName } from './filterBands.js';
import { getRig, getUsedFilterNames } from './telescopeRig.js';
import { sessionDateForRow } from './library/libraryFiles.js';
import { parseFilename } from './telescopeFiles.js';

/** Fewer nights than this and there is no rate to speak of. */
export const MIN_NIGHTS = 2;
/** Fewer reviewed subs than this and the kept ratio is not reported. */
export const MIN_REVIEWED = 20;

export interface TelescopeNightRate {
  telescopeId: string;
  /** Observing nights with at least one sub from this telescope. */
  nights: number;
  /** Median seconds of light subs per night, or null below MIN_NIGHTS. */
  medianNightSec: number | null;
  /** Subs reviewed in Frame Analysis (kept or rejected). */
  reviewedFrames: number;
  /** Share of reviewed subs kept, or null below MIN_REVIEWED. */
  keptRatio: number | null;
}

interface SubRow {
  fileName: string;
  captureDate: string | null;
  captureTime: string | null;
  sessionDateOverride: string | null;
  sourceId: string | null;
  exposureSec: number | null;
  keep: number | null;
}

const subsStmt = db.prepare<[string], SubRow>(
  `SELECT lf.fileName, lf.captureDate, lf.captureTime, lf.sessionDateOverride, lf.sourceId,
          h.exposureSec AS exposureSec, fr.keep AS keep
     FROM libraryFiles lf
     LEFT JOIN subFrameHeaderCache h ON h.relPath = lf.relPath
     LEFT JOIN frameReview fr ON fr.relPath = lf.relPath
    WHERE lf.telescopeId = ? AND lf.role = 'sub'`,
);

function exposureOf(row: SubRow): number | null {
  if (typeof row.exposureSec === 'number' && row.exposureSec > 0) return row.exposureSec;
  const fromName = Number.parseFloat(parseFilename(row.fileName).exposure ?? '');
  return Number.isFinite(fromName) && fromName > 0 ? fromName : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function getTelescopeNightRate(telescopeId: string): TelescopeNightRate {
  const perNight = new Map<string, number>();
  let reviewed = 0;
  let kept = 0;
  for (const row of subsStmt.all(telescopeId)) {
    if (row.keep !== null) {
      reviewed++;
      if (row.keep) kept++;
    }
    const night = sessionDateForRow(row);
    const exposure = exposureOf(row);
    if (!night || exposure === null) continue;
    perNight.set(night, (perNight.get(night) ?? 0) + exposure);
  }
  const nights = perNight.size;
  return {
    telescopeId,
    nights,
    medianNightSec: nights >= MIN_NIGHTS ? Math.round(median([...perNight.values()])!) : null,
    reviewedFrames: reviewed,
    keptRatio: reviewed >= MIN_REVIEWED ? kept / reviewed : null,
  };
}

/**
 * Whether this telescope can shoot narrowband: a dual-, tri- or narrowband filter in Gear assigned to it, or a
 * narrowband name among the filters its rig lists or it has shot through. A telescope nothing is known about falls
 * back to the whole Gear inventory, as the planner did before it knew which telescope would shoot.
 */
export function narrowbandCapableFor(telescopeId: string): boolean {
  const gearFilters = listGear().filter(g => g.kind === 'filter' && g.telescopeId === telescopeId && !g.archivedAt);
  const names = [...getRig(telescopeId).filters, ...getUsedFilterNames(telescopeId, 50)];
  if (gearFilters.length === 0 && names.length === 0) return hasNarrowbandCapableFilter();
  return gearFilters.some(g => g.specs.type === 'dualBand' || g.specs.type === 'triBand' || g.specs.type === 'narrowband')
    || names.some(n => bandForFilterName(n) === 'narrowband');
}
