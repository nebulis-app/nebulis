/**
 * Sharpless HII region catalog — 313 emission nebulae from the 1959 Sharpless catalog.
 *
 * Static data built by scripts/build-sharpless-catalog.ts (run to refresh).
 * Provides ID lookup and conversion to CatalogEntry for the lookup chain in
 * server/data/catalog.ts. Raw entries (with their NGC/Messier cross-refs)
 * are also exported for scripting / pack-building — see build-catalog-pack.ts.
 */

import type { CatalogEntry } from './types/catalog.js';
import sharplessJson from '../data/sharpless.json';
import { isRecord } from './typeGuards.js';

interface SharplessEntry {
  id: string;
  raDeg: number;
  decDeg: number;
  sizeArcmin: number;
  commonName: string | null;
  ngcRef: string | null;    // e.g. "NGC6302" (no space)
  messierRef: string | null; // e.g. "M8"
}

function isSharplessEntry(value: unknown): value is SharplessEntry {
  if (!isRecord(value)) return false;
  const nullableString = (v: unknown) => v === null || typeof v === 'string';
  return (
    typeof value.id === 'string' &&
    typeof value.raDeg === 'number' &&
    typeof value.decDeg === 'number' &&
    typeof value.sizeArcmin === 'number' &&
    nullableString(value.commonName) &&
    nullableString(value.ngcRef) &&
    nullableString(value.messierRef)
  );
}

/**
 * Validate the generated JSON at load rather than asserting it. 313 entries,
 * so the check is free, and a bad refresh run from
 * scripts/build-sharpless-catalog.ts shows up as a startup warning instead of
 * NaN coordinates reaching the sky map.
 */
function parseSharplessJson(data: unknown): SharplessEntry[] {
  if (!Array.isArray(data)) {
    throw new Error('[sharpless] sharpless.json: expected top-level array');
  }
  const entries = data.filter(isSharplessEntry);
  if (data.length > 0 && entries.length === 0) {
    throw new Error('[sharpless] sharpless.json: no entries matched the expected shape');
  }
  if (entries.length < data.length) {
    console.warn(`[sharpless] dropped ${data.length - entries.length} entr(ies) that did not match SharplessEntry`);
  }
  return entries;
}

const sharplessData = parseSharplessJson(sharplessJson);

// Primary key: "SH2-25" (uppercase, no spaces)
const byId = new Map<string, SharplessEntry>();

for (const entry of sharplessData) {
  byId.set(entry.id.toUpperCase().replace(/\s+/g, ''), entry);
}

console.log(`[sharpless] Loaded ${sharplessData.length} Sharpless entries`);

/** Raw entry for scripting / pack-building. */
export const SHARPLESS_CATALOG: readonly SharplessEntry[] = sharplessData;

/**
 * Look up a Sharpless entry by its Sh2-N designation (case-insensitive,
 * space-tolerant: "Sh2-25", "SH2-25", "Sh 2-25" all work).
 */
export function getSharplessEntry(id: string): SharplessEntry | undefined {
  return byId.get(id.toUpperCase().replace(/\s+/g, ''));
}

/**
 * Convert a SharplessEntry to a CatalogEntry for the catalog lookup chain.
 * RA/Dec are stored as decimal degree strings matching how catalog.ts stores
 * OpenNGC coords (raToDegs/decToDegs can parse plain decimal strings).
 */
export function sharplessToCatalogEntry(
  entry: SharplessEntry,
  requestedId: string,
): CatalogEntry {
  return {
    id: requestedId,
    name: entry.commonName ?? requestedId,
    type: 'Emission Nebula',
    constellation: '',
    description: '',
    ra: String(entry.raDeg),
    dec: String(entry.decDeg),
    majorAxisArcmin: entry.sizeArcmin > 0 ? entry.sizeArcmin : null,
  };
}
