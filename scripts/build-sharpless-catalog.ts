#!/usr/bin/env tsx
/**
 * One-time scraper that builds server/data/sharpless.json by combining:
 *   1. VizieR catalog VII/20A — all 313 objects with J2000 RA/Dec and diameter
 *   2. Wikipedia Sharpless catalog page — common names, NGC/Messier cross-refs
 *
 * Run to regenerate the static data file (commit the result):
 *   npx tsx scripts/build-sharpless-catalog.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'server', 'data', 'sharpless.json');
const UA = 'Nebulis/1.0 (astronomy app; catalog data build; contact=nebulis.app)';

export interface SharplessEntry {
  id: string;              // "Sh2-1"
  raDeg: number;           // J2000 decimal degrees 0–360
  decDeg: number;          // J2000 decimal degrees −90–+90
  sizeArcmin: number;      // major axis in arcminutes (0 if unknown)
  commonName: string | null;
  ngcRef: string | null;   // "NGC6302" — no space, uppercase
  messierRef: string | null; // "M8"
}

// ─── Source 1: VizieR VII/20A ────────────────────────────────────────────────

interface VizierRow {
  sh2: number;
  raDeg: number;
  decDeg: number;
  sizeArcmin: number;
}

async function fetchVizier(): Promise<Map<number, VizierRow>> {
  const url =
    'https://vizier.cds.unistra.fr/viz-bin/asu-tsv' +
    '?-source=VII/20A&-out=Sh2,_RAJ2000,_DEJ2000,Diam&-out.max=unlimited&-mime=tsv';

  const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`VizieR error: HTTP ${resp.status}`);

  const text = await resp.text();
  const rows = new Map<number, VizierRow>();
  let dataStarted = false;

  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;

    // Skip header/unit/separator lines
    if (!dataStarted) {
      if (/^\s*----/.test(line)) { dataStarted = true; }
      continue;
    }

    const cols = line.split('\t').map(c => c.trim());
    if (cols.length < 4) continue;

    const sh2 = parseInt(cols[0], 10);
    const ra = parseFloat(cols[1]);
    const dec = parseFloat(cols[2]);
    const diam = parseInt(cols[3], 10) || 0;

    if (!isNaN(sh2) && sh2 > 0 && !isNaN(ra) && !isNaN(dec)) {
      rows.set(sh2, {
        sh2,
        raDeg: Math.round(ra * 100000) / 100000,
        decDeg: Math.round(dec * 100000) / 100000,
        sizeArcmin: diam,
      });
    }
  }

  return rows;
}

// ─── Source 2: Wikipedia ─────────────────────────────────────────────────────

interface WikiRow {
  sh2: number;
  commonName: string | null;
  ngcRef: string | null;
  messierRef: string | null;
}

function stripWiki(s: string): string {
  return s
    .replace(/\[\[File:[^\]]+\]\]/gi, '')
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function findNgcRef(text: string): string | null {
  const m = text.match(/\b(NGC|IC)\s*(\d+)/i);
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

function findMessierRef(text: string): string | null {
  // "Messier 8" or "M 8" but not "M1-67" (stellar designation)
  const m = text.match(/\bMessier\s*(\d+)\b|\bM\s+(\d+)\b/i);
  if (!m) return null;
  const num = m[1] ?? m[2];
  return `M${num}`;
}

const CATALOG_CODE_RE = /^(NGC|IC|RCW|LBN|Gum|Sh|M\d|ESO|PK |Westerhout|W\s|\d)/i;
const COMMON_NAME_MIN_LEN = 4;

function isCatalogCode(s: string): boolean {
  return CATALOG_CODE_RE.test(s.trim());
}

function extractCommonName(cell1Link: string, cell2: string, notes: string): string | null {
  // Prefer cell 2: `[[Eagle Nebula]]` or `[[NGC 6302|Bug Nebula]]`
  const cell2Clean = stripWiki(cell2).trim();
  if (cell2Clean.length >= COMMON_NAME_MIN_LEN && !isCatalogCode(cell2Clean)) {
    return cell2Clean;
  }

  // Try cell 1 link target: `[[Eagle Nebula|Sh 2-49]]` → "Eagle Nebula"
  const linkTarget = cell1Link.match(/^\[\[([^\]|]+)\|Sh\s*2[-–]\s*\d+/i)?.[1]?.trim();
  if (linkTarget && linkTarget.length >= COMMON_NAME_MIN_LEN && !isCatalogCode(linkTarget)) {
    return linkTarget;
  }

  return null;
}

async function fetchWikipedia(): Promise<Map<number, WikiRow>> {
  const url =
    'https://en.wikipedia.org/w/api.php' +
    '?action=parse&page=Sharpless_catalog&prop=wikitext&format=json&formatversion=2';

  const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Wikipedia API error: HTTP ${resp.status}`);

  const json = await resp.json() as { parse?: { wikitext?: string } };
  const wikitext = json.parse?.wikitext ?? '';

  const rows = new Map<number, WikiRow>();
  // Each table row is separated by |-
  const rawRows = wikitext.split(/\n\|-/);

  for (const rawRow of rawRows) {
    // Must contain a Sh 2-N designation
    const shMatch = rawRow.match(/Sh\s*2[-–]\s*(\d+)/i);
    if (!shMatch) continue;
    const sh2 = parseInt(shMatch[1], 10);
    if (!sh2) continue;

    // Flatten to one line then split on ||
    const oneLine = rawRow.replace(/\n/g, ' ');
    const cells = oneLine.split('||').map(c => c.replace(/^\s*\|?\s*/, '').trim());

    // Locate the cell that contains the Sh 2-N designation (usually cell 0 or 1)
    const designationIdx = cells.findIndex(c => /Sh\s*2[-–]\s*\d+/i.test(c));
    if (designationIdx < 0) continue;

    const cell1 = cells[designationIdx];
    const cell2 = cells[designationIdx + 1] ?? '';
    // designationIdx+2 is image — skip
    const notes = (cells[designationIdx + 3] ?? '').trim();

    rows.set(sh2, {
      sh2,
      commonName: extractCommonName(cell1, cell2, notes),
      ngcRef: findNgcRef(cell1) ?? findNgcRef(notes),
      messierRef: findMessierRef(notes),
    });
  }

  return rows;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[sharpless] Fetching VizieR VII/20A (coordinates)...');
  const vizierRows = await fetchVizier();
  console.log(`[sharpless] VizieR: ${vizierRows.size} entries`);

  console.log('[sharpless] Fetching Wikipedia (names + cross-refs)...');
  const wikiRows = await fetchWikipedia();
  console.log(`[sharpless] Wikipedia: ${wikiRows.size} matched rows`);

  const entries: SharplessEntry[] = [];

  for (const [sh2, viz] of vizierRows) {
    const wiki = wikiRows.get(sh2);
    entries.push({
      id: `Sh2-${sh2}`,
      raDeg: viz.raDeg,
      decDeg: viz.decDeg,
      sizeArcmin: viz.sizeArcmin,
      commonName: wiki?.commonName ?? null,
      ngcRef: wiki?.ngcRef ?? null,
      messierRef: wiki?.messierRef ?? null,
    });
  }

  // Sort by catalog number
  entries.sort((a, b) => {
    const na = parseInt(a.id.slice(4), 10);
    const nb = parseInt(b.id.slice(4), 10);
    return na - nb;
  });

  const withNgc = entries.filter(e => e.ngcRef).length;
  const withM = entries.filter(e => e.messierRef).length;
  const withName = entries.filter(e => e.commonName).length;
  console.log(
    `[sharpless] ${entries.length} entries: ` +
    `${withName} named, ${withM} Messier cross-refs, ${withNgc} NGC/IC cross-refs`,
  );

  fs.writeFileSync(OUTPUT, JSON.stringify(entries, null, 2));
  console.log(`[sharpless] Written to ${OUTPUT}`);
}

main().catch(err => {
  console.error('[sharpless] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
