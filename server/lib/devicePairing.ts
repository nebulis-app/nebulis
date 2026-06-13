/**
 * TV / device pairing — RFC 8628 device-grant style.
 *
 * Flow:
 *   1. TV calls /pair/start, gets a short userCode (shown on screen) and a
 *      long deviceCode (kept secret, used to poll).
 *   2. User on phone/laptop visits /link, types the userCode. Server records
 *      the userId against the pairing row.
 *   3. TV's poll on deviceCode flips from "pending" → "approved" and returns
 *      a JWT scoped to a freshly-created connectedDevices row.
 */
import { randomBytes, randomUUID } from 'crypto';
import db from './db.js';
import { generateDeviceToken, getUserById, type UserRole } from './auth.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;       // 10 minutes
export const POLL_INTERVAL_SEC = 5;

// Crockford-ish alphabet — no 0/O/1/I/L. 32 chars → 32^4 = ~1.05M combos.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LEN = 4;

export type PairingStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';

interface PairingRow {
  userCode: string;
  deviceCode: string;
  tvName: string;
  status: PairingStatus;
  userId: string | null;
  createdAt: number;
  expiresAt: number;
}

interface DeviceRow {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

const stmts = {
  insertPairing: db.prepare(
    'INSERT INTO devicePairings (userCode, deviceCode, tvName, status, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?, NULL, ?, ?)'
  ),
  getPairingByUserCode: db.prepare<[string], PairingRow>(
    'SELECT * FROM devicePairings WHERE userCode = ?'
  ),
  getPairingByDeviceCode: db.prepare<[string], PairingRow>(
    'SELECT * FROM devicePairings WHERE deviceCode = ?'
  ),
  approvePairing: db.prepare(
    "UPDATE devicePairings SET status = 'approved', userId = ? WHERE userCode = ? AND status = 'pending'"
  ),
  consumePairing: db.prepare(
    "UPDATE devicePairings SET status = 'consumed' WHERE deviceCode = ? AND status = 'approved'"
  ),
  sweepExpired: db.prepare('DELETE FROM devicePairings WHERE expiresAt < ?'),

  insertDevice: db.prepare(
    'INSERT INTO connectedDevices (id, userId, name, createdAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, NULL)'
  ),
  getDevice: db.prepare<[string], DeviceRow>('SELECT * FROM connectedDevices WHERE id = ?'),
  listDevicesForUser: db.prepare<[string], DeviceRow>(
    'SELECT * FROM connectedDevices WHERE userId = ? ORDER BY createdAt DESC'
  ),
  revokeDevice: db.prepare(
    'UPDATE connectedDevices SET revokedAt = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL'
  ),
  revokeDeviceById: db.prepare(
    'UPDATE connectedDevices SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL'
  ),
  touchDevice: db.prepare('UPDATE connectedDevices SET lastSeenAt = ? WHERE id = ?'),
  renameDevice: db.prepare('UPDATE connectedDevices SET name = ? WHERE id = ? AND userId = ?'),
  listAllDevices: db.prepare<[], DeviceRow & { ownerUsername: string | null; ownerDisplayName: string | null }>(
    `SELECT cd.id, cd.userId, cd.name, cd.createdAt, cd.lastSeenAt, cd.revokedAt,
            u.username AS ownerUsername, u.displayName AS ownerDisplayName
       FROM connectedDevices cd
       LEFT JOIN users u ON u.id = cd.userId
      WHERE cd.revokedAt IS NULL
      ORDER BY cd.createdAt DESC`
  ),
};

function randomFromAlphabet(len: number, alphabet: string): string {
  // crypto.randomBytes → modulo bias is negligible at 32-char alphabet, but
  // we reject bytes ≥ floor(256/alphabet)*alphabet to be principled.
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b >= max) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}

function newUserCode(): string {
  // Avoid collisions with any active pairing by retrying — collisions are
  // astronomically rare but rows that haven't expired yet are still valid.
  for (let i = 0; i < 8; i++) {
    const code = randomFromAlphabet(USER_CODE_LEN, CODE_ALPHABET);
    if (!stmts.getPairingByUserCode.get(code)) return code;
  }
  throw new Error('Could not allocate a unique user code');
}

function newDeviceCode(): string {
  return randomBytes(24).toString('base64url'); // 32 chars, URL-safe
}

/**
 * The user-facing format — 4-char codes are short enough to show as-is.
 * The server stores the raw code; helpers normalize input.
 */
export function formatUserCode(raw: string): string {
  return raw;
}

export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, USER_CODE_LEN);
}

