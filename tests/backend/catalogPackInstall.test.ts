import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Own DATA_DIR so sky-cache/ starts empty and nothing leaks into the shared one
// (paths.ts captures DATA_DIR at import time).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _crypto = require('crypto') as typeof import('crypto');
  const root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(root, 'nebulis-packinstall-test-'));
  process.env.DATA_DIR = dir;
  const { publicKey, privateKey } = _crypto.generateKeyPairSync('ed25519');
  (globalThis as Record<string, unknown>).__packTestKeys = {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  return dir;
});

const keys = (globalThis as unknown as { __packTestKeys: { publicPem: string; privatePem: string } }).__packTestKeys;

// Trust the test key, so the real Ed25519 verification runs against real signatures.
vi.mock('../../server/lib/catalogPack/trustedKey', () => ({
  TRUSTED_PUBLIC_KEY_PEM: (globalThis as unknown as { __packTestKeys: { publicPem: string } }).__packTestKeys.publicPem,
}));

// The only thing faked is the network: URL -> bytes.
const served = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../server/lib/catalogPack/download', async () => {
  const _fs = await import('node:fs');
  const get = (url: string): Buffer => {
    const buf = served.get(url);
    if (!buf) throw new Error(`HTTP 404 for ${url}`);
    return buf;
  };
  return {
    fetchJson: async (url: string) => get(url),
    fetchText: async (url: string) => get(url).toString('utf8'),
    downloadToFile: async (url: string, dest: string) => { _fs.writeFileSync(dest, get(url)); },
  };
});

import archiver from 'archiver';
import { installCatalogPacks } from '../../server/lib/catalogPack/install';
import { signManifest, sha256Buffer } from '../../server/lib/catalogPack/verify';
import { getPackState, clearPackState } from '../../server/lib/catalogPack/state';
import db from '../../server/lib/db';

const BASE = 'https://downloads.nebulis.app/catalog/v1';
const INDEX_URL = `${BASE}/index.json`;
const SKY_CACHE = path.join(TEST_DATA_DIR, 'sky-cache');
const TMP_PACK_DIR = path.join(TEST_DATA_DIR, "tmp", "pack-messier-1");

const HUBBLE = Buffer.from('hubble-bytes-for-m31');
const DSS2 = Buffer.from('dss2-bytes-for-m42');

async function tarGz(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const archive = archiver('tar', { gzip: true });
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('error', reject);
    archive.on('end', resolve);
    for (const e of entries) archive.append(e.data, { name: e.name });
    archive.finalize();
  });
  return Buffer.concat(chunks);
}

interface PackOptions {
  /** Sign with a key the app does not trust. */
  untrustedSignature?: boolean;
  /** The manifest declares a different hash for the Hubble image than the archive holds. */
  wrongFileSha?: boolean;
  version?: string;
}

/** Serves a signed index + manifest + archive for one tier. */
async function servePack(opts: PackOptions = {}) {
  const version = opts.version ?? '1';
  const descriptions = JSON.stringify({ M31: { extract: 'Andromeda galaxy.', sourceUrl: 'https://example.test/m31', source: 'wikipedia', status: 'ok' } });
  const archive = await tarGz([
    { name: 'images/hubble_M31.webp', data: HUBBLE },
    { name: 'images/M42_master.jpg', data: DSS2 },
    { name: 'descriptions.json', data: Buffer.from(descriptions) },
  ]);
  const manifest = Buffer.from(JSON.stringify({
    tier: 'messier', version, minAppVersion: '0.0.0', totalBytes: HUBBLE.length + DSS2.length + Buffer.byteLength(descriptions), objectCount: 2, generatedAt: '2026-11-01T00:00:00Z',
    files: [
      { path: 'images/hubble_M31.webp', sha256: opts.wrongFileSha ? '0'.repeat(64) : sha256Buffer(HUBBLE), bytes: HUBBLE.length },
      { path: 'images/M42_master.jpg', sha256: sha256Buffer(DSS2), bytes: DSS2.length },
    ],
  }));
  const index = Buffer.from(JSON.stringify({
    schemaVersion: 1, generatedAt: '2026-11-01T00:00:00Z',
    tiers: [{
      tier: 'messier', version, archiveUrl: `${BASE}/messier.tar.gz`, manifestUrl: `${BASE}/messier.json`, manifestSigUrl: `${BASE}/messier.json.sig`,
      archiveSha256: sha256Buffer(archive), archiveBytes: archive.length, totalObjects: 2, minAppVersion: '0.0.0', updatedAt: '2026-11-01T00:00:00Z',
    }],
  }));
  let signKey = keys.privatePem;
  if (opts.untrustedSignature) signKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  served.set(INDEX_URL, index);
  served.set(`${INDEX_URL}.sig`, Buffer.from(signManifest(index, signKey)));
  served.set(`${BASE}/messier.json`, manifest);
  served.set(`${BASE}/messier.json.sig`, Buffer.from(signManifest(manifest, signKey)));
  served.set(`${BASE}/messier.tar.gz`, archive);
}

