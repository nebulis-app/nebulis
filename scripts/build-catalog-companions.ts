#!/usr/bin/env tsx
/**
 * Generate server/data/catalog-companions.json: for every catalog object, the
 * catalog-board objects that sit close enough to share its frame, with the
 * centre-to-centre separation in degrees.
 *
 * Why a fixed table instead of plate solving: a user who points at M42 and
 * centres it gets M43 in the same frame on every telescope we support, and the
 * answer depends only on the angular separation and the telescope's field of
 * view. Both are known ahead of time. The runtime (server/lib/companions.ts)
 * does one lookup per host object and compares `sepDeg` against half of that
 * telescope's short side.
 *
 * Assumes the host is centred in the frame and that the frame's rotation is
 * unknown, so a companion counts only if it is inside the inscribed circle
 * (radius = short side / 2). That is why the table stores a distance, not a
 * yes/no: the same pair is in frame on a Dwarf 3 and out of frame on a S50.
 *
 *   npx tsx scripts/build-catalog-companions.ts            # write
 *   npx tsx scripts/build-catalog-companions.ts --check    # CI: fail if stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LISTED_ROWS } from '../server/lib/dsoCatalogData.js';
import { getAllCatalogEntries, getCatalogEntry } from '../server/data/catalog.js';
import { HERSCHEL400_IDS } from '../server/lib/herschel400Catalog.js';
import { SHARPLESS_CATALOG } from '../server/lib/sharplessCatalog.js';
import { raToHours, decToDegs } from '../server/lib/astroCalc.js';
import { MAX_COMPANION_SEP_DEG, KIND_FOV_DEG, companionKey } from '../server/lib/companionGeometry.js';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data');
const OUT = path.join(DATA_DIR, 'catalog-companions.json');
const REVIEW_OUT = path.join(DATA_DIR, 'catalog-companions.review.md');
const CHECK = process.argv.includes('--check');
const RAD = Math.PI / 180;

interface Point { id: string; ra: number; dec: number; name?: string }

function pointFor(id: string): Point | null {
  // Position of the canonical object, as the Sharpless board does (catalogs.ts):
  // Sh2-1 and IC1470 are one object and must not get a position that depends on
  // which of the two this loop happened to reach first.
  const entry = getCatalogEntry(companionKey(id)) ?? getCatalogEntry(id);
  if (!entry || entry.ra == null || entry.dec == null) return null;
  const raDeg = raToHours(entry.ra) * 15;
  const dec = decToDegs(entry.dec);
  if (!Number.isFinite(raDeg) || !Number.isFinite(dec) || raDeg < 0 || raDeg > 360) return null;
  return { id: companionKey(id), ra: raDeg, dec, name: entry.name };
}

/** Great-circle separation in degrees (haversine, stable for tiny angles). */
function separationDeg(a: Point, b: Point): number {
  const dRa = (a.ra - b.ra) * RAD;
  const dDec = (a.dec - b.dec) * RAD;
  const h = Math.sin(dDec / 2) ** 2 + Math.cos(a.dec * RAD) * Math.cos(b.dec * RAD) * Math.sin(dRa / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / RAD;
}

function boardIds(): string[] {
  const ids: string[] = [];
  for (let n = 1; n <= 110; n++) ids.push(`M${n}`);
  for (let n = 1; n <= 109; n++) ids.push(`C${n}`);
  ids.push(...HERSCHEL400_IDS);
  ids.push(...SHARPLESS_CATALOG.map(e => e.id));
  return ids;
}

function allIds(): string[] {
  const ids = new Set<string>(boardIds());
  for (const row of LISTED_ROWS) ids.add(row.id);
  for (const e of getAllCatalogEntries()) ids.add(e.id);
  return [...ids];
}

function collect(ids: string[]): Map<string, Point> {
  const byCanon = new Map<string, Point>();
  for (const id of ids) {
    const p = pointFor(id);
    if (p && !byCanon.has(p.id)) byCanon.set(p.id, p);
  }
  return byCanon;
}

const members = collect(boardIds());
const hosts = collect(allIds());

const pairs: Record<string, Array<[string, number]>> = {};
let pairCount = 0;
for (const host of hosts.values()) {
  const found: Array<[string, number]> = [];
  for (const member of members.values()) {
    if (member.id === host.id) continue; // an alias of the host is the same object, not a companion
    const sep = separationDeg(host, member);
    if (sep <= MAX_COMPANION_SEP_DEG) found.push([member.id, Math.round(sep * 100) / 100]);
  }
  if (found.length === 0) continue;
  found.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'en', { numeric: true }));
  pairs[host.id] = found;
  pairCount += found.length;
}

const sortedPairs = Object.fromEntries(
  Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
);
const json = JSON.stringify({ version: 1, maxSepDeg: MAX_COMPANION_SEP_DEG, pairs: sortedPairs }, null, 1) + '\n';

/** Telescope kinds whose any-rotation radius (short side / 2) reaches `sepDeg`. */
function kindsThatFit(sepDeg: number): string {
  const fits = Object.entries(KIND_FOV_DEG)
    .filter(([, f]) => Math.min(f.widthDeg, f.heightDeg) / 2 >= sepDeg)
    .map(([kind]) => kind);
  const all = Object.keys(KIND_FOV_DEG).length;
  if (fits.length === all) return 'all';
  return fits.length ? fits.join(', ') : 'none';
}

function reviewMarkdown(): string {
  const lines = [
    '# Catalog companions (generated, do not edit)',
    '',
    'Generated by `scripts/build-catalog-companions.ts` from catalog coordinates. Each row says: if you image **host**,',
    'the **companion** (a catalog-board object) is also inside the frame, as long as the host is roughly centred.',
    '`Sep` is the centre-to-centre distance in degrees. `Fits on` lists the telescopes whose frame still contains the',
    'companion at any rotation (frame short side / 2 >= Sep). Telescopes with no fixed optics (ASIAIR, other) get only',
    `pairs that fit on every listed telescope (radius ${Math.min(...Object.values(KIND_FOV_DEG).map(f => Math.min(f.widthDeg, f.heightDeg) / 2)).toFixed(2)} deg or less).`,
    '',
    '| Host | Companion | Sep (deg) | Fits on |',
    '|---|---|---|---|',
  ];
  for (const [hostId, list] of Object.entries(sortedPairs)) {
    const hostName = hosts.get(hostId)?.name;
    for (const [memberId, sep] of list) {
      const memberName = members.get(memberId)?.name;
      const label = (id: string, name?: string) => (name && name.toUpperCase().replace(/\s+/g, '') !== id ? `${id} (${name})` : id);
      lines.push(`| ${label(hostId, hostName)} | ${label(memberId, memberName)} | ${sep.toFixed(2)} | ${kindsThatFit(sep)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

const review = reviewMarkdown();

if (CHECK) {
  const stale = [[OUT, json], [REVIEW_OUT, review]].filter(([file, content]) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== content);
  if (stale.length > 0) {
    console.error('Companion table is stale. Run: npx tsx scripts/build-catalog-companions.ts');
    process.exit(1);
  }
  console.log('catalog-companions files are up to date');
} else {
  fs.writeFileSync(OUT, json);
  fs.writeFileSync(REVIEW_OUT, review);
  console.log(`Wrote ${OUT}: ${Object.keys(sortedPairs).length} hosts, ${pairCount} pairs (${hosts.size} hosts considered, ${members.size} board objects)`);
}
