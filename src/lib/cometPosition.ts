/**
 * Where a comet or asteroid is at a given moment, from the hourly rows the planner received
 * (GET /planner/comets, `tonight`). Mirrors positionAt in server/lib/horizons.ts: linear between the two rows around
 * the instant, the short way round RA 0h.
 */
import type { EphemerisRow } from './api/planner';

export function positionAt(rows: readonly EphemerisRow[], at: Date): { ra: number; dec: number } | null {
  const t = at.getTime();
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = new Date(rows[i].t).getTime();
    const b = new Date(rows[i + 1].t).getTime();
    if (t < a || t > b) continue;
    const f = b === a ? 0 : (t - a) / (b - a);
    let dRa = rows[i + 1].ra - rows[i].ra;
    if (dRa > 12) dRa -= 24;
    if (dRa < -12) dRa += 24;
    return { ra: (rows[i].ra + f * dRa + 24) % 24, dec: rows[i].dec + f * (rows[i + 1].dec - rows[i].dec) };
  }
  return null;
}

/** A block's object placed where a moving body is at the block's middle; anything else, or a time outside the rows, unchanged. */
export function placeMovingBody<T extends { objectId: string; ra: number; dec: number; startTime: string; endTime: string }>(
  block: T,
  rowsById: ReadonlyMap<string, readonly EphemerisRow[]>,
): T {
  const rows = rowsById.get(block.objectId);
  if (!rows || rows.length === 0) return block;
  const middle = new Date((new Date(block.startTime).getTime() + new Date(block.endTime).getTime()) / 2);
  const pos = positionAt(rows, middle);
  return pos ? { ...block, ra: pos.ra, dec: pos.dec } : block;
}
