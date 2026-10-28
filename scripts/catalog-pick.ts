#!/usr/bin/env tsx
/**
 * Hand-pick catalog pack pictures.
 *
 *   npx tsx scripts/catalog-pick.ts list [--pending]
 *   npx tsx scripts/catalog-pick.ts set IC63 <file-or-https-url> --credit "ESA/Hubble & NASA" \
 *       --license cc-by-4.0 --source-url https://esahubble.org/images/...
 *   npx tsx scripts/catalog-pick.ts drop-hubble M44        discard the scraped NASA picture
 *   npx tsx scripts/catalog-pick.ts drop-dss2 SH2-17       discard the sky plate
 *   npx tsx scripts/catalog-pick.ts dss2-fov IC1805 120    re-fetch the sky plate 120 arcmin wide
 *   npx tsx scripts/catalog-pick.ts survey SH2-31 dss2     use the photographic plate, not the VPHAS+ one (or `vphas`)
 *   npx tsx scripts/catalog-pick.ts waive NGC2392 notch    accept a quirk the checks reject
 *   npx tsx scripts/catalog-pick.ts clear IC63             remove every override for an object
 *   npx tsx scripts/catalog-pick.ts check                  run the checks over every pick
 *
 * A picture you set is resized, saved as WebP in server/data/catalog-images/files and
 * recorded in overrides.json with its credit, so a pack build needs no URL and no
 * network for it. The picture is checked first: it is refused if it has a mosaic hole,
 * is a thin strip, carries a red label box, or (when tesseract is installed) has words
 * in it. Layout and sources: the private catalog images notes.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  OVERRIDES_DIR, loadNeedsPick, loadOverrides, pickedFilePath, saveOverrides, validateOverrides, type OverrideEntry,
} from '../server/lib/catalogPack/imageOverrides.js';
import {
  analyzeImage, findDuplicate, findText, HARD_PROBLEMS, IMAGE_PROBLEMS, ocrAvailable, qualityProblems, type ImageProblem,
} from '../server/lib/catalogPack/imageQuality.js';
import { resolveCanonicalId } from '../server/lib/catalogAliases.js';
import { SOLAR_SYSTEM_CATALOG } from '../server/data/solar-system-catalog.js';

// Planets and moons are meant to sit on a black field, so a black edge is not a mosaic hole.
const SOLAR_IDS = new Set(SOLAR_SYSTEM_CATALOG.map(e => e.id));

const LICENSES: Record<string, string> = {
  'cc-by-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'cc0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'nasa': 'https://www.nasa.gov/multimedia/guidelines/index.html',
};
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024;
const LONG_EDGE = 2400;

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`catalog-pick: ${message}`);
  process.exit(1);
}

function canonical(raw: string | undefined): string {
  if (!raw) fail('an object id is needed (for example IC63, M44, SH2-17)');
  const id = resolveCanonicalId(raw);
  if (id !== raw) console.log(`${raw} is filed as ${id}`);
  return id;
}

async function readSource(source: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(source)) {
    if (!/^https:\/\//i.test(source)) fail('only https:// addresses are downloaded');
    const res = await fetch(source, { headers: { 'User-Agent': 'Nebulis catalog-pick (https://nebulis.app)' } });
    if (!res.ok) fail(`download failed: HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) fail(`that address is not a picture (it is ${type || 'unknown'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) fail('that picture is over 60 MB');
    return buf;
  }
  if (!fs.existsSync(source)) fail(`no such file: ${source}`);
  return fs.readFileSync(source);
}

async function signaturesOfOtherPicks(except: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [id, entry] of loadOverrides().entries) {
    if (id === except || !entry.image) continue;
    out.set(id, (await analyzeImage(pickedFilePath(entry.image.file))).signature);
  }
  return out;
}

async function cmdSet(positional: string[], flags: Map<string, string | true>): Promise<void> {
  const id = canonical(positional[0]);
  const source = positional[1];
  if (!source) fail('say where the picture is: a file path or an https address');
  const credit = flags.get('credit');
  const sourceUrl = flags.get('source-url');
  const licenseFlag = flags.get('license');
  const licenseUrl = flags.get('license-url') ?? (typeof licenseFlag === 'string' ? LICENSES[licenseFlag] : undefined);
  if (typeof credit !== 'string' || typeof sourceUrl !== 'string' || typeof licenseUrl !== 'string') {
    fail(`--credit, --source-url and --license are needed (licenses: ${Object.keys(LICENSES).join(', ')}; or give --license-url)`);
  }

  const raw = await readSource(source);
  const webp = await sharp(raw).rotate().flatten({ background: '#000000' })
    .resize(LONG_EDGE, LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 }).toBuffer();

  const tmp = path.join(OVERRIDES_DIR, `.pick-${process.pid}.webp`);
  fs.mkdirSync(path.join(OVERRIDES_DIR, 'files'), { recursive: true });
  fs.writeFileSync(tmp, webp);
  try {
    const stats = await analyzeImage(tmp);
    const problems = qualityProblems(stats, { blackBackgroundOk: SOLAR_IDS.has(id) });
    const dup = findDuplicate(stats.signature, await signaturesOfOtherPicks(id));
    if (dup) problems.push('duplicate');
    // A hand pick exists to be better than the scraped picture, so a narrow one is refused too.
    const blocking = problems.filter(p => HARD_PROBLEMS.includes(p) || p === 'small');

    console.log(`${stats.width}x${stats.height}, ${(webp.length / 1024).toFixed(0)} KB${problems.length ? `, flagged: ${problems.join(', ')}` : ', passes the automatic checks'}`);
    if (blocking.length > 0 && !flags.has('force')) {
      fail(`refused: ${blocking.join(', ')}${dup ? ` (looks the same as your pick for ${dup})` : ''}. Choose another picture, or use --force if a person has judged it fine.`);
    }
    if (await ocrAvailable()) {
      const words = await findText(tmp);
      if (words.length > 0 && !flags.has('allow-text')) {
        fail(`refused: the picture has words in it (${words.slice(0, 6).join(', ')}). Pictures must carry no text. Use --allow-text only if those are not real words.`);
      }
    } else {
      console.warn('tesseract is not installed, so the picture was NOT checked for text. Look at it yourself, or install tesseract.');
    }

    const file = `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.webp`;
    fs.renameSync(tmp, pickedFilePath(file));
    const entries = new Map(loadOverrides().entries);
    // The picture replaces the Hubble one, so a hubble:drop left from before no longer applies.
    const rest: OverrideEntry = { ...(entries.get(id) ?? {}) };
    delete rest.hubble;
    entries.set(id, { ...rest, image: { file, credit, licenseUrl, sourceUrl } });
    saveOverrides(entries);
    console.log(`saved ${path.relative(process.cwd(), pickedFilePath(file))} for ${id}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function update(id: string, change: (entry: OverrideEntry) => OverrideEntry | null): void {
  const entries = new Map(loadOverrides().entries);
  const next = change(entries.get(id) ?? {});
  if (next === null) entries.delete(id); else entries.set(id, next);
  saveOverrides(entries);
}

function cmdList(flags: Map<string, string | true>): void {
  const overrides = loadOverrides().entries;
  const needs = loadNeedsPick();
  const pendingOnly = flags.has('pending');
  let pending = 0;
  for (const row of needs) {
    const entry = overrides.get(row.id);
    const state = entry ? (entry.image ? 'PICKED ' : 'decided') : 'PENDING';
    if (!entry) pending++;
    if (pendingOnly && entry) continue;
    console.log(`${state}  ${row.id.padEnd(10)} ${row.reason}`);
  }
  const listed = new Set(needs.map(r => r.id));
  const extra = [...overrides].filter(([id]) => !listed.has(id));
  if (!pendingOnly && extra.length) {
    console.log('\nOther overrides:');
    for (const [id, e] of extra) console.log(`  ${id.padEnd(10)} ${[e.image && 'picture', e.hubble && 'hubble dropped', e.dss2 && 'dss2 changed', e.waive && `waive ${e.waive.join('+')}`].filter(Boolean).join(', ')}${e.note ? ` (${e.note})` : ''}`);
  }
  console.log(`\n${needs.length - pending} of ${needs.length} listed objects have a decision; ${pending} still need one.`);
}

async function cmdCheck(): Promise<void> {
  const overrides = loadOverrides();
  const problems = validateOverrides(overrides);
  let bad = 0;
  const seen = new Map<string, string>();
  for (const [id, entry] of overrides.entries) {
    if (!entry.image) continue;
    const stats = await analyzeImage(pickedFilePath(entry.image.file, overrides.dir));
    const found: ImageProblem[] = qualityProblems(stats, { blackBackgroundOk: SOLAR_IDS.has(id) }).filter(p => (HARD_PROBLEMS.includes(p) || p === 'small') && !(entry.waive ?? []).includes(p));
    const dup = findDuplicate(stats.signature, seen);
    if (dup && !(entry.waive ?? []).includes('duplicate')) found.push('duplicate');
    seen.set(id, stats.signature);
    if (found.length) { bad++; console.log(`${id}: ${found.join(', ')}`); }
  }
  for (const p of problems) console.log(p);
  console.log(problems.length + bad === 0 ? `all ${overrides.entries.size} overrides are fine` : `${problems.length + bad} problem(s)`);
  if (problems.length + bad > 0) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

switch (command) {
  case 'list': cmdList(flags); break;
  case 'set': await cmdSet(positional, flags); break;
  case 'drop-hubble': { const id = canonical(positional[0]); update(id, e => ({ ...e, hubble: 'drop' })); console.log(`the scraped Hubble picture for ${id} will be left out`); break; }
  case 'drop-dss2': { const id = canonical(positional[0]); update(id, e => ({ ...e, dss2: 'drop' })); console.log(`the sky plate for ${id} will be left out`); break; }
  case 'dss2-fov': {
    const id = canonical(positional[0]);
    const arcmin = Number(positional[1]);
    if (!Number.isFinite(arcmin)) fail('give the plate width in arcminutes, for example 120');
    update(id, e => ({ ...e, dss2: { ...(e.dss2 && e.dss2 !== 'drop' ? e.dss2 : {}), fovArcmin: arcmin } }));
    console.log(`the sky plate for ${id} will be ${arcmin} arcminutes wide`);
    break;
  }
  case 'survey': {
    const id = canonical(positional[0]);
    const survey = positional[1];
    if (survey !== 'vphas' && survey !== 'dss2') fail('say which: dss2 (photographic plate) or vphas (H-alpha survey)');
    update(id, e => ({ ...e, dss2: { ...(e.dss2 && e.dss2 !== 'drop' ? e.dss2 : {}), survey } }));
    console.log(`the sky plate for ${id} will come from ${survey === 'vphas' ? 'the VPHAS+ survey' : 'DSS2'}`);
    break;
  }
  case 'waive': {
    const id = canonical(positional[0]);
    const wanted = positional.slice(1);
    const bad = wanted.filter(w => !(IMAGE_PROBLEMS as readonly string[]).includes(w));
    if (wanted.length === 0 || bad.length) fail(`name what to accept: ${IMAGE_PROBLEMS.join(', ')}`);
    update(id, e => ({ ...e, waive: [...new Set([...(e.waive ?? []), ...wanted.filter((w): w is ImageProblem => (IMAGE_PROBLEMS as readonly string[]).includes(w))])], ...(typeof flags.get('note') === 'string' ? { note: String(flags.get('note')) } : {}) }));
    console.log(`${id}: accepting ${wanted.join(', ')}`);
    break;
  }
  case 'clear': {
    const id = canonical(positional[0]);
    const entry = loadOverrides().entries.get(id);
    update(id, () => null);
    if (entry?.image) fs.rmSync(pickedFilePath(entry.image.file), { force: true });
    console.log(`cleared ${id}`);
    break;
  }
  case 'check': await cmdCheck(); break;
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
    if (command) process.exit(1);
}
