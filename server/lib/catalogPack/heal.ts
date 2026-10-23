/**
 * Detecting and clearing stale pack images already sitting in sky-cache/.
 *
 * Pack manifests are signed and carry a SHA-256 for every image. A Hubble
 * master on disk is copied byte for byte from a pack (the installer renames
 * it, nothing more), so a local file whose hash differs from the manifest is
 * not the image the pack ships. That happened for real: an old live scraper
 * wrote the Crab Nebula over M24, M35, M44, M46, M48, M67 and M75, and the
 * installer's "never overwrite an existing file" guard then kept those files
 * through every later pack install.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, fetchText } from './download.js';
import { verifyManifestSignature, sha256File } from './verify.js';
import { PackManifest, type CatalogTier, type PackIndex } from './manifest.js';
import { resolveCanonicalId } from '../catalogAliases.js';

const HUBBLE_PACK_PATH = /^images\/hubble_(.+)\.webp$/;

/** Where a pack's `images/hubble_<ID>.webp` lives in sky-cache/, or null for
 *  any other pack file. Mirrors the installer's canonical-id rename. */
export function localHubbleMasterPath(skyCacheDir: string, packPath: string): string | null {
  const match = HUBBLE_PACK_PATH.exec(packPath);
  if (!match) return null;
  return path.join(skyCacheDir, `hubble_${resolveCanonicalId(match[1])}.webp`);
}

/**
 * Manifest paths of Hubble masters that exist locally but do not match the
 * manifest's hash. A master that is simply absent is not stale: nothing wrong
 * is being served, and the normal install fills it in.
 */
export function findStaleHubbleMasters(
  files: ReadonlyArray<{ path: string; sha256: string }>,
  skyCacheDir: string,
): string[] {
  const stale: string[] = [];
  for (const file of files) {
    const local = localHubbleMasterPath(skyCacheDir, file.path);
    if (!local) continue;
    try {
      if (fs.statSync(local).size > 0 && sha256File(local) !== file.sha256) stale.push(file.path);
    } catch { /* absent or unreadable: not stale */ }
  }
  return stale;
}

/**
 * Delete the resized thumbnails made from one source's master of an object.
 * They are keyed on id, source and size, never on content, so replacing a
 * master without this leaves the old picture served from `resized/` for good.
 */
export function purgeResizedThumbnails(skyCacheDir: string, canonicalId: string, source: string): number {
  const resizedDir = path.join(skyCacheDir, 'resized');
  // Same normalisation as resizedImagePath() in catalogPrefetch.ts, which this
  // module cannot import without a cycle.
  const normalized = canonicalId.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9_.-]/g, '_');
  const prefix = `${normalized}_${source}_`;
  let removed = 0;
  let names: string[];
  try { names = fs.readdirSync(resizedDir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jpg')) continue;
    try { fs.unlinkSync(path.join(resizedDir, name)); removed++; } catch { /* already gone */ }
  }
  return removed;
}

/**
 * Of the given installed tiers, those whose signed manifest says at least one
 * local Hubble master is stale. Costs two small requests per tier and no
 * archive download. A tier whose manifest cannot be fetched or verified is
 * left alone.
 */
export async function findTiersWithStaleMasters(
  index: PackIndex,
  tiers: readonly CatalogTier[],
  skyCacheDir: string,
  signal: AbortSignal,
): Promise<Set<CatalogTier>> {
  const stale = new Set<CatalogTier>();
  for (const tier of tiers) {
    const entry = index.tiers.find(t => t.tier === tier);
    if (!entry) continue;
    try {
      const [buf, sig] = await Promise.all([
        fetchJson(entry.manifestUrl, signal),
        fetchText(entry.manifestSigUrl, signal),
      ]);
      if (!verifyManifestSignature(buf, sig)) continue;
      const manifest = PackManifest.parse(JSON.parse(buf.toString('utf8')));
      const paths = findStaleHubbleMasters(manifest.files, skyCacheDir);
      if (paths.length > 0) {
        console.log(`[catalogPack] ${tier}: ${paths.length} local Hubble master(s) differ from the pack, scheduling repair`);
        stale.add(tier);
      }
    } catch { /* offline or malformed: try again at the next check */ }
  }
  return stale;
}