export function startPairing(tvName: string): {
  userCode: string;
  userCodeFormatted: string;
  deviceCode: string;
  expiresAt: number;
  pollIntervalSec: number;
} {
  const now = Date.now();
  // Lazy sweep on each new pairing — keeps the table tiny without a cron.
  stmts.sweepExpired.run(now);

  const userCode = newUserCode();
  const deviceCode = newDeviceCode();
  const expiresAt = now + PAIRING_TTL_MS;
  const safeName = (tvName || 'TV').toString().trim().slice(0, 80) || 'TV';

  stmts.insertPairing.run(userCode, deviceCode, safeName, 'pending', now, expiresAt);

  return {
    userCode,
    userCodeFormatted: formatUserCode(userCode),
    deviceCode,
    expiresAt,
    pollIntervalSec: POLL_INTERVAL_SEC,
  };
}

export function lookupPairing(userCodeRaw: string): { tvName: string; expiresAt: number } | null {
  const userCode = normalizeUserCode(userCodeRaw);
  if (userCode.length !== USER_CODE_LEN) return null;
  const row = stmts.getPairingByUserCode.get(userCode);
  if (!row) return null;
  if (row.expiresAt < Date.now()) return null;
  if (row.status !== 'pending') return null;
  return { tvName: row.tvName, expiresAt: row.expiresAt };
}

export function approvePairing(userCodeRaw: string, userId: string): { ok: boolean; reason?: string; tvName?: string } {
  const userCode = normalizeUserCode(userCodeRaw);
  if (userCode.length !== USER_CODE_LEN) return { ok: false, reason: 'invalid' };
  const row = stmts.getPairingByUserCode.get(userCode);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.expiresAt < Date.now()) return { ok: false, reason: 'expired' };
  if (row.status !== 'pending') return { ok: false, reason: 'already_used' };

  const result = stmts.approvePairing.run(userId, userCode);
  if (result.changes === 0) return { ok: false, reason: 'race' };
  return { ok: true, tvName: row.tvName };
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'rejected' }
  | { status: 'approved'; token: string; user: { id: string; username: string; displayName: string; role: UserRole }; deviceId: string };

export function pollPairing(deviceCode: string): PollResult {
  const row = stmts.getPairingByDeviceCode.get(deviceCode);
  if (!row) return { status: 'expired' };
  if (row.expiresAt < Date.now() && row.status === 'pending') return { status: 'expired' };

  if (row.status === 'pending') return { status: 'pending' };
  if (row.status === 'rejected') return { status: 'rejected' };
  if (row.status === 'consumed') return { status: 'expired' }; // already exchanged
  if (row.status !== 'approved' || !row.userId) return { status: 'expired' };

  const user = getUserById(row.userId);
  if (!user) return { status: 'expired' };

  // Atomic claim: only the first caller to consume an approved row gets a
  // token. Subsequent polls see "expired".
  const consumed = stmts.consumePairing.run(deviceCode);
  if (consumed.changes === 0) return { status: 'expired' };

  // Mint a connectedDevice row + JWT bound to it via jti.
  const deviceId = randomUUID();
  const now = Date.now();
  stmts.insertDevice.run(deviceId, user.id, row.tvName, now, now);
  const token = generateDeviceToken(user, deviceId);

  return {
    status: 'approved',
    token,
    deviceId,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
  };
}

// ─── Connected devices (Settings UI) ────────────────────────────────────────

export interface ConnectedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export function listDevicesForUser(userId: string): ConnectedDevice[] {
  return stmts.listDevicesForUser
    .all(userId)
    .filter(d => d.revokedAt === null)
    .map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt }));
}

export function revokeDeviceForUser(userId: string, deviceId: string): boolean {
  const result = stmts.revokeDevice.run(Date.now(), deviceId, userId);
  return result.changes > 0;
}

/**
 * Admin-only: revoke any device regardless of owner. The route handler is
 * responsible for gating this on `req.userRole === 'admin'`.
 */
export function adminRevokeDevice(deviceId: string): boolean {
  const result = stmts.revokeDeviceById.run(Date.now(), deviceId);
  return result.changes > 0;
}

export interface ConnectedDeviceWithOwner extends ConnectedDevice {
  userId: string;
  ownerUsername: string | null;
  ownerDisplayName: string | null;
}

/**
 * Admin-only listing: every active device across every user, with owner info
 * joined in. Orphaned devices (user deleted) get null owner fields and the
 * UI labels them as "(deleted user)".
 */
export function adminListAllDevices(): ConnectedDeviceWithOwner[] {
  return stmts.listAllDevices.all().map(d => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    userId: d.userId,
    ownerUsername: d.ownerUsername,
    ownerDisplayName: d.ownerDisplayName,
  }));
}

export function renameDeviceForUser(userId: string, deviceId: string, name: string): boolean {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return false;
  const result = stmts.renameDevice.run(trimmed, deviceId, userId);
  return result.changes > 0;
}

/**
 * Returns true if the device is still active (exists, not revoked).
 * Auth middleware calls this for every JWT that carries a `jti`.
 */
export function isDeviceActive(deviceId: string): boolean {
  const row = stmts.getDevice.get(deviceId);
  return !!row && row.revokedAt === null;
}

export function touchDevice(deviceId: string): void {
  stmts.touchDevice.run(Date.now(), deviceId);
}
