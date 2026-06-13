/**
 * Data-encryption key resolver.
 *
 * Used to encrypt sensitive at-rest values (SMB passwords, etc.) so the
 * SQLite file is safe to back up or copy without leaking credentials.
 *
 *  - `DATA_KEY` env var (base64-encoded 32 bytes) wins if set.
 *  - Otherwise read `{DATA_DIR}/.data-key`.
 *  - First run: generate 32 random bytes, persist with mode 0o600.
 *
 * Same shape as `.jwt-secret`. An attacker with full disk read can read
 * both — this defeats casual exposure (backups, repos, dev laptops),
 * not a compromised host.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { DATA_DIR } from '../paths.js';

let cached: Buffer | null = null;

export function getDataKey(): Buffer {
  if (cached) return cached;

  if (process.env.DATA_KEY) {
    const key = Buffer.from(process.env.DATA_KEY, 'base64');
    if (key.length !== 32) {
      throw new Error('DATA_KEY must decode to exactly 32 bytes');
    }
    cached = key;
    return cached;
  }

  const keyPath = path.join(DATA_DIR, '.data-key');
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length !== 32) {
      throw new Error(`.data-key at ${keyPath} must decode to exactly 32 bytes`);
    }
    cached = key;
    return cached;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  cached = randomBytes(32);
  fs.writeFileSync(keyPath, cached.toString('base64'), { mode: 0o600 });
  return cached;
}

/** Test-only: drop the cached key so a fresh env / file is picked up. */
export function _resetDataKeyForTests(): void {
  cached = null;
}
