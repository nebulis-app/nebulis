#!/usr/bin/env node
/**
 * One-shot enrichment script: adds Wikipedia descriptions for all 400
 * Herschel 400 objects to server/data/curated-descriptions.json.
 *
 * For objects already covered via Messier or Caldwell aliases, copies the
 * existing description under the NGC key. For the rest (~301), fetches a
 * Wikipedia extract.
 *
 *   node scripts/enrich-herschel-descriptions.mjs
 *
 * Safe to re-run: skips objects already present under their NGC key.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CURATED_PATH = path.join(REPO_ROOT, 'server', 'data', 'curated-descriptions.json');

// ─── Load data ───────────────────────────────────────────────────────────────

const curated = JSON.parse(fs.readFileSync(CURATED_PATH, 'utf8'));

// Parse Herschel 400 IDs from the TypeScript catalog file
const herschelTs = fs.readFileSync(
  path.join(REPO_ROOT, 'server', 'lib', 'herschel400Catalog.ts'), 'utf8',
);
const herschelIds = [...herschelTs.matchAll(/'(NGC\d+)'/g)].map(m => m[1]);
if (herschelIds.length !== 400) throw new Error(`Expected 400 Herschel IDs, got ${herschelIds.length}`);

// Parse NGC->Messier aliases
const aliasesTs = fs.readFileSync(
  path.join(REPO_ROOT, 'server', 'lib', 'catalogAliases.ts'), 'utf8',
);
const ngcToMessier = new Map();
for (const m of aliasesTs.matchAll(/\['(NGC\d+)',\s*'(M\d+)'\]/g)) {
  ngcToMessier.set(m[1], m[2]);
}

// Parse Caldwell->NGC map, then invert to NGC->Caldwell
const caldwellTs = fs.readFileSync(
  path.join(REPO_ROOT, 'server', 'lib', 'caldwellCatalog.ts'), 'utf8',
);
const ngcToCaldwell = new Map();
for (const m of caldwellTs.matchAll(/(\d+):\s*['"]((NGC|IC)\d+)['"]/g)) {
  ngcToCaldwell.set(m[2], `C${m[1]}`);
}

// ─── Wikipedia fetch ─────────────────────────────────────────────────────────

const USER_AGENT = 'Nebulis/1.0 (https://github.com/nebulis; catalog enrichment script)';

async function fetchWikiSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.type === 'disambiguation') return null;
    if (typeof json.extract !== 'string' || json.extract.length < 40) return null;
    return { extract: json.extract, wikiUrl: json.content_urls?.desktop?.page ?? null };
  } catch {
    return null;
  }
}

function trimExtract(extract) {
  const cleaned = extract.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 280) return cleaned;
  const sentences = (cleaned.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [])
    .map(s => s.trim())
    .filter(s => s.length >= 12 && /^[A-Za-z"'"]/.test(s));
  if (sentences.length === 0) return cleaned.slice(0, 280) + '…';
  let out = sentences[0];
  if (sentences.length > 1 && (out + ' ' + sentences[1]).length <= 320) {
    out = out + ' ' + sentences[1];
  }
  return out;
}

function candidateTitles(ngcId) {
  const titles = [];
  const m = ngcId.match(/^(NGC|IC)(\d+)$/);
  if (m) titles.push(`${m[1]} ${m[2]}`);
  titles.push(ngcId);
  return titles;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Processing ${herschelIds.length} Herschel 400 objects…`);

  let alreadyDirect = 0;
  let copiedFromAlias = 0;
  let wikiFetched = 0;
  let wikiMissed = 0;

  for (const ngcId of herschelIds) {
    // Already in curated-descriptions under this exact NGC key
    if (curated[ngcId]) {
      alreadyDirect++;
      continue;
    }

    // Check Messier alias (NGC598 → M33)
    const messierKey = ngcToMessier.get(ngcId);
    if (messierKey && curated[messierKey]) {
      curated[ngcId] = curated[messierKey];
      copiedFromAlias++;
      console.log(`  ≡ ${ngcId.padEnd(8)} → ${messierKey} (alias copy)`);
      continue;
    }

    // Check Caldwell alias (NGC40 → C2)
    const caldwellKey = ngcToCaldwell.get(ngcId);
    if (caldwellKey && curated[caldwellKey]) {
      curated[ngcId] = curated[caldwellKey];
      copiedFromAlias++;
      console.log(`  ≡ ${ngcId.padEnd(8)} → ${caldwellKey} (alias copy)`);
      continue;
    }

    // Need to fetch from Wikipedia
    let hit = null;
    for (const title of candidateTitles(ngcId)) {
      const result = await fetchWikiSummary(title);
      if (result) { hit = result; break; }
    }

    if (hit) {
      curated[ngcId] = {
        extract: trimExtract(hit.extract),
        wikiUrl: hit.wikiUrl,
      };
      wikiFetched++;
      console.log(`  ✓ ${ngcId}`);
    } else {
      // Store a sentinel so re-runs don't re-fetch; omit from file
      wikiMissed++;
      console.log(`  · ${ngcId} (no Wikipedia entry)`);
    }

    await new Promise(r => setTimeout(r, 80));
  }

  // Write updated file
  fs.writeFileSync(CURATED_PATH, JSON.stringify(curated, null, 2) + '\n');

  console.log(`\nDone.`);
  console.log(`  Already covered (direct):  ${alreadyDirect}`);
  console.log(`  Copied from alias:         ${copiedFromAlias}`);
  console.log(`  Fetched from Wikipedia:    ${wikiFetched}`);
  console.log(`  No Wikipedia entry found:  ${wikiMissed}`);
  console.log(`  Total in file now:         ${Object.keys(curated).length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
