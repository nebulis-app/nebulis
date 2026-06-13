/**
 * Transport rows attached to a telescope profile. One profile can have
 * multiple transports — e.g. a Seestar reachable over both SMB (LAN) and a
 * USB-mounted eMMC. `selectActiveTransport` picks which one the SMB/local I/O
 * dispatcher should use on a given request: local mount present wins over
 * SMB; tiebreak by priority asc, then lastSeenAt desc.
 */
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import db from './db.js';
import { encrypt, decrypt } from './crypto/secretBox.js';

export type TransportKind = 'smb' | 'local';

export interface TelescopeTransport {
  id: string;
  profileId: string;
  kind: TransportKind;
  /** Lower wins. Default 100 for SMB, 50 for local — so a freshly-plugged
   *  USB drive overrides a configured SMB profile without a priority bump. */
  priority: number;
  hostname: string;
  shareName: string;
  username: string;
  /** Decrypted in-memory. Always encrypted at rest. */
  password: string;
  localPath: string;
  /** Unix ms of the last successful list/get/put against this transport. */
  lastSeenAt: number | null;
  createdAt: string;
  /** True when the stored password could not be decrypted (e.g. DATA_KEY changed
   *  after a backup restore). The transport will be skipped by selectActiveTransport
   *  and the user must re-enter credentials in Settings. */
  decryptFailed?: boolean;
}

interface TelescopeTransportRow {
  id: string;
  profileId: string;
  kind: string;
  priority: number;
  hostname: string;
  shareName: string;
  username: string;
  password: string;
  localPath: string;
  lastSeenAt: number | null;
  createdAt: string;
}

