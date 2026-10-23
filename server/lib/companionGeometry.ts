/**
 * Field-of-view maths for "which catalog objects share a frame with this one".
 *
 * Kept free of any data-file import so both the table generator
 * (scripts/build-catalog-companions.ts) and the runtime (companions.ts, which
 * reads the generated table) can use it without a circular dependency.
 */
import { isTelescopeKind, type TelescopeKind } from './types/telescopeKind.js';
import { resolveCanonicalId } from './catalogAliases.js';

/** The key the companion table is indexed by: canonical id, uppercase, no spaces. */
export function companionKey(id: string): string {
  return resolveCanonicalId(id.toUpperCase().replace(/\s+/g, '')).toUpperCase().replace(/\s+/g, '');
}

/** Largest centre-to-centre separation stored in the table. Half the shortest
 *  side of the widest supported field (S30 Pro, 2.24 deg) is 1.12 deg. */
export const MAX_COMPANION_SEP_DEG = 1.2;

/** Radius used when a host's telescope has no known fixed optics (ASIAIR,
 *  "other", or no telescope recorded). Matches the S50, the narrowest field we
 *  support, so an unknown rig only ever gets the pairs that hold everywhere. */
export const UNKNOWN_FRAME_RADIUS_DEG = 0.35;

/** Full field of view per kind, degrees. Mirrors FOV_PROFILES in
 *  src/lib/telescopeFov.ts (the two sides can't share a source without a
 *  monorepo); tests/backend/companionGeometry.test.ts fails if they drift.
 *  Kinds with no fixed optics (asiair, other) are deliberately absent. */
export const KIND_FOV_DEG: Partial<Record<TelescopeKind, { widthDeg: number; heightDeg: number }>> = {
  'seestar-s50':     { widthDeg: 1.28, heightDeg: 0.73 },
  'seestar-s50-pro': { widthDeg: 2.45, heightDeg: 1.38 },
  'seestar-s30':     { widthDeg: 2.14, heightDeg: 1.22 },
  'seestar-s30-pro': { widthDeg: 3.99, heightDeg: 2.24 },
  'dwarf-3':         { widthDeg: 2.94, heightDeg: 1.65 },
  'dwarf-2':         { widthDeg: 3.20, heightDeg: 1.80 },
  'dwarf-mini':      { widthDeg: 2.13, heightDeg: 1.20 },
};

/**
 * Radius of the circle that is inside the frame at ANY rotation, for the best
 * telescope that has imaged the host. A companion closer than this is in the
 * frame regardless of how the camera was turned. Best-of, not worst-of: if a
 * night was shot on a Dwarf 3 the companion was in that night's frame, even if
 * another night used a S50.
 */
export function frameRadiusDeg(kinds: ReadonlyArray<string | null | undefined>): number {
  let best = 0;
  for (const kind of kinds) {
    const fov = kind && isTelescopeKind(kind) ? KIND_FOV_DEG[kind] : undefined;
    if (fov) best = Math.max(best, Math.min(fov.widthDeg, fov.heightDeg) / 2);
  }
  return best > 0 ? best : UNKNOWN_FRAME_RADIUS_DEG;
}
