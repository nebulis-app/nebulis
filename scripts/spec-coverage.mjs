#!/usr/bin/env node
/**
 * Spec ↔ route ↔ test traceability for the functional specification.
 *
 *   node scripts/spec-coverage.mjs            # report; exit 1 on drift
 *   node scripts/spec-coverage.mjs --write    # regenerate spec-index.json
 *   node scripts/spec-coverage.mjs --json     # machine-readable report
 *
 * What it checks
 *   1. Every route in the router inventory is named by at least one feature entry.
 *   2. Every route a feature entry names actually exists (no documented ghost routes).
 *   3. Every feature ID is unique and reachable from exactly one entry.
 *   4. Which features have a test that touches one of their route path families.
 *
 * The spec is the Markdown under internal-doc/functional-spec/. Feature entries start with
 * `### F-<AREA>-<n>`; an entry may cover several IDs (`### F-CAT-35 / F-CAT-36 …`) when the
 * behaviour is one pipeline, and every ID in the heading inherits the entry's body.
 *
 * Route mentions are read from the body as `METHOD /path`, and accept the spec's `…/path`
 * shorthand, which resolves as a suffix match against the inventory.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SPEC_DIR = path.join(ROOT, 'internal-doc/functional-spec');
const INVENTORY = path.join(ROOT, 'tests/backend/fixtures/routeInventory.json');
const INDEX = path.join(SPEC_DIR, 'spec-index.json');
const TESTS_DIR = path.join(ROOT, 'tests');

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const JSON_OUT = args.has('--json');

const areaOf = (id) => String(Number(String(id).match(/F-[A-Z]+-(\d+)/)[1]));
const domainOf = (id) => String(id).match(/F-([A-Z]+)-/)[1];

/** Which spec file owns a feature ID, for the report. */
const FILE_BY_DOMAIN = { LIB: '01-library.md', TEL: '03-telescopes-devices.md', PLAN: '04-planner-observing.md', CAT: '05-catalog-discovery.md', SYS: '06-system-settings.md' };

/**
 * A route path normalised for comparison: no API prefix, no query, no trailing slash, and every
 * parameter segment replaced by `:p` so `:id`, `:objectId` and `<uuid>` compare equal.
 */
function normPath(raw) {
  let p = String(raw).trim();
  p = p.replace(/^\/api\/v1(?=\/|$)/, '');
  p = p.replace(/^\/api(?=\/|$)/, '');
  p = p.split('?')[0].split('#')[0];
  p = p.replace(/<[^>]+>/g, ':p');
  p = p.replace(/\/+$/, '');
  p = p.split('/').map((s) => (s.startsWith(':') || /^\[.*\]$/.test(s) ? ':p' : s)).join('/');
  return p === '' ? '/' : p;
}

/** The static head of a path — everything before the first parameter — used for the test probe. */
function pathFamily(normalized) {
  const segs = normalized.split('/');
  const head = [];
  for (const s of segs) {
    if (s === ':p') break;
    head.push(s);
  }
  const family = head.join('/') || '/';
  return family.length > 1 ? family : null;
}

