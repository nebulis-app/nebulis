#!/usr/bin/env tsx
/**
 * Step 5 of the catalog consolidation: bulk-populate the curated layer.
 *
 * Walks the union of the four observing programs plus the popular/extended
 * image-pack tiers. For any object the catalog store has no description for, it
 * resolves the designations, fetches a Wikipedia summary once, and writes a
 * catalog-curated.json entry with `wikiUrl` (the attribution source) set and
 * `reviewedAt` left unset — an unreviewed, scraped record awaiting a human
 * stamp. Structured fields (type, constellation, coordinates, size) come from
 * OpenNGC or the Sharpless catalog.
 *
 * After the curated-descriptions.json merge (Step 3), Messier, Caldwell and
 * Herschel 400 are already fully covered; the remaining gap is mostly obscure
 * Sharpless HII regions, many of which have no Wikipedia article at all.
 *
 *   npx tsx scripts/populate-curated-layer.ts --dry-run
 *   npx tsx scripts/populate-curated-layer.ts --limit 50
 *   npx tsx scripts/populate-curated-layer.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCuratedRecord } from '../server/lib/catalogStore.js';
import { normalizeDesignation, resolveCanonicalId, getAliasesFor } from '../server/lib/catalogAliases.js';
import { HERSCHEL400_IDS } from '../server/lib/herschel400Catalog.js';
import { CALDWELL_TO_NGC, ngcToCaldwell } from '../server/lib/caldwellCatalog.js';
import { SHARPLESS_CATALOG } from '../server/lib/sharplessCatalog.js';
import { POPULAR_DSO_IDS } from '../server/lib/popularDsoCatalog.js';
import { EXTENDED_DSO_IDS } from '../server/lib/extendedDsoCatalog.js';
import { fetchWikipediaSummary } from '../server/lib/wikipedia.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURATED = path.join(ROOT, 'server', 'data', 'catalog-curated.json');
const OPENNGC = path.join(ROOT, 'server', 'data', 'openngc.json');

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]) : Infinity;

const norm = (id: string): string => normalizeDesignation(id).toUpperCase().replace(/\s+/g, '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface CuratedEntry {
  id: string; name: string; type: string; constellation: string;
  magnitude?: number; description?: string; ra?: string; dec?: string;
  distanceLy?: number; majorAxisArcmin?: number | null; wikiUrl?: string | null;
  designations?: string[]; reviewedAt?: string | null;
}
interface NgcRow {
  id: string; ngcName?: string; name?: string; type?: string; constellation?: string | null;
  messier?: number | string | null; ra?: number | null; dec?: number | null;
  magnitude?: number | null; majorAxisArcmin?: number | null; commonNames?: string[];
}

const curated: CuratedEntry[] = JSON.parse(fs.readFileSync(CURATED, 'utf8'));
const ngcRows: NgcRow[] = JSON.parse(fs.readFileSync(OPENNGC, 'utf8'));
const ngcByNorm = new Map<string, NgcRow>();
for (const r of ngcRows) {
  ngcByNorm.set(norm(r.id), r);
  if (r.ngcName) ngcByNorm.set(norm(r.ngcName), r);
  if (r.messier != null) ngcByNorm.set(norm(`M${r.messier}`), r);
  for (const cn of r.commonNames ?? []) ngcByNorm.set(norm(cn), r);
}
const curatedByNorm = new Map<string, CuratedEntry>();
for (const e of curated) curatedByNorm.set(norm(resolveCanonicalId(e.id)), e);

// ── Target set ──────────────────────────────────────────────────────────────
const targets = new Set<string>();
for (let n = 1; n <= 110; n++) targets.add(`M${n}`);
for (const n of Object.keys(CALDWELL_TO_NGC)) targets.add(`C${n}`);
for (const id of HERSCHEL400_IDS) targets.add(id);
for (const e of SHARPLESS_CATALOG) targets.add(e.id);
for (const id of POPULAR_DSO_IDS) targets.add(id);
for (const id of EXTENDED_DSO_IDS) targets.add(id);

// ── Structured data + search titles for one object ──────────────────────────
function structured(canonical: string) {
  const row = ngcByNorm.get(norm(canonical));
  if (row) {
    return {
      name: row.name && row.name !== row.id ? row.name : null,
      type: row.type ?? 'Unknown',
      constellation: row.constellation ?? '',
      ra: row.ra != null ? String(row.ra) : undefined,
      dec: row.dec != null ? String(row.dec) : undefined,
      magnitude: row.magnitude ?? undefined,
      majorAxisArcmin: row.majorAxisArcmin ?? undefined,
      commonNames: (row.commonNames ?? []).filter(c => !/^\s*(NGC|IC|M|C|B|Sh2)\s*\d/i.test(c)),
    };
  }
  const sh = SHARPLESS_CATALOG.find(e => norm(resolveCanonicalId(e.id)) === norm(canonical));
  if (sh) {
    return {
      name: sh.commonName ?? null,
      type: 'Emission Nebula',
      constellation: '',
      ra: String(sh.raDeg / 15),
      dec: String(sh.decDeg),
      magnitude: undefined,
      majorAxisArcmin: sh.sizeArcmin > 0 ? sh.sizeArcmin : undefined,
      commonNames: sh.commonName ? [sh.commonName] : [],
    };
  }
  return null;
}

function searchTitles(canonical: string, s: ReturnType<typeof structured>): string[] {
  const titles: string[] = [];
  if (s?.name) titles.push(s.name);
  for (const cn of s?.commonNames ?? []) titles.push(cn);
  const spaced = (id: string) =>
    id.replace(/^SH2-?/i, 'Sharpless ').replace(/^NGC/i, 'NGC ').replace(/^IC/i, 'IC ').replace(/^M(\d)/, 'Messier $1').replace(/^C(\d)/, 'Caldwell $1');
  titles.push(spaced(canonical));
  for (const a of getAliasesFor(canonical)) titles.push(spaced(a));
  const cNum = ngcToCaldwell(canonical);
  if (cNum != null) titles.push(`Caldwell ${cNum}`);
  return [...new Set(titles)].filter(Boolean);
}

// ── Walk ────────────────────────────────────────────────────────────────────
async function main() {
  const need: string[] = [];
  for (const id of targets) {
    const rec = getCuratedRecord(id);
    if (rec && rec.description) continue;
    need.push(resolveCanonicalId(id));
  }
  const uniqueNeed = [...new Set(need.map(norm))].map(n => need.find(x => norm(x) === n)!);
  console.log(`[populate] ${targets.size} program/pack ids, ${uniqueNeed.length} without a curated description`);

  const report = { added: [] as string[], updated: [] as string[], noArticle: [] as string[], noStructured: [] as string[] };
  let processed = 0;

  for (const canonical of uniqueNeed) {
    if (processed >= LIMIT) break;
    processed++;
    const s = structured(canonical);
    if (!s) { report.noStructured.push(canonical); continue; }

    let hit: { extract: string; wikiUrl: string } | null = null;
    for (const title of searchTitles(canonical, s)) {
      try {
        const r = await fetchWikipediaSummary(title);
        await sleep(200);
        if (r && r.extract.length > 80) { hit = r; break; }
      } catch { /* keep trying titles */ }
    }
    if (!hit) { report.noArticle.push(canonical); continue; }

    const designations = [
      norm(canonical),
      ...getAliasesFor(canonical).map(norm),
    ];
    const cNum = ngcToCaldwell(canonical);
    if (cNum != null) designations.push(`C${cNum}`);

    const existing = curatedByNorm.get(norm(canonical));
    if (existing) {
      existing.description = hit.extract;
      existing.wikiUrl = hit.wikiUrl || existing.wikiUrl || null;
      existing.reviewedAt = null;
      report.updated.push(canonical);
    } else {
      const entry: CuratedEntry = {
        id: canonical,
        name: s.name ?? canonical,
        type: s.type,
        constellation: s.constellation || 'Unknown',
        ...(s.magnitude != null ? { magnitude: s.magnitude } : {}),
        description: hit.extract,
        ...(s.ra != null ? { ra: s.ra } : {}),
        ...(s.dec != null ? { dec: s.dec } : {}),
        ...(s.majorAxisArcmin != null ? { majorAxisArcmin: s.majorAxisArcmin } : {}),
        wikiUrl: hit.wikiUrl || null,
        designations: [...new Set(designations)].filter(Boolean),
        reviewedAt: null,
      };
      curated.push(entry);
      curatedByNorm.set(norm(canonical), entry);
      report.added.push(canonical);
    }
  }

  console.log('');
  console.log(`  processed:      ${processed}`);
  console.log(`  new entries:    ${report.added.length}`);
  console.log(`  updated:        ${report.updated.length}`);
  console.log(`  no article:     ${report.noArticle.length}`);
  console.log(`  no structured:  ${report.noStructured.length}`);
  console.log('');
  if (report.added.length) console.log('  added:   ' + report.added.join(', '));
  if (report.updated.length) console.log('  updated: ' + report.updated.join(', '));

  if (DRY) {
    console.log('\nDRY RUN — no file written.');
  } else if (report.added.length || report.updated.length) {
    fs.writeFileSync(CURATED, JSON.stringify(curated, null, 2) + '\n');
    console.log(`\nWROTE ${CURATED} (${curated.length} entries; ${report.added.length + report.updated.length} touched, all reviewedAt=null)`);
  } else {
    console.log('\nNothing to write.');
  }
}

main();
