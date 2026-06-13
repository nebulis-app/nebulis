import { describe, it, expect, beforeEach } from 'vitest';
import {
  startPairing,
  lookupPairing,
  approvePairing,
  pollPairing,
  listDevicesForUser,
  revokeDeviceForUser,
  adminRevokeDevice,
  adminListAllDevices,
  renameDeviceForUser,
  isDeviceActive,
  touchDevice,
  formatUserCode,
  normalizeUserCode,
  POLL_INTERVAL_SEC,
} from '../../server/lib/devicePairing';
import { registerUser } from '../../server/lib/auth';
import db from '../../server/lib/db';

async function freshUser(username = 'tvowner') {
  const result = await registerUser(username, 'password123', 'TV Owner');
  return result.user;
}

describe('devicePairing', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM connectedDevices').run();
    db.prepare('DELETE FROM devicePairings').run();
    db.prepare('DELETE FROM users').run();
  });

  describe('user-code helpers', () => {
    it('uppercases and strips disallowed characters', () => {
      expect(normalizeUserCode('abcd')).toBe('ABCD');
      expect(normalizeUserCode('a b-c d')).toBe('ABCD');
      expect(normalizeUserCode('a@b#c$d')).toBe('ABCD');
    });

    it('strips digits 0 and 1 (kept out of the input alphabet)', () => {
      // The generator avoids 0/O/1/I/L for readability, but the *input* filter
      // only forbids 0 and 1 in the digit range (regex is /[^A-Z2-9]/g) — so
      // ambiguous letters O/I/L still pass through if the user types them.
      expect(normalizeUserCode('0011')).toBe('');
      expect(normalizeUserCode('0O1I')).toBe('OI');
      expect(normalizeUserCode('AB01')).toBe('AB');
    });

    it('truncates to the user-code length', () => {
      expect(normalizeUserCode('ABCDEFGH')).toHaveLength(4);
    });

    it('formatUserCode is a no-op for 4-char codes', () => {
      expect(formatUserCode('ABCD')).toBe('ABCD');
    });
  });

  describe('startPairing', () => {
    it('returns a 4-char userCode in the allowed alphabet and a URL-safe deviceCode', () => {
      const r = startPairing('Living Room TV');
      expect(r.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
      expect(r.userCodeFormatted).toBe(r.userCode);
      expect(r.deviceCode).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(r.deviceCode.length).toBeGreaterThanOrEqual(24);
      expect(r.expiresAt).toBeGreaterThan(Date.now());
      expect(r.pollIntervalSec).toBe(POLL_INTERVAL_SEC);
    });

    it('mints distinct user/device codes on consecutive calls', () => {
      const a = startPairing('Bedroom TV');
      const b = startPairing('Kitchen TV');
      expect(a.userCode).not.toBe(b.userCode);
      expect(a.deviceCode).not.toBe(b.deviceCode);
    });

    it('truncates a long tv name to 80 chars and defaults blank to "TV"', () => {
      const long = 'A'.repeat(200);
      const r1 = startPairing(long);
      const look1 = lookupPairing(r1.userCode);
      expect(look1?.tvName).toBe('A'.repeat(80));

      const r2 = startPairing('   ');
      const look2 = lookupPairing(r2.userCode);
      expect(look2?.tvName).toBe('TV');
    });
  });

  describe('lookupPairing', () => {
    it('returns the pending pairing when the userCode matches', () => {
      const r = startPairing('Den TV');
      const look = lookupPairing(r.userCode);
      expect(look?.tvName).toBe('Den TV');
      expect(look?.expiresAt).toBe(r.expiresAt);
    });

    it('returns null for an unknown userCode', () => {
      expect(lookupPairing('ZZZZ')).toBeNull();
    });

    it('normalizes the input before lookup', () => {
      const r = startPairing('Den TV');
      // Lower-cased input should still find the pairing.
      expect(lookupPairing(r.userCode.toLowerCase())).not.toBeNull();
    });

    it('returns null for a malformed userCode', () => {
      expect(lookupPairing('AB')).toBeNull();   // too short
      expect(lookupPairing('')).toBeNull();
    });
  });

  describe('approvePairing', () => {
    it('approves a pending pairing and lookup then sees it as no-longer-pending', async () => {
      const user = await freshUser();
      const r = startPairing('Office TV');

      const res = approvePairing(r.userCode, user.id);
      expect(res.ok).toBe(true);
      expect(res.tvName).toBe('Office TV');

      // After approval the pairing is no longer "pending", so lookupPairing
      // (which only returns pending rows) must return null.
      expect(lookupPairing(r.userCode)).toBeNull();
    });

    it('rejects a malformed userCode without touching the db', () => {
      const res = approvePairing('A', 'no-user');
      expect(res).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects an unknown userCode', async () => {
      const user = await freshUser();
      expect(approvePairing('ZZZZ', user.id).reason).toBe('not_found');
    });

    it('rejects a userCode that has already been approved', async () => {
      const user = await freshUser();
      const r = startPairing('Hallway TV');
      expect(approvePairing(r.userCode, user.id).ok).toBe(true);
      const second = approvePairing(r.userCode, user.id);
      expect(second.ok).toBe(false);
      expect(second.reason).toBe('already_used');
    });
  });

  describe('pollPairing', () => {
    it('returns pending before approval', () => {
      const r = startPairing('Loft TV');
      expect(pollPairing(r.deviceCode)).toEqual({ status: 'pending' });
    });

    it('returns expired for an unknown deviceCode', () => {
      expect(pollPairing('not-a-real-code')).toEqual({ status: 'expired' });
    });

    it('mints a token and a device row exactly once on first poll after approval', async () => {
      const user = await freshUser();
      const r = startPairing('Garage TV');
      approvePairing(r.userCode, user.id);

      const first = pollPairing(r.deviceCode);
      expect(first.status).toBe('approved');
      if (first.status !== 'approved') return; // type narrow
      // JWTs are three base64url-encoded segments separated by dots.
      expect(first.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(first.user.id).toBe(user.id);
      expect(first.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(isDeviceActive(first.deviceId)).toBe(true);

      // Second poll on the same deviceCode must NOT mint a second device or
      // token — the pairing row was atomically consumed.
      const second = pollPairing(r.deviceCode);
      expect(second.status).toBe('expired');
      expect(listDevicesForUser(user.id)).toHaveLength(1);
    });
  });

  describe('device lifecycle', () => {
    let uniqCounter = 0;
    async function approveAndPoll(name = 'Living Room TV', username?: string) {
      const user = await freshUser(username ?? `tvowner${++uniqCounter}`);
      const p = startPairing(name);
      approvePairing(p.userCode, user.id);
      const poll = pollPairing(p.deviceCode);
      if (poll.status !== 'approved') throw new Error('poll did not approve');
      return { user, deviceId: poll.deviceId };
    }

    it('lists active devices for a user', async () => {
      const { user, deviceId } = await approveAndPoll('TV A');
      const devices = listDevicesForUser(user.id);
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe(deviceId);
      expect(devices[0].name).toBe('TV A');
    });

    it('revokeDeviceForUser hides the device and isDeviceActive returns false', async () => {
      const { user, deviceId } = await approveAndPoll();
      expect(revokeDeviceForUser(user.id, deviceId)).toBe(true);
      expect(listDevicesForUser(user.id)).toEqual([]);
      expect(isDeviceActive(deviceId)).toBe(false);
    });

    it('revokeDeviceForUser refuses to revoke another user\'s device', async () => {
      const { deviceId } = await approveAndPoll('TV', 'owner-a');
      const otherUser = await freshUser('owner-b');
      expect(revokeDeviceForUser(otherUser.id, deviceId)).toBe(false);
      expect(isDeviceActive(deviceId)).toBe(true);
    });

    it('adminRevokeDevice revokes regardless of owner', async () => {
      const { deviceId } = await approveAndPoll();
      expect(adminRevokeDevice(deviceId)).toBe(true);
      expect(isDeviceActive(deviceId)).toBe(false);
    });

    it('adminListAllDevices includes owner info and excludes revoked devices', async () => {
      const { user: u1, deviceId: d1 } = await approveAndPoll('TV 1', 'admin-a');
      const { deviceId: d2 } = await approveAndPoll('TV 2', 'admin-b');
      adminRevokeDevice(d2);

      const all = adminListAllDevices();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(d1);
      expect(all[0].userId).toBe(u1.id);
      expect(all[0].ownerUsername).toBe('admin-a');
    });

    it('renameDeviceForUser trims and length-caps the name', async () => {
      const { user, deviceId } = await approveAndPoll();
      expect(renameDeviceForUser(user.id, deviceId, '  Den  ')).toBe(true);
      expect(listDevicesForUser(user.id)[0].name).toBe('Den');

      const long = 'X'.repeat(200);
      renameDeviceForUser(user.id, deviceId, long);
      expect(listDevicesForUser(user.id)[0].name).toBe('X'.repeat(80));
    });

    it('renameDeviceForUser rejects empty / whitespace-only names', async () => {
      const { user, deviceId } = await approveAndPoll('Original');
      expect(renameDeviceForUser(user.id, deviceId, '   ')).toBe(false);
      expect(listDevicesForUser(user.id)[0].name).toBe('Original');
    });

    it('touchDevice updates lastSeenAt', async () => {
      const { deviceId } = await approveAndPoll();
      // touchDevice doesn't require the user — it's called from auth middleware.
      // Spin until ms ticks forward so the post-touch comparison can't tie.
      const start = Date.now();
      while (Date.now() === start) { /* spin */ }
      touchDevice(deviceId);
      // Look up the actual row to confirm — listDevicesForUser is keyed by
      // userId, so use the real owner.
      const owner = db.prepare<[string], { userId: string }>('SELECT userId FROM connectedDevices WHERE id = ?').get(deviceId);
      if (!owner) throw new Error(`connectedDevices row for ${deviceId} disappeared`);
      const rows = listDevicesForUser(owner.userId);
      expect(rows[0].lastSeenAt).toBeGreaterThan(start);
    });
  });
});
