#!/usr/bin/env tsx
/**
 * Step 3 of the catalog consolidation: fold curated-descriptions.json into
 * catalog-curated.json so there is one curated record set, then delete the
 * descriptions file.
 *
 * Per object:
 *   - Where both files have a description, the longer text wins (the
 *     hand-reviewed entries tend to be the fuller ones). Both are printed in
 *     the report so a person reads the swap.
 *   - Where only the descriptions file has text, it fills the curated entry.
 *   - Where a descriptions-file key has no curated entry, a new entry is built
 *     from its OpenNGC row (type, constellation, coordinates, magnitude, size)
 *     plus the description, so nothing is stranded when the file is deleted.
 *   - Every entry gains a `designations` array so the alias index can be
 *     derived from the record set instead of the hand-written ALIASES map.
 *   - Entries that resolve to the same canonical object (a pre-existing
 *     M102 + NGC5866 duplicate, a Herschel NGC number OpenNGC folds into
 *     another row) are collapsed into one.
 *
 * Dry run:  npx tsx scripts/merge-curated-descriptions.ts --dry-run
 * Apply:    npx tsx scripts/merge-curated-descriptions.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDesignation, resolveCanonicalId, getAliasesFor } from '../server/lib/catalogAliases.js';
import { ngcToCaldwell } from '../server/lib/caldwellCatalog.js';
import { SHARPLESS_CATALOG } from '../server/lib/sharplessCatalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURATED = path.join(ROOT, 'server', 'data', 'catalog-curated.json');
const DESCRIPTIONS = path.join(ROOT, 'server', 'data', 'curated-descriptions.json');
const OPENNGC = path.join(ROOT, 'server', 'data', 'openngc.json');

const DRY = process.argv.includes('--dry-run');
const norm = (id: string): string => normalizeDesignation(id).toUpperCase().replace(/\s+/g, '');
const DESIGNATION_SHAPE = /^(SH2-|NGC|IC|CED|VDB|LBN|LDN|UGC|PGC|ARP|MEL|STOCK|HCG|M|C|B)\d/;

interface CuratedEntry {
  id: string;
  name: string;
  type: string;
  constellation: string;
  magnitude?: number;
  description?: string;
  ra?: string;
  dec?: string;
  distanceLy?: number;
  majorAxisArcmin?: number | null;
  wikiUrl?: string | null;
  alsoKnownAs?: string[];
  designations?: string[];
  [k: string]: unknown;
}
interface DescEntry { extract: string; wikiUrl: string }
interface NgcRow {
  id: string; ngcName?: string; name?: string; type?: string; constellation?: string | null;
  messier?: number | string | null; ra?: number | null; dec?: number | null;
  magnitude?: number | null; majorAxisArcmin?: number | null; commonNames?: string[];
}

if (!fs.existsSync(DESCRIPTIONS)) {
  console.log('curated-descriptions.json is already gone — the merge has run. Nothing to do.');
  process.exit(0);
}

const curated: CuratedEntry[] = JSON.parse(fs.readFileSync(CURATED, 'utf8'));
const descriptions: Record<string, DescEntry> = JSON.parse(fs.readFileSync(DESCRIPTIONS, 'utf8'));
const ngcRows: NgcRow[] = JSON.parse(fs.readFileSync(OPENNGC, 'utf8'));

const primaryNgcIds = new Set(ngcRows.map(r => norm(r.id)));
const ngcByNorm = new Map<string, NgcRow>();
for (const r of ngcRows) {
  ngcByNorm.set(norm(r.id), r);
  if (r.ngcName) ngcByNorm.set(norm(r.ngcName), r);
  if (r.messier != null) ngcByNorm.set(norm(`M${r.messier}`), r);
  for (const cn of r.commonNames ?? []) if (DESIGNATION_SHAPE.test(norm(cn))) ngcByNorm.set(norm(cn), r);
}

/**
 * The single id an object's data and text should live under.
 *
 * Just resolveCanonicalId. OpenNGC's commonNames are not a reliable
 * "duplicate observation" marker — a row often lists the *more* famous
 * designation there (NGC 2239's row lists "NGC2244"), and physically distinct
 * objects too (IC 434's row lists "B33", the Horsehead), so folding on them
 * merges things that should stay apart.
 */
