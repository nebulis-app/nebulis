/**
 * Sharpless HII region catalog — 313 emission nebulae from the 1959 Sharpless catalog.
 *
 * Static data built by scripts/build-sharpless-catalog.ts (run to refresh).
 * Provides ID lookup, cross-references to NGC/Messier, and conversion to
 * CatalogEntry for the lookup chain in server/data/catalog.ts.
 */

import type { CatalogEntry } from './types/catalog.js';
import sharplessJson from '../data/sharpless.json';

interface SharplessEntry {
  id: string;
  raDeg: number;
  decDeg: number;
  sizeArcmin: number;
  commonName: string | null;
  ngcRef: string | null;    // e.g. "NGC6302" (no space)
  messierRef: string | null; // e.g. "M8"
}

const sharplessData = sharplessJson as SharplessEntry[];

// Primary key: "SH2-25" (uppercase, no spaces)
const byId = new Map<string, SharplessEntry>();
// Cross-ref: "NGC6302" → "Sh2-6", "M8" → "Sh2-25"
const ngcToSh2 = new Map<string, string>();
const messierToSh2 = new Map<string, string>();

for (const entry of sharplessData) {
  byId.set(entry.id.toUpperCase().replace(/\s+/g, ''), entry);
  if (entry.ngcRef)     ngcToSh2.set(entry.ngcRef.toUpperCase(), entry.id);
  if (entry.messierRef) messierToSh2.set(entry.messierRef.toUpperCase(), entry.id);
}

console.log(`[sharpless] Loaded ${sharplessData.length} Sharpless entries`);

/** All canonical Sharpless IDs in catalog number order. */
export const SHARPLESS_IDS: ReadonlySet<string> = new Set(sharplessData.map(e => e.id));

/** Raw entry for scripting / pack-building. */
export const SHARPLESS_CATALOG: readonly SharplessEntry[] = sharplessData;

/**
 * Look up a Sharpless entry by its Sh2-N designation (case-insensitive,
 * space-tolerant: "Sh2-25", "SH2-25", "Sh 2-25" all work).
 */
export function getSharplessEntry(id: string): SharplessEntry | undefined {
  return byId.get(id.toUpperCase().replace(/\s+/g, ''));
}

/** Returns the Sh2-N ID (e.g. "Sh2-6") for a given NGC/IC catalog ID, or undefined. */
export function getSharplessByNgc(ngcId: string): string | undefined {
  return ngcToSh2.get(ngcId.toUpperCase().replace(/\s+/g, ''));
}

/** Returns the Sh2-N ID for a given Messier ID, or undefined. */
export function getSharplessByMessier(mId: string): string | undefined {
  return messierToSh2.get(mId.toUpperCase().replace(/\s+/g, ''));
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