const stmts = {
  getByProfile: db.prepare<[string], TelescopeTransportRow>(
    'SELECT * FROM telescopeTransports WHERE profileId = ? ORDER BY priority ASC, createdAt ASC',
  ),
  getById: db.prepare<[string], TelescopeTransportRow>(
    'SELECT * FROM telescopeTransports WHERE id = ?',
  ),
  insert: db.prepare(
    `INSERT INTO telescopeTransports
       (id, profileId, kind, priority, hostname, shareName, username, password,
        localPath, lastSeenAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  update: db.prepare(
    `UPDATE telescopeTransports
        SET kind = ?, priority = ?, hostname = ?, shareName = ?, username = ?,
            password = ?, localPath = ?
      WHERE id = ?`,
  ),
  delete: db.prepare('DELETE FROM telescopeTransports WHERE id = ?'),
  touchLastSeen: db.prepare('UPDATE telescopeTransports SET lastSeenAt = ? WHERE id = ?'),
};

function asKind(value: string | undefined | null): TransportKind {
  return value === 'local' ? 'local' : 'smb';
}

function defaultPriority(kind: TransportKind): number {
  // Lower beats higher. Local mount is structurally faster and avoids touching
  // the network at all, so it leads the SMB transport by default.
  return kind === 'local' ? 50 : 100;
}

function rowToTransport(row: TelescopeTransportRow): TelescopeTransport {
  let decryptedPassword = '';
  let decryptFailed = false;
  if (row.password) {
    try {
      decryptedPassword = decrypt(row.password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Invalid encrypted blob: expected 3 dot-separated parts') {
        // Plaintext password stored before encryption was introduced — use as-is.
        // The startup migration in db.ts will re-encrypt it on next boot.
        decryptedPassword = row.password;
      } else {
        // GCM auth tag failure: DATA_KEY likely changed (backup restore with a
        // different key). Flag the transport so selectActiveTransport skips it
        // and the user gets a clear prompt to re-enter credentials.
        decryptFailed = true;
        console.error(
          `[transports] Cannot decrypt password for transport ${row.id} (${row.kind} / ${row.hostname || row.localPath}): ${msg}. ` +
          'This usually means DATA_KEY changed after a backup restore. Re-enter the credentials in Settings to fix it.',
        );
      }
    }
  }
  return {
    id: row.id,
    profileId: row.profileId,
    kind: asKind(row.kind),
    priority: row.priority,
    hostname: row.hostname,
    shareName: row.shareName,
    username: row.username,
    password: decryptedPassword,
    localPath: row.localPath,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    decryptFailed: decryptFailed || undefined,
  };
}

export function getTransportsForProfile(profileId: string): TelescopeTransport[] {
  return stmts.getByProfile.all(profileId).map(rowToTransport);
}

export function getTransportById(id: string): TelescopeTransport | null {
  const row = stmts.getById.get(id);
  return row ? rowToTransport(row) : null;
}

export function addTransport(
  profileId: string,
  data: Partial<TelescopeTransport>,
): TelescopeTransport {
  const kind = asKind(data.kind);
  const transport: TelescopeTransport = {
    id: randomUUID(),
    profileId,
    kind,
    priority: data.priority ?? defaultPriority(kind),
    hostname: data.hostname ?? '',
    shareName: data.shareName ?? 'EMMC Images',
    username: data.username ?? 'guest',
    password: data.password ?? '',
    localPath: data.localPath ?? '',
    lastSeenAt: null,
    createdAt: new Date().toISOString(),
  };
  stmts.insert.run(
    transport.id, transport.profileId, transport.kind, transport.priority,
    transport.hostname, transport.shareName, transport.username,
    transport.password ? encrypt(transport.password) : '',
    transport.localPath, transport.lastSeenAt, transport.createdAt,
  );
  invalidateActiveTransportCache(profileId);
  return transport;
}

export function updateTransport(
  id: string,
  data: Partial<TelescopeTransport>,
): TelescopeTransport | null {
  const existing = stmts.getById.get(id);
  if (!existing) return null;
  const current = rowToTransport(existing);
  const merged: TelescopeTransport = {
    ...current,
    ...data,
    id: current.id,
    profileId: current.profileId,
    createdAt: current.createdAt,
  };
  merged.kind = asKind(merged.kind);
  stmts.update.run(
    merged.kind, merged.priority,
    merged.hostname, merged.shareName, merged.username,
    merged.password ? encrypt(merged.password) : '',
    merged.localPath,
    id,
  );
  invalidateActiveTransportCache(merged.profileId);
  const refreshed = stmts.getById.get(id);
  return refreshed ? rowToTransport(refreshed) : null;
}

export function deleteTransport(id: string): boolean {
  const existing = stmts.getById.get(id);
  if (!existing) return false;
  stmts.delete.run(id);
  invalidateActiveTransportCache(existing.profileId);
  return true;
}

export function markTransportSeen(id: string): void {
  stmts.touchLastSeen.run(Date.now(), id);
}

// ─── Active-transport selection ─────────────────────────────────────────────
// Cheap heuristics, cached for 30s per profile to avoid re-stating the volume
// on every smbListDir call during a single import sweep.

interface CacheEntry {
  transport: TelescopeTransport | null;
  expiresAt: number;
}
const activeCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function invalidateActiveTransportCache(profileId?: string): void {
  if (profileId === undefined) {
    activeCache.clear();
  } else {
    activeCache.delete(profileId);
  }
}

function localMountPresent(localPath: string): boolean {
  if (!localPath) return false;
  try {
    const stat = statSync(localPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pick the transport the import pipeline should use for a profile right now.
 *
 * Algorithm:
 *  1. Among `local` transports whose `localPath` currently resolves to a
 *     directory, return the one with lowest priority (tiebreak by most
 *     recent lastSeenAt).
 *  2. Otherwise, among SMB transports that have a hostname configured,
 *     return the one with lowest priority (same tiebreak).
 *  3. If neither applies, return null — the caller should skip this profile
 *     this tick. We do not actively probe SMB reachability here; the import
 *     itself will fail and report a "not reachable" message back to the user.
 *
 * Results cached 30s per profileId. The cache is invalidated whenever a
 * transport for the profile is added, updated, or deleted.
 */
export function selectActiveTransport(profileId: string): TelescopeTransport | null {
  const cached = activeCache.get(profileId);
  if (cached && cached.expiresAt > Date.now()) return cached.transport;

  const transports = getTransportsForProfile(profileId);
  const orderForSelection = [...transports].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
  });

  // Warn once per selection cycle if any transport has a broken password so the
  // log makes it obvious why the import isn't using a particular transport.
  const broken = orderForSelection.filter(t => t.decryptFailed);
  if (broken.length > 0) {
    console.error(
      `[transports] Skipping ${broken.length} transport(s) for profile ${profileId} with unreadable credentials: ` +
      broken.map(t => `${t.id} (${t.kind})`).join(', ') +
      '. Re-enter credentials in Settings > Hardware.',
    );
  }
  const usable = orderForSelection.filter(t => !t.decryptFailed);

  let chosen: TelescopeTransport | null = null;
  // First pass: any local transport whose mount is present.
  for (const t of usable) {
    if (t.kind === 'local' && localMountPresent(t.localPath)) {
      chosen = t;
      break;
    }
  }
  // Second pass: SMB transports with a configured hostname.
  if (!chosen) {
    for (const t of usable) {
      if (t.kind === 'smb' && t.hostname.trim() !== '') {
        chosen = t;
        break;
      }
    }
  }

  activeCache.set(profileId, { transport: chosen, expiresAt: Date.now() + CACHE_TTL_MS });
  return chosen;
}
