/**
 * Platform + version detection for the desktop auto-updater.
 *
 * The update channel only applies to the packaged desktop builds:
 *   - Windows x64 service install (NSSM + Inno)  → 'win-x64'
 *   - macOS Apple Silicon  (NebulisMac.app)      → 'mac-arm64'
 *   - macOS Intel          (NebulisMac.app)      → 'mac-x64'
 *
 * Anything else (Linux, Docker, dev via tsx) returns null, and the updater
 * no-ops — Docker self-hosters update with `docker pull`, not this channel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type UpdatePlatform = 'win-x64' | 'mac-arm64' | 'mac-x64';

/** The platform key matching a manifest artifact, or null if not updatable. */
export function getUpdatePlatform(): UpdatePlatform | null {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  return null;
}

/** True only for the packaged desktop builds we ship updates for. */
export function isDesktopBuild(): boolean {
  return getUpdatePlatform() !== null && process.env.NODE_ENV === 'production';
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Same resolution order as routes/meta.ts and index.ts readAppVersion: handle
// dev, the bundled-server layout, and the side-by-side-with-exe fallback.
const PKG_CANDIDATES = [
  path.resolve(HERE, '..', '..', '..', 'package.json'),
  path.resolve(HERE, '..', '..', 'package.json'),
  path.resolve(HERE, 'package.json'),
  path.resolve(path.dirname(process.execPath), 'package.json'),
];

export interface CurrentVersion {
  version: string; // clean semver, e.g. "1.1.0"
  build: number;   // buildNumber, e.g. 91
}

/** Read the running build's version + build number from package.json. */
export function getCurrentVersion(): CurrentVersion {
  for (const p of PKG_CANDIDATES) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string; buildNumber?: number };
      if (typeof pkg.version === 'string') {
        return { version: pkg.version, build: typeof pkg.buildNumber === 'number' ? pkg.buildNumber : 0 };
      }
    } catch { /* try next */ }
  }
  return { version: '0.0.0', build: 0 };
}

/**
 * Compare two dotted numeric version strings.
 * Returns >0 if a>b, <0 if a<b, 0 if equal. Non-numeric segments compare as 0,
 * so "1.2.0-beta" is treated as "1.2.0" (channel is tracked separately).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