function readJson(file, what) {
  if (!fs.existsSync(file)) {
    console.error(`spec-coverage: missing ${what}: ${path.relative(ROOT, file)}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ─── inventory ────────────────────────────────────────────────────────────────
const inventory = readJson(INVENTORY, 'route inventory');
if (!Array.isArray(inventory)) {
  console.error('spec-coverage: routeInventory.json is not an array');
  process.exit(2);
}
/** normalized path → Set(method) */
const routes = new Map();
for (const r of inventory) {
  const p = normPath(r.path);
  if (!routes.has(p)) routes.set(p, new Set());
  routes.get(p).add(String(r.method).toUpperCase());
}
const routeKey = (method, p) => `${method} ${p}`;

// ─── spec ─────────────────────────────────────────────────────────────────────
const specFiles = fs.readdirSync(SPEC_DIR).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const features = new Map(); // id → { id, title, file, routes: Set<key>, body }
const duplicates = [];

const METHOD_WORD = '(?:GET|POST|PUT|PATCH|DELETE)';
const MENTION = new RegExp(`(${METHOD_WORD}(?:\\|${METHOD_WORD})*)\\s+\`?(?:/api(?:/v1)?)?\\s*(…|\\.\\.\\.)?\\s*(/[A-Za-z0-9_\\-/:.]*)`, 'g');

/** All (method, normalizedPath, isSuffix) mentions inside one body of text. */
function mentions(text) {
  const out = [];
  for (const m of text.matchAll(MENTION)) {
    const methods = m[1].split('|');
    const suffix = Boolean(m[2]);
    let p = m[3].replace(/[.,;:)]+$/, '');
    if (!p.startsWith('/')) continue;
    const normalized = normPath(p);
    for (const method of methods) out.push({ method, path: normalized, suffix });
  }
  return out;
}

/**
 * Resolve a mention to inventory keys: exact, or suffix match for the `…/` shorthand.
 *
 * The shorthand is prose, not a contract, so it is only trusted when it is unambiguous: a suffix
 * must name at least one static segment (a bare `/:id` names nothing) and must not match more
 * than a handful of routes. An over-broad suffix is dropped rather than inflating coverage.
 */
const SUFFIX_MAX_MATCHES = 4;
function resolve({ method, path: p, suffix }) {
  const exact = routeKey(method, p);
  if (routes.has(p) && routes.get(p).has(method)) return [exact];
  if (!suffix) return [];
  const segments = p.split('/').filter(Boolean);
  const hasStatic = segments.some((s) => s !== ':p');
  if (!hasStatic) return [];
  const keys = [];
  for (const [rp, methods] of routes) {
    if (methods.has(method) && rp.endsWith(p)) keys.push(routeKey(method, rp));
  }
  return keys.length > 0 && keys.length <= SUFFIX_MAX_MATCHES ? keys : [];
}

for (const file of specFiles) {
  const text = fs.readFileSync(path.join(SPEC_DIR, file), 'utf8');
  const headingRe = /^###\s+(.+)$/gm;
  const heads = [...text.matchAll(headingRe)];
  for (let i = 0; i < heads.length; i += 1) {
    const heading = heads[i][1];
    const ids = [...heading.matchAll(/F-[A-Z]+-\d+/g)].map((m) => m[0]);
    if (ids.length === 0) continue;
    const start = heads[i].index + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const body = text.slice(start, end).split(/^---$/m)[0];
    for (const id of ids) {
      if (features.has(id)) duplicates.push({ id, first: features.get(id).file, second: file });
      const title = heading.replace(/^F-[A-Z]+-\d+(\s*\/\s*F-[A-Z]+-\d+)*\s*/, '').trim() || heading;
      features.set(id, {
        id,
        title,
        file,
        pending: /pending specification/i.test(title),
        routes: new Set(mentions(body).flatMap(resolve)),
        body,
      });
    }
  }
}

// ─── explicit route claims ────────────────────────────────────────────────────
/**
 * `route-claims.md` carries the routes the prose does not name literally (`` `GET|POST /wishlist` ``,
 * `` `PUT …/:cid` ``). A claim is a row `| F-XXX-n | \`METHOD /path\` |`. It supplements prose; it
 * does not replace it. `pending specification` entries use it to list behaviour that is not written
 * down yet, so the debt is counted rather than hidden.
 */
const CLAIMS = path.join(SPEC_DIR, 'route-claims.md');
const claimsByFeature = new Map();
if (fs.existsSync(CLAIMS)) {
  const claimRe = /^\|\s*(F-[A-Z]+-\d+)\s*\|\s*`?((?:GET|POST|PUT|PATCH|DELETE)\s+\/[^`|]+?)`?\s*\|/gm;
  for (const m of fs.readFileSync(CLAIMS, 'utf8').matchAll(claimRe)) {
    const id = m[1];
    const [method, rawPath] = m[2].trim().split(/\s+/, 2);
    const key = routeKey(method.toUpperCase(), normPath(rawPath));
    if (!claimsByFeature.has(id)) claimsByFeature.set(id, new Set());
    claimsByFeature.get(id).add(key);
  }
}

for (const [id, keys] of claimsByFeature) {
  const f = features.get(id);
  if (!f) continue; // a claim for an ID that no entry defines — reported below
  for (const k of keys) f.routes.add(k);
}
const orphanClaims = [...claimsByFeature.keys()].filter((id) => !features.has(id));

// ─── coverage ─────────────────────────────────────────────────────────────────
const covered = new Set();
for (const f of features.values()) for (const k of f.routes) covered.add(k);

const allKeys = [];
for (const [p, methods] of routes) for (const m of methods) allKeys.push(routeKey(m, p));

const ghosts = [...covered].filter((k) => !allKeys.includes(k)).sort();
const unassigned = allKeys.filter((k) => !covered.has(k)).sort();
const routesOf = new Map(); // key → [feature ids]
for (const f of features.values()) {
  for (const k of f.routes) {
    if (!routesOf.has(k)) routesOf.set(k, []);
    routesOf.get(k).push(f.id);
  }
}

// ─── test probe ───────────────────────────────────────────────────────────────
function testCorpus() {
  const parts = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'fixtures') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) parts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  if (fs.existsSync(TESTS_DIR)) walk(TESTS_DIR);
  return parts.join('\n');
}
const corpus = testCorpus();
const testedFamily = (normalized) => {
  const family = pathFamily(normalized);
  return family ? corpus.includes(family) : false;
};

const featureTested = new Map();
for (const f of features.values()) {
  f.tested = [...f.routes].some((k) => {
    const p = k.slice(k.indexOf(' ') + 1);
    return testedFamily(p);
  });
  featureTested.set(f.id, f.tested);
}

// ─── proposed homes for unassigned routes ────────────────────────────────────
const AREA_BY_PREFIX = {
  library: '01', storage: '01', telescope: '03', telescopes: '03', devices: '03', pair: '03', gear: '03',
  sites: '04', planner: '04', 'planned-sessions': '04', forecast: '04', satellite: '04', 'sky-events': '04', observations: '04',
  catalog: '05', catalogs: '05', dso: '05', explore: '05', wishlist: '05', notes: '05', 'object-notes': '05', journal: '05', annotate: '05', reports: '05',
  auth: '06', settings: '06', preferences: '06', alerts: '06', meta: '06', 'system-log': '06', health: '06', openapi: '06',
};
const proposedHome = (key) => {
  const p = key.slice(key.indexOf(' ') + 1);
  const prefix = p.split('/')[1] || '';
  return AREA_BY_PREFIX[prefix] ?? '?';
};

// ─── report ──────────────────────────────────────────────────────────────────
const byDomain = {};
for (const f of features.values()) {
  const d = domainOf(f.id);
  byDomain[d] ??= { features: 0, tested: 0, routes: 0 };
  byDomain[d].features += 1;
  byDomain[d].routes += f.routes.size;
  if (f.tested) byDomain[d].tested += 1;
}

const pendingFeatures = [...features.values()].filter((f) => f.pending);
const pendingRoutes = new Set(pendingFeatures.flatMap((f) => [...f.routes]));

const problems = [];
if (duplicates.length) problems.push(`${duplicates.length} duplicate feature ID(s)`);
if (orphanClaims.length) problems.push(`${orphanClaims.length} route claim(s) for an undefined feature ID`);
if (ghosts.length) problems.push(`${ghosts.length} documented route(s) that do not exist`);
if (unassigned.length) problems.push(`${unassigned.length} route(s) with no feature entry`);

const index = {
  generatedBy: 'scripts/spec-coverage.mjs',
  specFiles,
  source: { inventory: 'tests/backend/fixtures/routeInventory.json' },
  counts: {
    routes: allKeys.length,
    paths: routes.size,
    features: features.size,
    featuresWithTestedRoute: [...features.values()].filter((f) => f.tested).length,
    pendingFeatures: pendingFeatures.length,
    pendingRoutes: pendingRoutes.size,
    routesCoveredBySpec: covered.size,
    routesUnassigned: unassigned.length,
    ghostRoutes: ghosts.length,
  },
  features: Object.fromEntries(
    [...features.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
      .map((f) => [f.id, { title: f.title, file: f.file, pending: f.pending, routes: [...f.routes].sort(), hasTestedRoute: f.tested }]),
  ),
  routes: Object.fromEntries(
    allKeys.sort().map((k) => [k, { features: (routesOf.get(k) ?? []).sort(), testedFamily: testedFamily(k.slice(k.indexOf(' ') + 1)) }]),
  ),
  unassigned: unassigned.map((k) => ({ route: k, proposedArea: proposedHome(k) })),
  ghostRoutes: ghosts,
  duplicateFeatureIds: duplicates,
};

if (WRITE) {
  fs.writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, INDEX)} (${features.size} features, ${allKeys.length} routes)`);
  process.exit(0);
}

