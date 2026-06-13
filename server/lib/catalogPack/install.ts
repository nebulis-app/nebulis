/**
 * Catalog pack installer — Phase 0 of the prefetch job.
 *
 * For each tier the caller requests:
 *   1. Fetch index.json + signature; verify with Ed25519 public key.
 *   2. Check catalogPackState — skip tiers already at the current version.
 *   3. Fetch tier manifest.json + signature; verify.
 *   4. Download archive to tmp; verify SHA-256 matches manifest.
 *   5. Extract to isolated tmp directory (path + size guards).
 *   6. Verify per-file SHA-256 from signed manifest.
 *   7. Import descriptions.json into catalogCache.
 *   8. Move images into sky-cache/.
 *   9. Run prewarmThumbnails for each image.
 *  10. Record version in catalogPackState.
 *  11. Clean up tmp directory.
 *
 * A failure at any step leaves sky-cache/ untouched for that tier.
 * The caller falls back to live-scrape phases for uncovered objects.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import db from '../db.js';
import { DATA_DIR } from '../paths.js';
import { PackIndex, PackManifest, PackDescriptions, type CatalogTier } from './manifest.js';
import { verifyManifestSignature, verifyFileSha256, sha256File } from './verify.js';
import { downloadToFile, fetchJson, fetchText } from './download.js';
import { extractPack } from './unpack.js';
import { getPackState, setPackState } from './state.js';
import { resolveCanonicalId } from '../catalogAliases.js';

const PACK_INDEX_URL = 'https://downloads.nebulis.app/catalog/v1/index.json';
const PACK_INDEX_SIG_URL = 'https://downloads.nebulis.app/catalog/v1/index.json.sig';
const BOMB_MARGIN = 1.10; // allow up to 10% over declared totalBytes

export interface InstallResult {
  tier: CatalogTier;
  version: string;
  objectCount: number;
  skipped?: boolean;
  reason?: string;
}

const upsertCacheStmt = db.prepare(
  `INSERT INTO catalogCache (objectId, extract, wikiUrl, source, fetchedAt, status)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(objectId) DO UPDATE SET
     extract   = excluded.extract,
     wikiUrl   = excluded.wikiUrl,
     source    = excluded.source,
     fetchedAt = excluded.fetchedAt,
     status    = excluded.status`,
);

/**
 * Install (or skip if up-to-date) the requested catalog tiers.
 *
 * @param tiers   - Tiers to install. Typically ['messier','caldwell'] for curated scope.
 * @param signal  - Abort signal from the parent prefetch job.
 * @param prewarm - Called for each installed image to warm resize cache.
 * @returns Results per tier (installed or skipped).
 */
