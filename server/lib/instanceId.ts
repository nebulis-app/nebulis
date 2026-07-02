/**
 * Stable server instance identity.
 *
 * Gives this server a persistent ID that survives restarts and, crucially,
 * IP-address changes. Clients store it alongside the connection URL so that
 * when a saved IP goes stale (DHCP lease change, Docker host moved network),
 * they can re-run discovery and re-bind to whichever responder advertises the
 * same instance ID instead of forcing the user to re-pair.
 *
 *  - `INSTANCE_ID` env var wins if set (useful for fixed Docker deployments).
 *  - Otherwise read `{DATA_DIR}/.instance-id`.
 *  - First run: generate one, persist with mode 0o600.
 *
 * Same shape as `.jwt-secret` / `.data-key`. The value is not a secret: it is
 * broadcast in mDNS/UDP discovery and returned from /health. It only needs to
 * be stable and unique, not unguessable.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from './paths.js';

let cached: string | null = null;

export function getInstanceId(): string {
  if (cached) return cached;

  const fromEnv = process.env.INSTANCE_ID?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }

  const idPath = path.join(DATA_DIR, '.instance-id');
  try {
    if (fs.existsSync(idPath)) {
      const existing = fs.readFileSync(idPath, 'utf8').trim();
      if (existing) {
        cached = existing;
        return cached;
      }
    }
  } catch {
    // Fall through to regenerate — a server with no stable ID is worse than
    // one that re-rolls it on an unreadable file.
  }

  cached = randomUUID();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(idPath, cached, { mode: 0o600 });
  } catch {
    // If persistence fails we still return the in-memory value so the current
    // process advertises a consistent ID; it just won't survive a restart.
  }
  return cached;
}

/** Test-only: drop the cached value so a fresh env / file is picked up. */
export function _resetInstanceIdForTests(): void {
  cached = null;
}
