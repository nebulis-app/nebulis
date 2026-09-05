#!/usr/bin/env tsx
/**
 * Step 6 of the catalog consolidation: generate the bundled
 * deep_sky_distances.json the iOS / tvOS / Android clients use as an offline
 * distance fallback, straight from the one catalog store, and write the same
 * bytes to all three client copies so they cannot drift (today the tvOS copy
 * already differs from the other two).
 *
 * Shape the clients expect (see DeepSkyDistanceCatalog.swift / DeepSkyCatalog.kt):
 *   { "<catalogId>": { "distance_kpc": number, "extragalactic"?: boolean } }
 * Distance is kiloparsecs; the clients multiply by 3261.56 to get light-years.
 *
 *   npx tsx scripts/build-client-distances.ts            # write
 *   npx tsx scripts/build-client-distances.ts --check    # CI: fail if stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAllCuratedRecords } from '../server/lib/catalogStore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGETS = [
  'nebulis-apple/NebulisIOS/Resources/deep_sky_distances.json',
  'nebulis-apple/NebulisTV/Resources/deep_sky_distances.json',
  'nebulis-android/app/src/main/assets/deep_sky_distances.json',
].map(p => path.join(ROOT, p));

const LY_PER_KPC = 3261.56;
const CHECK = process.argv.includes('--check');

interface DistanceEntry { distance_kpc: number; extragalactic?: boolean }

function isExtragalactic(type: string): boolean {
  return /galax/i.test(type) || /\b(quasar|agn)\b/i.test(type);
}

// Round to 3 significant figures — the source distances are themselves
// approximate and the clients only use this for a rough "X light-years" label.
function sig3(n: number): number {
  if (n === 0) return 0;
  return Number(n.toPrecision(3));
}

const out: Record<string, DistanceEntry> = {};
let fromStore = 0;
for (const record of getAllCuratedRecords()) {
  if (record.distanceLy == null || record.distanceLy <= 0) continue;
  const entry: DistanceEntry = { distance_kpc: sig3(record.distanceLy / LY_PER_KPC) };
  if (isExtragalactic(record.type)) entry.extragalactic = true;
  for (const key of new Set([record.canonicalId, ...record.designations])) {
    if (!(key in out)) { out[key] = entry; if (key === record.canonicalId) fromStore++; }
  }
}

// Keep any key the previous hand-maintained file had that the store does not
// cover yet, so this never regresses coverage. Read from the iOS copy (the
// canonical one of the three today).
let carried = 0;
try {
  const prev: Record<string, DistanceEntry> = JSON.parse(fs.readFileSync(TARGETS[0], 'utf8'));
  for (const [key, value] of Object.entries(prev)) {
    const norm = key.toUpperCase().replace(/\s+/g, '');
    if (!(key in out) && !(norm in out)) { out[key] = value; carried++; }
  }
} catch {
  /* first run, or file missing */
}

const sorted = Object.fromEntries(
  Object.entries(out).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
);
const json = JSON.stringify(sorted, null, 2) + '\n';

console.log(`[distances] ${Object.keys(sorted).length} keys (${fromStore} objects from store, ${carried} carried from the old file)`);

if (CHECK) {
  let stale = false;
  for (const target of TARGETS) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== json) { console.error(`STALE: ${path.relative(ROOT, target)}`); stale = true; }
  }
  if (stale) { console.error('Run: npx tsx scripts/build-client-distances.ts'); process.exit(1); }
  console.log('[distances] all three client copies are current');
} else {
  for (const target of TARGETS) {
    fs.writeFileSync(target, json);
    console.log(`  wrote ${path.relative(ROOT, target)}`);
  }
}