export async function installCatalogPacks(
  tiers: CatalogTier[],
  signal: AbortSignal,
  prewarm: (id: string, masterPath: string, source: 'hubble' | 'dss2') => Promise<void>,
): Promise<InstallResult[]> {
  // ── Fetch + verify index ────────────────────────────────────────────────
  let indexBuf: Buffer;
  let indexSig: string;
  try {
    [indexBuf, indexSig] = await Promise.all([
      fetchJson(PACK_INDEX_URL, signal),
      fetchText(PACK_INDEX_SIG_URL, signal),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[catalogPack] index fetch failed: ${msg}`);
    return tiers.map(tier => ({ tier, version: '', objectCount: 0, skipped: true, reason: 'index_fetch_failed' }));
  }

  if (!verifyManifestSignature(indexBuf, indexSig)) {
    console.warn('[catalogPack] index.json signature verification failed — skipping all packs');
    return tiers.map(tier => ({ tier, version: '', objectCount: 0, skipped: true, reason: 'index_sig_invalid' }));
  }

  let index: PackIndex;
  try {
    index = PackIndex.parse(JSON.parse(indexBuf.toString('utf8')));
  } catch (err) {
    console.warn('[catalogPack] index.json parse error:', err instanceof Error ? err.message : err);
    return tiers.map(tier => ({ tier, version: '', objectCount: 0, skipped: true, reason: 'index_parse_error' }));
  }

  const results: InstallResult[] = [];

  for (const tier of tiers) {
    if (signal.aborted) break;
    const result = await installTier(tier, index, signal, prewarm);
    results.push(result);
  }

  return results;
}

async function installTier(
  tier: CatalogTier,
  index: PackIndex,
  signal: AbortSignal,
  prewarm: (id: string, masterPath: string, source: 'hubble' | 'dss2') => Promise<void>,
): Promise<InstallResult> {
  const entry = index.tiers.find(t => t.tier === tier);
  if (!entry) {
    return { tier, version: '', objectCount: 0, skipped: true, reason: 'not_in_index' };
  }

  // Skip if already installed at this version
  const existing = getPackState(tier);
  if (existing?.version === entry.version) {
    console.log(`[catalogPack] ${tier} v${entry.version} already installed — skipping`);
    return { tier, version: entry.version, objectCount: existing.objectCount, skipped: true, reason: 'already_installed' };
  }

  console.log(`[catalogPack] installing ${tier} v${entry.version} (${entry.totalObjects} objects)`);

  const tmpDir = path.join(DATA_DIR, 'tmp', `pack-${tier}-${entry.version}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // ── Fetch + verify tier manifest ──────────────────────────────────────
    let manifestBuf: Buffer;
    let manifestSig: string;
    try {
      [manifestBuf, manifestSig] = await Promise.all([
        fetchJson(entry.manifestUrl, signal),
        fetchText(entry.manifestSigUrl, signal),
      ]);
    } catch (err) {
      throw new Error(`manifest fetch failed: ${err instanceof Error ? err.message : err}`);
    }

    if (!verifyManifestSignature(manifestBuf, manifestSig)) {
      throw new Error('manifest signature verification failed');
    }

    let manifest: PackManifest;
    try {
      manifest = PackManifest.parse(JSON.parse(manifestBuf.toString('utf8')));
    } catch (err) {
      throw new Error(`manifest parse error: ${err instanceof Error ? err.message : err}`);
    }

    // ── Download archive ──────────────────────────────────────────────────
    const archivePath = path.join(tmpDir, `${tier}-${entry.version}.tar.gz`);
    await downloadToFile(entry.archiveUrl, archivePath, signal, (written, total) => {
      if (total && written % (5 * 1024 * 1024) < 65536) {
        console.log(`[catalogPack] ${tier} download: ${Math.round(written / 1024 / 1024)}/${Math.round(total / 1024 / 1024)} MB`);
      }
    });

    if (signal.aborted) throw new Error('aborted');

    // Verify archive SHA-256 against the signed manifest
    const actualArchiveSha256 = sha256File(archivePath);
    if (actualArchiveSha256 !== entry.archiveSha256) {
      throw new Error(`archive SHA-256 mismatch for ${tier}: expected ${entry.archiveSha256}, got ${actualArchiveSha256}`);
    }

    // ── Extract to tmp ────────────────────────────────────────────────────
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    const maxBytes = Math.ceil(manifest.totalBytes * BOMB_MARGIN);
    await extractPack(archivePath, extractDir, maxBytes);

    if (signal.aborted) throw new Error('aborted');

    // ── Verify per-file SHA-256 ───────────────────────────────────────────
    for (const fileEntry of manifest.files) {
      const extractedPath = path.join(extractDir, fileEntry.path);
      if (!fs.existsSync(extractedPath)) {
        throw new Error(`missing file after extraction: ${fileEntry.path} in ${tier} pack`);
      }
      if (!verifyFileSha256(extractedPath, fileEntry.sha256)) {
        throw new Error(`SHA-256 mismatch for ${fileEntry.path} in ${tier} pack`);
      }
    }

    // ── Import descriptions into catalogCache ─────────────────────────────
    const descriptionsPath = path.join(extractDir, 'descriptions.json');
    if (fs.existsSync(descriptionsPath)) {
      const raw = JSON.parse(fs.readFileSync(descriptionsPath, 'utf8'));
      const descriptions = PackDescriptions.parse(raw);
      const now = Date.now();
      for (const [objectId, desc] of Object.entries(descriptions)) {
        upsertCacheStmt.run(resolveCanonicalId(objectId), desc.extract, desc.sourceUrl, desc.source, now, desc.status);
      }
      console.log(`[catalogPack] ${tier}: imported ${Object.keys(descriptions).length} descriptions`);
    }

    // ── Move images into sky-cache/ ───────────────────────────────────────
    const skyCache = path.join(DATA_DIR, 'sky-cache');
    fs.mkdirSync(skyCache, { recursive: true });

    // ── Persist credits.json alongside sky-cache ──────────────────────────
    const creditsPath = path.join(extractDir, 'credits.json');
    if (fs.existsSync(creditsPath)) {
      fs.copyFileSync(creditsPath, path.join(skyCache, `credits-${tier}.json`));
    }

    const imagesExtractDir = path.join(extractDir, 'images');
    let imagesMoved = 0;

    if (fs.existsSync(imagesExtractDir)) {
      const imageFiles = fs.readdirSync(imagesExtractDir);
      const concurrency = Math.max(2, Math.min(4, os.cpus().length));

      // Process images concurrently — sharp/libvips uses a thread pool so
      // parallel prewarm calls saturate available cores instead of queuing.
      let movedCount = 0; // accumulated across workers via closure, safe because JS is single-threaded
      const queue = imageFiles.slice();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (queue.length > 0) {
          if (signal.aborted) throw new Error('aborted');
          const filename = queue.shift();
          if (!filename) break;

          const src = path.join(imagesExtractDir, filename);

          // Derive the object id from the filename, then resolve to canonical.
          // sh2_N_hubble_*.webp is the legacy naming used by the v1 sharpless pack;
          // future packs use hubble_SH2-N.webp directly.
          const sharplessHubbleMatch = filename.match(/^sh2_(\d+)_hubble_.*\.webp$/);
          const isHubble = filename.startsWith('hubble_') || sharplessHubbleMatch !== null;
          const source: 'hubble' | 'dss2' = isHubble ? 'hubble' : 'dss2';
          const rawId = sharplessHubbleMatch
            ? `SH2-${sharplessHubbleMatch[1]}`
            : isHubble
              ? filename.replace(/^hubble_/, '').replace(/\.webp$/, '')
              : filename.replace(/_master\.jpg$/, '');
          const canonicalId = resolveCanonicalId(rawId);

          // Rewrite the dest filename under the canonical id so lookups always hit.
          const canonicalFilename = isHubble
            ? `hubble_${canonicalId}.webp`
            : `${canonicalId.toUpperCase().replace(/\s+/g, '')}_master.jpg`;
          const dest = path.join(skyCache, canonicalFilename);

          // Don't overwrite an existing file (live-scraped or from another pack).
          let skip = false;
          try {
            const stat = fs.statSync(dest);
            if (stat.size > 0) skip = true;
          } catch { /* not present */ }

          if (!skip) {
            fs.renameSync(src, dest);
            movedCount++;

            try {
              await prewarm(canonicalId, dest, source);
            } catch (err) {
              console.warn(`[catalogPack] prewarm failed for ${filename}:`, err instanceof Error ? err.message : err);
            }
          }
        }
      }));
      imagesMoved = movedCount;

      console.log(`[catalogPack] ${tier}: moved ${imagesMoved} images into sky-cache`);
    }

    // ── Record success ────────────────────────────────────────────────────
    setPackState(tier, entry.version, entry.totalObjects);
    return { tier, version: entry.version, objectCount: entry.totalObjects };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== 'aborted') {
      console.warn(`[catalogPack] ${tier} install failed: ${msg}`);
    }
    return { tier, version: '', objectCount: 0, skipped: true, reason: msg };
  } finally {
    // Best-effort cleanup of the tmp directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
