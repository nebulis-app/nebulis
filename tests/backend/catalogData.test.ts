/**
 * The catalog data the phone apps download for standalone mode: the manifest format, the content-hash version, signing, and that what
 * the generator bakes agrees with the server's own catalog functions (so a catalog edit that is not republished is visible here).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { signManifest, verifyWithKey, sha256Buffer } from '../../server/lib/catalogPack/verify';
import { CATALOG_DATA_FORMAT, CATALOG_DATA_FILES, CatalogDataManifest } from '../../server/lib/catalogData/manifest';
import { buildCatalogData, type CatalogData } from '../../server/lib/catalogData/build';
import { getPlannerCatalog } from '../../server/lib/dsoCatalog';
import { resolveCanonicalId } from '../../server/lib/catalogAliases';

let built: CatalogData;

beforeAll(async () => {
  built = await buildCatalogData();
}, 120_000);

function manifestFor(data: CatalogData): CatalogDataManifest {
  return CatalogDataManifest.parse({
    kind: 'catalog-data',
    formatVersion: CATALOG_DATA_FORMAT,
    version: data.version,
    generatedAt: '2026-10-31T00:00:00.000Z',
    minAppVersion: '2.1.0',
    plannerTargets: data.plannerCount,
    files: [
      { path: 'catalog-bundle.json.deflate', sha256: sha256Buffer(data.packed), bytes: data.packed.length },
      { path: 'planner-targets.json.deflate', sha256: sha256Buffer(data.plannerPacked), bytes: data.plannerPacked.length },
    ],
  });
}

describe('catalog data manifest', () => {
  it('accepts what the build produces and names every file once', () => {
    const m = manifestFor(built);
    expect(m.files.map(f => f.path).sort()).toEqual([...CATALOG_DATA_FILES].sort());
  });

  it('rejects a version that is not a 12-character content hash', () => {
    const m = manifestFor(built);
    expect(CatalogDataManifest.safeParse({ ...m, version: '2' }).success).toBe(false);
    expect(CatalogDataManifest.safeParse({ ...m, version: 'ABCDEF012345' }).success).toBe(false);
  });

  it('rejects an unknown file and a missing one', () => {
    const m = manifestFor(built);
    expect(CatalogDataManifest.safeParse({ ...m, files: [{ ...m.files[0], path: 'evil.sh' }, m.files[1]] }).success).toBe(false);
    expect(CatalogDataManifest.safeParse({ ...m, files: [m.files[0]] }).success).toBe(false);
  });

  it('verifies under the signing key and fails when a byte changes', () => {
    const kp = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const bytes = Buffer.from(JSON.stringify(manifestFor(built), null, 2));
    const sig = signManifest(bytes, kp.privateKey);
    expect(verifyWithKey(bytes, sig, kp.publicKey)).toBe(true);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 3] ^= 1;
    expect(verifyWithKey(tampered, sig, kp.publicKey)).toBe(false);
  });
});

describe('buildCatalogData', () => {
  it('versions by the uncompressed content, so the apps can recompute it from their own copy', () => {
    const inflate = (b: Buffer) => zlib.inflateRawSync(b);
    const v = crypto.createHash('sha256').update(inflate(built.packed)).update('\n').update(inflate(built.plannerPacked)).digest('hex').slice(0, 12);
    expect(built.version).toBe(v);
  });

  it('is repeatable', async () => {
    const again = await buildCatalogData();
    expect(again.version).toBe(built.version);
  });

  it('bakes the server\'s own planner list', () => {
    expect(built.plannerCount).toBe(getPlannerCatalog().length);
    const rows = JSON.parse(zlib.inflateRawSync(built.plannerPacked).toString('utf8')) as unknown[][];
    expect(rows).toHaveLength(built.plannerCount);
  });

  it('carries the aliases the server resolves', () => {
    const bundle = JSON.parse(zlib.inflateRawSync(built.packed).toString('utf8')) as { format: number; aliases: Record<string, string> };
    expect(bundle.format).toBe(1);
    const entries = Object.entries(bundle.aliases);
    expect(entries.length).toBeGreaterThan(500);
    // Every alias the apps will use is exactly what the server resolves it to today.
    const wrong = entries.filter(([from, to]) => resolveCanonicalId(from) !== to).map(([from]) => from);
    expect(wrong).toEqual([]);
  });
});
