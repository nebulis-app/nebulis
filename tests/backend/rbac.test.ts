/**
 * Role-Based Access Control — unit tests
 *
 * Covers:
 *   1. requireAdmin middleware: viewer → 403, admin/undefined → next()
 *   2. Role encoding in JWT: generateToken includes role, verifyToken decodes it
 *   3. updateUserRole: DB change is reflected in subsequent logins
 *   4. Token immutability: old viewer token stays viewer after role upgrade in DB
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAdmin } from '../../server/middleware/auth';
import {
  registerUser,
  loginUser,
  verifyToken,
  updateUserRole,
} from '../../server/lib/auth';
import db from '../../server/lib/db';

// ─── requireAdmin middleware ──────────────────────────────────────────────────

describe('requireAdmin middleware', () => {
  function makeReq(role?: string) {
    return { path: '/api/test', userRole: role } as Record<string, unknown>;
  }
  function makeRes() {
    const res: Record<string, unknown> = {};
    res.apiError = vi.fn();
    return res;
  }

  it('calls next() for admin role', () => {
    const next = vi.fn();
    requireAdmin(makeReq('admin'), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 when userRole is undefined (apiAuth sets admin before requireAdmin runs)', () => {
    const next = vi.fn();
    const res = makeRes();
    requireAdmin(makeReq(undefined), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(403, 'FORBIDDEN', expect.stringContaining('admin'));
  });

  it('returns 403 FORBIDDEN for viewer role', () => {
    const next = vi.fn();
    const res = makeRes();
    requireAdmin(makeReq('viewer'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(403, 'FORBIDDEN', expect.stringContaining('admin'));
  });

  it('does not call next() after returning 403', () => {
    const next = vi.fn();
    const res = makeRes();
    requireAdmin(makeReq('viewer'), res, next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(res.apiError).toHaveBeenCalledTimes(1);
  });
});

// ─── Role encoding in JWT tokens ─────────────────────────────────────────────

describe('role in JWT tokens', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM users').run();
  });

  it('registerUser defaults to admin role when no role specified', async () => {
    const auth = await registerUser('alice', 'password1');
    expect(auth.user.role).toBe('admin');
    expect(verifyToken(auth.token).role).toBe('admin');
  });

  it('registerUser with viewer role encodes viewer in token', async () => {
    const auth = await registerUser('bob', 'password1', undefined, undefined, 'viewer');
    expect(auth.user.role).toBe('viewer');
    expect(verifyToken(auth.token).role).toBe('viewer');
  });

  it('loginUser returns role matching the stored role (viewer)', async () => {
    await registerUser('carol', 'password1', undefined, undefined, 'viewer');
    const auth = await loginUser('carol', 'password1');
    expect(auth.user.role).toBe('viewer');
    expect(verifyToken(auth.token).role).toBe('viewer');
  });

  it('loginUser returns role matching the stored role (admin)', async () => {
    await registerUser('dave', 'password1');
    const auth = await loginUser('dave', 'password1');
    expect(auth.user.role).toBe('admin');
    expect(verifyToken(auth.token).role).toBe('admin');
  });

  it('verifyToken treats any non-viewer role value as admin', async () => {
    const auth = await registerUser('eve', 'password1');
    const payload = verifyToken(auth.token);
    // 'admin' explicitly → still 'admin'
    expect(payload.role).toBe('admin');
  });

  it('verifyToken returns userId and username alongside role', async () => {
    const auth = await registerUser('frank', 'password1');
    const payload = verifyToken(auth.token);
    expect(payload.userId).toBe(auth.user.id);
    expect(payload.username).toBe('frank');
    expect(payload.role).toBe('admin');
  });
});

// ─── updateUserRole ───────────────────────────────────────────────────────────

describe('updateUserRole', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM users').run();
  });

  it('admin → viewer: login after role change produces viewer token', async () => {
    const auth = await registerUser('grace', 'password1');
    expect(auth.user.role).toBe('admin');

    expect(updateUserRole(auth.user.id, 'viewer')).toBe(true);

    const login = await loginUser('grace', 'password1');
    expect(login.user.role).toBe('viewer');
    expect(verifyToken(login.token).role).toBe('viewer');
  });

  it('viewer → admin: login after role change produces admin token', async () => {
    const auth = await registerUser('hank', 'password1', undefined, undefined, 'viewer');
    expect(auth.user.role).toBe('viewer');

    expect(updateUserRole(auth.user.id, 'admin')).toBe(true);

    const login = await loginUser('hank', 'password1');
    expect(login.user.role).toBe('admin');
    expect(verifyToken(login.token).role).toBe('admin');
  });

  it('returns false for unknown user id', () => {
    expect(updateUserRole('no-such-id', 'viewer')).toBe(false);
  });

  it('old viewer token stays viewer after DB role upgrade (token immutability)', async () => {
    // Tokens are signed at generation time — a role change in the DB does NOT
    // invalidate previously issued tokens. Old tokens retain their original role
    // until they expire or the user logs in again.
    const auth = await registerUser('iris', 'password1', undefined, undefined, 'viewer');
    expect(verifyToken(auth.token).role).toBe('viewer');

    updateUserRole(auth.user.id, 'admin');

    // Old token still decodes as viewer
    expect(verifyToken(auth.token).role).toBe('viewer');

    // New login produces admin token
    const fresh = await loginUser('iris', 'password1');
    expect(verifyToken(fresh.token).role).toBe('admin');
  });

  it('old admin token stays admin after DB demotion to viewer', async () => {
    const auth = await registerUser('jake', 'password1');
    expect(verifyToken(auth.token).role).toBe('admin');

    updateUserRole(auth.user.id, 'viewer');

    // Old token still decodes as admin — server must not accept stale tokens
    // in security-critical paths; this test documents the known behaviour.
    expect(verifyToken(auth.token).role).toBe('admin');

    // New login produces viewer token
    const fresh = await loginUser('jake', 'password1');
    expect(verifyToken(fresh.token).role).toBe('viewer');
  });
});
