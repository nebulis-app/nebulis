/**
 * Device identity via a hidden `.nebulis.dat` file at the share root.
 *
 * Why share root and not MyWorks/: `MyWorks/` is owned by the telescope
 * firmware and could be wiped or restructured on a firmware update; the
 * share root is more stable. The same relative path maps cleanly to both
 * `\\<host>\EMMC Images\.nebulis.dat` (SMB) and `/Volumes/<name>/.nebulis.dat`
 * (USB), so the same dispatcher call works for either transport.
 *
 * Failure modes: read-only mounts and SMB shares that reject writes return
 * `{ wrote: false, readonly: true }` from writeIdentityIfMissing — the caller
 * falls back to hostname/localPath as a weak identity hint. We never throw
 * on identity-write failure; the import pipeline must keep working.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { smbGetFile, smbPutFile } from './smb.js';
import type { TelescopeTransport } from './telescopeTransports.js';

export interface DeviceIdentity {
  deviceId: string;
  createdAt: string;
  model: string;
  appVersion: string;
}

const IDENTITY_FILE = '.nebulis.dat';
const MAX_IDENTITY_BYTES = 8192;

// Try several candidate paths for package.json so this works in dev (where
// __filename is server/lib/deviceIdentity.ts) and in the production pkg
// bundles (where tsup collapses everything into releases/<plat>/server/
// index.cjs and build-{mac,win}.mjs writes a stub package.json one level up).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_CANDIDATES = [
  path.resolve(HERE, '..', '..', 'package.json'),
  path.resolve(HERE, '..', 'package.json'),
  path.resolve(HERE, 'package.json'),
  path.resolve(path.dirname(process.execPath), 'package.json'),
];

let cachedAppVersion: string | null = null;
function getAppVersion(): string {
  if (cachedAppVersion !== null) return cachedAppVersion;
  for (const pkgPath of PKG_CANDIDATES) {
    try {
      if (!fs.existsSync(pkgPath)) continue;
      const pkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg === 'object' && 'version' in pkg && typeof (pkg as { version: unknown }).version === 'string') {
        cachedAppVersion = (pkg as { version: string }).version;
        return cachedAppVersion;
      }
    } catch {
      // try the next candidate
    }
  }
  cachedAppVersion = '0.0.0';
  return cachedAppVersion;
}

/** Adapt a TelescopeTransport to the partial-profile shape that smb.ts accepts. */
function transportToProfile(t: TelescopeTransport): {
  connectionType: 'smb' | 'local';
  hostname: string;
  shareName: string;
  username: string;
  password: string;
  localPath: string;
} {
  return {
    connectionType: t.kind,
    hostname: t.hostname,
    shareName: t.shareName,
    username: t.username,
    password: t.password,
    localPath: t.localPath,
  };
}

function parseIdentity(buf: Buffer): DeviceIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.deviceId !== 'string' || r.deviceId.length === 0) return null;
  if (typeof r.createdAt !== 'string') return null;
  return {
    deviceId: r.deviceId,
    createdAt: r.createdAt,
    model: typeof r.model === 'string' ? r.model : 'unknown',
    appVersion: typeof r.appVersion === 'string' ? r.appVersion : '0.0.0',
  };
}

export async function readIdentity(transport: TelescopeTransport): Promise<DeviceIdentity | null> {
  const profile = transportToProfile(transport);
  try {
    const buf = await smbGetFile(IDENTITY_FILE, MAX_IDENTITY_BYTES, profile);
    if (buf.length === 0) return null;
    const id = parseIdentity(buf);
    if (id === null) {
      console.warn(`[deviceIdentity] .nebulis.dat on transport ${transport.id} is unparseable; treating as missing`);
    }
    return id;
  } catch {
    // File missing, share unreachable, or local path absent — all treated the
    // same here. The caller decides whether to write a fresh identity.
    return null;
  }
}

/**
 * Read the device's `.nebulis.dat`. If it exists, return its identity. If
 * not, generate a fresh UUID, write the file, and return the new identity.
 * On write failure, return the would-be identity with `wrote: false,
 * readonly: true` so the caller can stamp the profile in-memory without
 * crashing.
 */
export async function writeIdentityIfMissing(
  transport: TelescopeTransport,
  fallback: { model: string },
): Promise<{ identity: DeviceIdentity; wrote: boolean; readonly: boolean }> {
  const existing = await readIdentity(transport);
  if (existing) {
    return { identity: existing, wrote: false, readonly: false };
  }
  const identity: DeviceIdentity = {
    deviceId: randomUUID(),
    createdAt: new Date().toISOString(),
    model: fallback.model,
    appVersion: getAppVersion(),
  };
  const buf = Buffer.from(JSON.stringify(identity, null, 2), 'utf8');
  const profile = transportToProfile(transport);
  try {
    await smbPutFile(IDENTITY_FILE, buf, profile);
    return { identity, wrote: true, readonly: false };
  } catch (err) {
    console.warn(
      `[deviceIdentity] Could not write .nebulis.dat on transport ${transport.id}: ${err instanceof Error ? err.message : err}`,
    );
    return { identity, wrote: false, readonly: true };
  }
}
