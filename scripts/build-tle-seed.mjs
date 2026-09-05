#!/usr/bin/env node
// Regenerate server/data/tle-seed.json — the cold-start satellite catalog
// bundled into the app. A fresh install (or a server whose IP CelesTrak has
// firewalled) has no cache and no archive, so this snapshot is what lets
// trail identification work before the first successful download.
//
// Usage:
//   node scripts/build-tle-seed.mjs                 # fetch a fresh copy from CelesTrak
//   node scripts/build-tle-seed.mjs <path-to.json>  # reuse an existing tle-catalog.json
//
// After running, bump SEED_EPOCH in server/lib/satelliteCatalog.ts to today.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'data', 'tle-seed.json');
const SRC = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';

function parseTle(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0);
  const records = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i].trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1.startsWith('1') || !line2.startsWith('2')) continue;
    const noradId = parseInt(line1.substring(2, 7).trim(), 10);
    if (Number.isNaN(noradId)) continue;
    records.push({ name, line1, line2, noradId });
  }
  return records;
}

const arg = process.argv[2];
let records;

if (arg) {
  const raw = fs.readFileSync(path.resolve(arg), 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${arg}: expected a JSON array`);
  records = parsed
    .filter((r) => r && typeof r.name === 'string' && typeof r.line1 === 'string'
      && typeof r.line2 === 'string' && typeof r.noradId === 'number')
    .map((r) => ({ name: r.name, line1: r.line1, line2: r.line2, noradId: r.noradId }));
} else {
  console.log(`Fetching ${SRC}`);
  const res = await fetch(SRC, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Nebulis seed builder)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 400);
    throw new Error(`CelesTrak returned HTTP ${res.status}: ${body}`);
  }
  records = parseTle(await res.text());
}

if (records.length < 5000) {
  throw new Error(`Refusing to write a seed with only ${records.length} records — looks truncated`);
}

// De-dupe by NORAD id, keep first.
const seen = new Map();
for (const r of records) if (!seen.has(r.noradId)) seen.set(r.noradId, r);
const merged = [...seen.values()];

fs.writeFileSync(OUT, JSON.stringify(merged), 'utf-8');
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Wrote ${merged.length} records → ${path.relative(ROOT, OUT)} (${kb} KB)`);
console.log('Now update SEED_EPOCH in server/lib/satelliteCatalog.ts to today.');