function canonicalize(id: string): string {
  return resolveCanonicalId(id);
}

function structuredFor(canonicalId: string):
  | { type?: string; constellation?: string | null; ra?: string; dec?: string; magnitude?: number | null; majorAxisArcmin?: number | null; name?: string }
  | undefined {
  const row = ngcByNorm.get(norm(canonicalId));
  if (row) {
    return {
      type: row.type, constellation: row.constellation,
      ra: row.ra != null ? String(row.ra) : undefined,
      dec: row.dec != null ? String(row.dec) : undefined,
      magnitude: row.magnitude, majorAxisArcmin: row.majorAxisArcmin,
      name: row.name && row.name !== row.id ? row.name : undefined,
    };
  }
  const sh = SHARPLESS_CATALOG.find(e => norm(canonicalize(e.id)) === norm(canonicalId));
  if (sh) {
    return {
      type: 'Emission Nebula', constellation: null,
      // Sharpless stores RA in degrees; the curated file and OpenNGC use
      // decimal hours.
      ra: String(sh.raDeg / 15), dec: String(sh.decDeg),
      magnitude: null, majorAxisArcmin: sh.sizeArcmin > 0 ? sh.sizeArcmin : null,
      name: sh.commonName ?? undefined,
    };
  }
  return undefined;
}

const descByNorm = new Map<string, DescEntry>();
for (const [k, v] of Object.entries(descriptions)) descByNorm.set(norm(k), v);
function descFor(canonicalId: string): DescEntry | undefined {
  const keys = [norm(canonicalId), ...getAliasesFor(canonicalId).map(norm)];
  for (const k of keys) { const hit = descByNorm.get(k); if (hit) return hit; }
  return undefined;
}

const allCanonicals = new Set<string>();
for (const e of curated) allCanonicals.add(norm(canonicalize(e.id)));
for (const k of Object.keys(descriptions)) allCanonicals.add(norm(canonicalize(k)));

function designationsFor(canonicalId: string, listed?: string[]): string[] {
  const out = new Set<string>();
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const n = norm(raw);
    if (n && DESIGNATION_SHAPE.test(n)) out.add(n);
  };
  push(canonicalId);
  for (const d of listed ?? []) push(d);
  for (const a of getAliasesFor(canonicalId)) push(a);
  const cNum = ngcToCaldwell(canonicalId);
  if (cNum != null) push(`C${cNum}`);
  // Only harvest designations from an OpenNGC row that is actually this
  // object's row. A commonName-match row (ngcByNorm indexes commonNames so
  // structuredFor can borrow coordinates) belongs to a different object, and
  // its ngcName / commonNames must not be claimed here.
  const row = ngcByNorm.get(norm(canonicalId));
  if (row && norm(row.id) === norm(canonicalId)) {
    push(row.ngcName);
    if (row.messier != null) push(`M${row.messier}`);
    for (const cn of row.commonNames ?? []) if (!primaryNgcIds.has(norm(cn))) push(cn);
  }
  for (const e of SHARPLESS_CATALOG) if (norm(canonicalize(e.id)) === norm(canonicalId)) push(e.id);
  // Never claim another record's canonical id.
  return [...out].filter(d => d === norm(canonicalId) || !allCanonicals.has(d));
}

const TRIVIAL = 40;
const report = {
  swaps: [] as Array<{ id: string; from: number; to: number; oldText: string; newText: string }>,
  filled: [] as Array<{ id: string; chars: number }>,
  stillEmpty: [] as string[],
  newFromNgc: [] as string[],
  newMinimal: [] as string[],
  collapsed: [] as string[],
  keptCurated: 0,
};

