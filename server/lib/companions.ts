/**
 * Catalog companions: objects that share a frame with another object.
 *
 * Imaging M42 also captures M43; imaging M51 also captures NGC 5195. The pairs
 * are precomputed from catalog coordinates into server/data/catalog-companions.json
 * (scripts/build-catalog-companions.ts), so there is no plate solving or per-night
 * geometry at runtime. See companionGeometry.ts for the field-of-view rule.
 *
 * All ids here are canonical (resolveCanonicalId), uppercase, no spaces: the
 * same form catalogs.ts keys its boards by.
 */
import table from '../data/catalog-companions.json';
import { frameRadiusDeg } from './companionGeometry.js';
import { isRecord } from './typeGuards.js';

type CompanionPairs = Record<string, Array<[string, number]>>;

/**
 * Read the `pairs` map out of the bundled JSON, checking every member tuple.
 *
 * TypeScript infers the JSON import's `pairs` as an object of `(string | number)[][]`,
 * which is not the `[id, sepDeg]` tuple shape the rest of this module reads. Rather
 * than assert the shape, each entry is checked: a malformed member (wrong arity or
 * types) is dropped instead of becoming `undefined`/NaN at lookup time. The build
 * script only ever writes well-formed tuples, so on the shipped file this keeps
 * every entry.
 */
function parseCompanionPairs(raw: unknown): CompanionPairs {
  const out: CompanionPairs = {};
  if (!isRecord(raw) || !isRecord(raw.pairs)) return out;
  for (const [hostId, members] of Object.entries(raw.pairs)) {
    if (!Array.isArray(members)) continue;
    // Array.isArray narrows `unknown` to `any[]`; re-widen so every element is checked.
    const memberList: readonly unknown[] = members;
    const list: Array<[string, number]> = [];
    for (const member of memberList) {
      if (!Array.isArray(member)) continue;
      const tuple: readonly unknown[] = member;
      const memberId = tuple[0];
      const sepDeg = tuple[1];
      if (typeof memberId === 'string' && typeof sepDeg === 'number') list.push([memberId, sepDeg]);
    }
    out[hostId] = list;
  }
  return out;
}

const PAIRS: CompanionPairs = parseCompanionPairs(table);

export interface HostLink { hostId: string; sepDeg: number }

/** member canonical id -> the hosts whose frame it can fall in (closest first). */
const HOSTS_OF: Map<string, HostLink[]> = (() => {
  const m = new Map<string, HostLink[]>();
  for (const [hostId, members] of Object.entries(PAIRS)) {
    for (const [memberId, sepDeg] of members) {
      const list = m.get(memberId);
      if (list) list.push({ hostId, sepDeg });
      else m.set(memberId, [{ hostId, sepDeg }]);
    }
  }
  for (const list of m.values()) list.sort((a, b) => a.sepDeg - b.sepDeg);
  return m;
})();

/** Companions of a host (canonical id), closest first. Empty if it has none. */
export function companionsOf(hostId: string): Array<{ id: string; sepDeg: number }> {
  return (PAIRS[hostId] ?? []).map(([id, sepDeg]) => ({ id, sepDeg }));
}

/** Hosts whose frame can contain `memberId` (canonical), closest first. */
export function hostsOf(memberId: string): HostLink[] {
  return HOSTS_OF.get(memberId) ?? [];
}

/** Companions of a host that are actually in its frame, given the telescope kinds that imaged it. */
export function companionsInFrame(hostId: string, telescopeKinds: ReadonlyArray<string | null | undefined>): Array<{ id: string; sepDeg: number }> {
  const radius = frameRadiusDeg(telescopeKinds);
  return companionsOf(hostId).filter(c => c.sepDeg <= radius);
}
