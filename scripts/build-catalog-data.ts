/**
 * Builds, signs and publishes the catalog data the phone apps use in standalone mode (names, search, observing programs and the planner
 * target list), so a catalog fix reaches the apps without an app release.
 *
 *   npx tsx scripts/build-catalog-data.ts [--force] [--dry-run] [--check]
 *
 * Runs from GitHub Actions (.github/workflows/build-catalog-data.yml). Needs the same secrets as the sky-image packs:
 *   CATALOG_PACK_SIGNING_KEY   base64 PKCS8 PEM of the Ed25519 key whose public half is in server/lib/catalogPack/trustedKey.ts
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default nebulis-releases)
 *
 * Does nothing when the version already published is the one this build produces (pass --force to publish anyway).
 *
 * Output: releases/catalog-data/<version>/*.deflate, manifest.json, manifest.json.sig; uploaded to catalog/v1/data/ with the versioned
 * files first and the manifest last, so a client that sees the new manifest always finds its files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CATALOG_DATA_FORMAT, CatalogDataManifest } from '../server/lib/catalogData/manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDN_BASE = 'https://downloads.nebulis.app/catalog/v1/data';
/** The first app release that reads this manifest. */
const MIN_APP_VERSION = '2.1.0';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY_RUN = Boolean(process.env.DRY_RUN) || args.has('--dry-run');

// Set DATA_DIR before any server module loads, so building the catalog never touches a real database.
process.env.DATA_DIR = process.env.BUILD_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-data-build-'));
process.env.LOGS_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-data-logs-'));

const { buildCatalogData } = await import('../server/lib/catalogData/build.js');
const { signManifest, sha256Buffer } = await import('../server/lib/catalogPack/verify.js');

const built = await buildCatalogData();

// --check: compare this catalog to the copies the iOS and Android apps ship, when this checkout sits beside them. For a release gate
// (the apps' own tests compare against the server too, but only once someone runs them).
if (args.has('--check')) {
  const { default: zlib } = await import('node:zlib');
  const { default: crypto } = await import('node:crypto');
  const versionOf = (dir: string): string | null => {
    try {
      const inflate = (f: string) => zlib.inflateRawSync(fs.readFileSync(path.join(dir, f)));
      return crypto.createHash('sha256').update(inflate('catalog-bundle.json.deflate')).update('\n').update(inflate('planner-targets.json.deflate')).digest('hex').slice(0, 12);
    } catch { return null; }
  };
  const copies: Array<[string, string]> = [
    ['iOS', path.join(ROOT, '..', 'nebulis-apple', 'NebulisIOS', 'Resources')],
    ['Android', path.join(ROOT, '..', 'nebulis-android', 'app', 'src', 'main', 'assets')],
  ];
  let stale = false;
  for (const [name, dir] of copies) {
    const v = versionOf(dir);
    if (v === null) { console.log(`[check] ${name}: not found at ${dir} (skipped)`); continue; }
    const ok = v === built.version;
    stale ||= !ok;
    console.log(`[check] ${name}: ${v} ${ok ? 'matches' : `is STALE, the server builds ${built.version}`}`);
  }
  if (stale) console.error('[check] Refresh the apps: run spikes/direct-mode/catalog/gen-catalog.mts (command in CLAUDE.md, "Catalog data") and copy the two .deflate files into both apps.');
  process.exit(stale ? 1 : 0);
}
console.log(`[data] built version ${built.version}: ${built.plannerCount} planner targets, bundle ${built.packed.length} B, planner ${built.plannerPacked.length} B`);

const manifest: CatalogDataManifest = CatalogDataManifest.parse({
  kind: 'catalog-data',
  formatVersion: CATALOG_DATA_FORMAT,
  version: built.version,
  generatedAt: new Date().toISOString(),
  minAppVersion: MIN_APP_VERSION,
  plannerTargets: built.plannerCount,
  files: [
    { path: 'catalog-bundle.json.deflate', sha256: sha256Buffer(built.packed), bytes: built.packed.length },
    { path: 'planner-targets.json.deflate', sha256: sha256Buffer(built.plannerPacked), bytes: built.plannerPacked.length },
  ],
});

if (!FORCE && !DRY_RUN) {
  try {
    const res = await fetch(`${CDN_BASE}/manifest.json`, { signal: AbortSignal.timeout(30_000), headers: { 'Cache-Control': 'no-cache' } });
    if (res.ok) {
      const live = CatalogDataManifest.safeParse(await res.json());
      if (live.success && live.data.version === manifest.version) {
        console.log(`[data] version ${manifest.version} is already published. Nothing to do (use --force to publish anyway).`);
        process.exit(0);
      }
    }
  } catch (err) {
    console.warn('[data] Could not read the live manifest, publishing:', err instanceof Error ? err.message : err);
  }
}

const OUT_DIR = path.join(ROOT, 'releases', 'catalog-data');
const versionDir = path.join(OUT_DIR, manifest.version);
fs.mkdirSync(versionDir, { recursive: true });
fs.writeFileSync(path.join(versionDir, 'catalog-bundle.json.deflate'), built.packed);
fs.writeFileSync(path.join(versionDir, 'planner-targets.json.deflate'), built.plannerPacked);

const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
const manifestPath = path.join(OUT_DIR, 'manifest.json');
fs.writeFileSync(manifestPath, manifestBuf);

const signingKeyB64 = process.env.CATALOG_PACK_SIGNING_KEY;
if (!signingKeyB64) {
  if (DRY_RUN) {
    console.log(`[data] DRY_RUN without a signing key: wrote an unsigned manifest to ${OUT_DIR}`);
    process.exit(0);
  }
  console.error('CATALOG_PACK_SIGNING_KEY env var is required.');
  process.exit(1);
}
const manifestSig = signManifest(manifestBuf, Buffer.from(signingKeyB64, 'base64').toString('utf8'));
const sigPath = path.join(OUT_DIR, 'manifest.json.sig');
fs.writeFileSync(sigPath, manifestSig);

if (DRY_RUN) {
  console.log(`[data] DRY_RUN: signed and written to ${OUT_DIR}, not uploaded.`);
  process.exit(0);
}

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET ?? 'nebulis-releases';
if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('[data] R2 credentials not set. Provide R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or use --dry-run.');
  process.exit(1);
}
const s3 = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });

async function upload(localPath: string, key: string, contentType: string, immutable: boolean): Promise<void> {
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    CacheControl: immutable ? 'max-age=31536000, immutable' : 'max-age=300',
  }));
  console.log(`[upload] s3://${bucket}/${key} (${(body.length / 1024).toFixed(1)} KB)`);
}

for (const f of manifest.files) {
  await upload(path.join(versionDir, f.path), `catalog/v1/data/${manifest.version}/${f.path}`, 'application/octet-stream', true);
}
// The manifest goes last: once it is live, every file it names is already there.
await upload(manifestPath, 'catalog/v1/data/manifest.json', 'application/json', false);
await upload(sigPath, 'catalog/v1/data/manifest.json.sig', 'text/plain', false);
console.log(`[data] Published catalog data ${manifest.version}.`);