const staged: CuratedEntry[] = [];

for (const entry of curated) {
  const canonical = canonicalize(entry.id);
  const curText = (entry.description ?? '').trim();
  const d = descFor(canonical);
  let description = curText;
  let wikiUrl = entry.wikiUrl ?? null;

  if (d) {
    const descText = d.extract.trim();
    if (!curText) {
      description = descText;
      wikiUrl = d.wikiUrl;
      report.filled.push({ id: entry.id, chars: descText.length });
    } else if (descText.length > curText.length && descText !== curText) {
      if (curText.length >= TRIVIAL && descText.length >= TRIVIAL) {
        report.swaps.push({ id: entry.id, from: curText.length, to: descText.length, oldText: curText, newText: descText });
      }
      description = descText;
      wikiUrl = d.wikiUrl;
    } else {
      report.keptCurated++;
    }
  } else if (!curText) {
    report.stillEmpty.push(entry.id);
  }

  const merged: CuratedEntry = { ...entry };
  if (description) merged.description = description; else delete merged.description;
  if (wikiUrl) merged.wikiUrl = wikiUrl; else delete merged.wikiUrl;
  delete merged.alsoKnownAs;
  merged.designations = designationsFor(canonical, entry.designations);
  staged.push(merged);
}

// Description-file keys with no curated entry: build from OpenNGC / Sharpless.
const covered = new Set(staged.map(e => norm(canonicalize(e.id))));
for (const [key, d] of Object.entries(descriptions)) {
  const canonical = canonicalize(key);
  if (covered.has(norm(canonical))) continue;
  covered.add(norm(canonical));
  const s = structuredFor(canonical);
  if (s) {
    staged.push({
      id: canonical,
      name: s.name ?? canonical,
      type: s.type ?? 'Unknown',
      constellation: s.constellation ?? '',
      ...(s.magnitude != null ? { magnitude: s.magnitude } : {}),
      description: d.extract.trim(),
      ...(s.ra != null ? { ra: s.ra } : {}),
      ...(s.dec != null ? { dec: s.dec } : {}),
      ...(s.majorAxisArcmin != null ? { majorAxisArcmin: s.majorAxisArcmin } : {}),
      wikiUrl: d.wikiUrl,
      designations: designationsFor(canonical),
    });
    report.newFromNgc.push(canonical);
  } else {
    // The handful of objects with no OpenNGC row and no Sharpless match. Give
    // them a constellation so they satisfy the catalog entry shape; Step 5
    // fills the rest of the structured fields.
    const KNOWN_CONSTELLATIONS: Record<string, string> = {
      NGC2327: 'Canis Major',
      NGC6885: 'Vulpecula',
      C99: 'Crux',
    };
    staged.push({
      id: canonical,
      name: canonical,
      type: 'Unknown',
      constellation: KNOWN_CONSTELLATIONS[norm(canonical)] ?? 'Unknown',
      description: d.extract.trim(),
      wikiUrl: d.wikiUrl,
      designations: designationsFor(canonical),
    });
    report.newMinimal.push(canonical);
  }
}

// Collapse entries that resolve to the same canonical object into one.
const STRUCT_KEYS: Array<keyof CuratedEntry> = ['magnitude', 'ra', 'dec', 'distanceLy', 'majorAxisArcmin', 'wikiUrl'];
const byCanon = new Map<string, CuratedEntry>();
for (const e of staged) {
  const key = norm(canonicalize(e.id));
  const existing = byCanon.get(key);
  if (!existing) { byCanon.set(key, e); continue; }
  const winner = (e.description ?? '').length > (existing.description ?? '').length ? e : existing;
  const loser = winner === e ? existing : e;
  winner.designations = [...new Set([...(winner.designations ?? []), ...(loser.designations ?? [])])];
  for (const k of STRUCT_KEYS) if (winner[k] == null && loser[k] != null) winner[k] = loser[k];
  if ((!winner.type || winner.type === 'Unknown') && loser.type && loser.type !== 'Unknown') winner.type = loser.type;
  if ((!winner.constellation) && loser.constellation) winner.constellation = loser.constellation;
  if (!winner.description && loser.description) winner.description = loser.description;
  byCanon.set(key, winner);
  report.collapsed.push(`${loser.id} + ${winner.id}`);
}