const install = (prewarm = vi.fn(async () => {})) =>
  installCatalogPacks(['messier'], new AbortController().signal, prewarm).then(results => ({ results, prewarm }));

const skyCacheFiles = () => (fs.existsSync(SKY_CACHE) ? fs.readdirSync(SKY_CACHE).sort() : []);

beforeEach(() => {
  served.clear();
  clearPackState();
  fs.rmSync(SKY_CACHE, { recursive: true, force: true });
  db.prepare("DELETE FROM catalogCache WHERE objectId = 'M31'").run();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('installCatalogPacks, the whole chain', () => {
  it('installs a signed pack: images in sky-cache, descriptions imported, state recorded, tmp removed', async () => {
    await servePack();
    const { results, prewarm } = await install();

    expect(results).toEqual([{ tier: 'messier', version: '1', objectCount: 2 }]);
    expect(skyCacheFiles()).toEqual(['M42_master.jpg', 'hubble_M31.webp']);
    expect(fs.readFileSync(path.join(SKY_CACHE, 'hubble_M31.webp'))).toEqual(HUBBLE);
    expect(fs.readFileSync(path.join(SKY_CACHE, 'M42_master.jpg'))).toEqual(DSS2);
    expect(getPackState('messier')).toMatchObject({ version: '1', objectCount: 2 });
    expect(db.prepare("SELECT extract, status FROM catalogCache WHERE objectId = 'M31'").get()).toEqual({ extract: 'Andromeda galaxy.', status: 'ok' });
    expect(prewarm).toHaveBeenCalledTimes(2);
    expect(prewarm).toHaveBeenCalledWith('M31', path.join(SKY_CACHE, 'hubble_M31.webp'), 'hubble');
    expect(fs.existsSync(TMP_PACK_DIR)).toBe(false);
  });

  it('skips a tier that is already current and still has its images', async () => {
    await servePack();
    await install();
    const { results } = await install();
    expect(results).toEqual([{ tier: 'messier', version: '1', objectCount: 2, skipped: true, reason: 'already_installed' }]);
  });

  it('reinstalls when the state says installed but sky-cache was emptied', async () => {
    await servePack();
    await install();
    fs.rmSync(SKY_CACHE, { recursive: true, force: true });
    const { results } = await install();
    expect(results[0].skipped).toBeUndefined();
    expect(skyCacheFiles()).toEqual(['M42_master.jpg', 'hubble_M31.webp']);
  });

  it('refuses an index signed by a key the app does not trust, touching nothing', async () => {
    await servePack({ untrustedSignature: true });
    const { results, prewarm } = await install();
    expect(results).toEqual([{ tier: 'messier', version: '', objectCount: 0, skipped: true, reason: 'index_sig_invalid' }]);
    expect(skyCacheFiles()).toEqual([]);
    expect(getPackState('messier')).toBeNull();
    expect(prewarm).not.toHaveBeenCalled();
  });

  it('rejects a pack whose file hash differs from the signed manifest, leaving sky-cache untouched and no state', async () => {
    await servePack({ wrongFileSha: true });
    const { results, prewarm } = await install();
    expect(results[0]).toMatchObject({ tier: 'messier', skipped: true });
    expect(results[0].reason).toContain('SHA-256 mismatch for images/hubble_M31.webp');
    expect(skyCacheFiles()).toEqual([]);
    expect(getPackState('messier')).toBeNull();
    expect(db.prepare("SELECT extract FROM catalogCache WHERE objectId = 'M31'").get()).toBeUndefined();
    expect(prewarm).not.toHaveBeenCalled();
    expect(fs.existsSync(TMP_PACK_DIR)).toBe(false);
  });

  it('reports a failed download as a skip with the reason and installs nothing', async () => {
    await servePack();
    served.delete(`${BASE}/messier.tar.gz`);
    const { results } = await install();
    expect(results[0].skipped).toBe(true);
    expect(results[0].reason).toContain('404');
    expect(skyCacheFiles()).toEqual([]);
    expect(getPackState('messier')).toBeNull();
  });

  it('replaces pack images when the tier moves to a corrected version', async () => {
    await servePack({ version: '1' });
    await install();
    fs.writeFileSync(path.join(SKY_CACHE, 'hubble_M31.webp'), 'wrong picture from v1');
    await servePack({ version: '2' });
    const { results } = await install();
    expect(results[0]).toMatchObject({ version: '2', objectCount: 2 });
    expect(fs.readFileSync(path.join(SKY_CACHE, 'hubble_M31.webp'))).toEqual(HUBBLE);
    expect(getPackState('messier')?.version).toBe('2');
  });
});