if (JSON_OUT) {
  console.log(JSON.stringify(index, null, 2));
  process.exit(problems.length ? 1 : 0);
}

const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
console.log(`spec:      ${specFiles.length} files, ${features.size} feature IDs`);
console.log(`inventory: ${allKeys.length} route+method pairs across ${routes.size} paths`);
console.log(`named:     ${covered.size} (${pct(covered.size, allKeys.length)})`);
console.log(`unassigned:${String(unassigned.length).padStart(5)} (${pct(unassigned.length, allKeys.length)})`);
console.log(`features with a test that touches a route family: ${[...features.values()].filter((f) => f.tested).length}/${features.size} (${pct([...features.values()].filter((f) => f.tested).length, features.size)})`);
console.log(`documentation debt: ${pendingFeatures.length} pending entr${pendingFeatures.length === 1 ? 'y' : 'ies'} covering ${pendingRoutes.size} route(s)`);

console.log('\nby area');
console.log(`  ${'area'.padEnd(6)} ${'features'.padStart(9)} ${'tested'.padStart(7)} ${'routes'.padStart(7)}`);
for (const [d, v] of Object.entries(byDomain).sort()) {
  console.log(`  ${d.padEnd(6)} ${String(v.features).padStart(9)} ${String(v.tested).padStart(7)} ${String(v.routes).padStart(7)}`);
}

if (unassigned.length) {
  console.log('\nunassigned routes (documentation gaps)');
  const grouped = {};
  for (const k of unassigned) {
    const p = k.slice(k.indexOf(' ') + 1);
    const prefix = p.split('/')[1] || '/';
    (grouped[prefix] ??= []).push(k);
  }
  for (const [prefix, keys] of Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)) {
    const homes = [...new Set(keys.map(proposedHome))].join(',');
    console.log(`  /${prefix.padEnd(16)} ${String(keys.length).padStart(3)}   → area ${homes}   e.g. ${keys[0]}`);
  }
}

if (pendingFeatures.length) {
  console.log('\npending specification (behaviour unread — not coverage)');
  for (const f of pendingFeatures) console.log(`  ${f.id.padEnd(10)} ${String([...f.routes].length).padStart(3)} route(s)  ${f.title}`);
}

if (ghosts.length) {
  console.log('\ndocumented but not mounted (spec drift)');
  for (const k of ghosts) console.log(`  ${k}`);
}

if (problems.length) {
  console.log(`\nFAIL  ${problems.join('; ')}`);
  process.exit(1);
}
console.log('\nOK  every route is documented and every documented route exists');