// A few objects reach here with no constellation (Sharpless-derived rows, the
// no-structured-data stragglers). Fill from a small known map so every entry
// satisfies the catalog shape; Step 5 fills the rest.
const KNOWN_CONSTELLATIONS: Record<string, string> = {
  NGC2327: 'Canis Major', NGC6885: 'Vulpecula', C99: 'Crux', NGC6820: 'Vulpecula',
};

// Rekey collapsed entries to the canonical spelling so curatedMap keys by it.
const out: CuratedEntry[] = [];
for (const e of byCanon.values()) {
  const canonical = canonicalize(e.id);
  if (norm(canonical) !== norm(e.id)) e.id = canonical;
  e.designations = [...new Set([norm(e.id), ...(e.designations ?? [])])].filter(Boolean);
  if (!e.constellation?.trim() && KNOWN_CONSTELLATIONS[norm(e.id)]) {
    e.constellation = KNOWN_CONSTELLATIONS[norm(e.id)];
  }
  out.push(e);
}

// ── Report ──────────────────────────────────────────────────────────────────
const L = (s: string) => process.stdout.write(s + '\n');
L('');
L('═══ curated-descriptions.json → catalog-curated.json merge ═══');
L(`  input:   ${curated.length} curated entries, ${Object.keys(descriptions).length} description keys`);
L(`  output:  ${out.length} curated entries`);
L(`  kept curated text (curated >= desc):  ${report.keptCurated}`);
L(`  filled empty descriptions from desc:  ${report.filled.length}`);
L(`  new entries built from OpenNGC/Sh:    ${report.newFromNgc.length}`);
L(`  new entries with no structured data:  ${report.newMinimal.length}`);
L(`  collapsed duplicate-canonical pairs:  ${report.collapsed.length}`);
L(`  still empty after merge:              ${report.stillEmpty.length}`);
L(`  text swaps (longer desc replaced shorter curated): ${report.swaps.length}`);
L('');
if (report.collapsed.length) {
  L('── COLLAPSED (same canonical object, merged into one record) ──');
  for (const c of report.collapsed) L(`  ${c}`);
  L('');
}
if (report.swaps.length) {
  L('── TEXT SWAPS (longer description replaced shorter curated text) ──');
  for (const s of report.swaps) {
    L('');
    L(`  ${s.id}   ${s.from} → ${s.to} chars`);
    L(`    OLD: ${s.oldText.slice(0, 220)}${s.oldText.length > 220 ? '…' : ''}`);
    L(`    NEW: ${s.newText.slice(0, 220)}${s.newText.length > 220 ? '…' : ''}`);
  }
  L('');
}
if (report.newMinimal.length) {
  L('── NEW ENTRIES WITH NO STRUCTURED DATA (type "Unknown", need Step 5) ──');
  L('  ' + report.newMinimal.join(', '));
  L('');
}
if (report.stillEmpty.length) {
  L('── STILL EMPTY (curated entry, no description anywhere) ──');
  L('  ' + report.stillEmpty.join(', '));
  L('');
}

if (DRY) {
  L('DRY RUN — no files written. Re-run without --dry-run to apply.');
} else {
  fs.writeFileSync(CURATED, JSON.stringify(out, null, 2) + '\n');
  fs.rmSync(DESCRIPTIONS);
  L(`WROTE ${CURATED} (${out.length} entries)`);
  L(`DELETED ${DESCRIPTIONS}`);
}
