import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiAuth } from '../../server/middleware/auth';

// Mock the auth module
vi.mock('../../server/lib/auth', () => ({
  verifyToken: vi.fn(),
  getUserCount: vi.fn(),
  getUserTokenVersion: vi.fn(),
  getUserById: vi.fn(),
}));

// isDeviceActive/touchDevice are real DB-backed functions in most of this
// file's tests (unmocked), but the device-token regression suite below
// mocks them directly so it can drive jti-branch scenarios without a real
// connectedDevices row.
vi.mock('../../server/lib/devicePairing', async () => {
  const actual = await vi.importActual<typeof import('../../server/lib/devicePairing')>('../../server/lib/devicePairing');
  return { ...actual, isDeviceActive: vi.fn(), touchDevice: vi.fn() };
});

// Signed download-token verification is exercised in downloadToken.test.ts; here
// we only care whether apiAuth consults it, so stub it to a controllable fn.
vi.mock('../../server/lib/downloadToken', () => ({
  verifyDownloadToken: vi.fn(),
}));

import { verifyToken, getUserCount, getUserTokenVersion, getUserById } from '../../server/lib/auth';
import { isDeviceActive, touchDevice } from '../../server/lib/devicePairing';
import { verifyDownloadToken } from '../../server/lib/downloadToken';

const mockedVerifyDownloadToken = verifyDownloadToken as ReturnType<typeof vi.fn>;

// Mock fs so loadApiKey can be controlled
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});
import fs from 'fs';
// Real (non-mocked) admin-API-key storage. The `setApiKey`/`getApiKey` local
// helper below mocks `fs` for a `loadApiKey()` that no longer exists —
// apiKey moved to a DB column (telescopes.ts) at some point and this file's
// mocks were never updated, so every test using the local helper actually
// exercises the fresh-install open-access fallback, not the API-key
// comparison branch. Aliased to avoid colliding with that stale helper.
import { setApiKey as setRealApiKey, getApiKey as getRealApiKey } from '../../server/lib/telescopes';

const mockedVerifyToken = verifyToken as ReturnType<typeof vi.fn>;
const mockedGetUserCount = getUserCount as ReturnType<typeof vi.fn>;
const mockedGetUserTokenVersion = getUserTokenVersion as ReturnType<typeof vi.fn>;
const mockedGetUserById = getUserById as ReturnType<typeof vi.fn>;
const mockedIsDeviceActive = isDeviceActive as ReturnType<typeof vi.fn>;
const mockedTouchDevice = touchDevice as ReturnType<typeof vi.fn>;
const mockedExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockedReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

function mockReq(overrides: any = {}) {
  return {
    path: '/api/test',
    headers: {},
    query: {},
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = {};
  res.apiError = vi.fn();
  return res;
}

/** Configure fs mocks so loadApiKey() returns the given key (empty string if none). */
function setApiKey(key: string) {
  if (key) {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ apiKey: key }));
  } else {
    mockedExistsSync.mockReturnValue(false);
  }
}

describe('apiAuth middleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // By default verifyToken throws (invalid token) and getUserCount returns 0
    mockedVerifyToken.mockImplementation(() => {
      throw new Error('invalid token');
    });
    mockedGetUserCount.mockReturnValue(0);
    // Default: user exists with tokenVersion 0 (matches tokens that have no claim
    // or explicit tokenVersion 0).
    mockedGetUserTokenVersion.mockReturnValue(0);
  });

  it('skips auth for /auth/ routes', () => {
    const req = mockReq({ path: '/auth/login' });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
  });

  it('accepts valid JWT in Bearer header and sets req.userId, req.username, and req.userRole', () => {
    mockedVerifyToken.mockReturnValue({ userId: 42, username: 'alice', role: 'admin' });
    const req = mockReq({ headers: { authorization: 'Bearer valid-jwt-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe(42);
    expect(req.username).toBe('alice');
    expect(req.userRole).toBe('admin');
  });

  it('sets req.userRole to viewer when JWT carries viewer role', () => {
    mockedVerifyToken.mockReturnValue({ userId: 7, username: 'viewer1', role: 'viewer' });
    const req = mockReq({ headers: { authorization: 'Bearer viewer-jwt-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userRole).toBe('viewer');
  });

  it('accepts API key in Bearer header when JWT fails and sets req.userRole to admin', () => {
    setApiKey('my-secret-key');
    const req = mockReq({ headers: { authorization: 'Bearer my-secret-key' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(mockedVerifyToken).toHaveBeenCalledWith('my-secret-key');
    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
    expect(req.userRole).toBe('admin');
  });

  it('accepts API key in X-API-Key header and sets req.userRole to admin', () => {
    setApiKey('header-key');
    const req = mockReq({ headers: { 'x-api-key': 'header-key' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
    expect(req.userRole).toBe('admin');
  });

  it('accepts JWT in X-API-Key header when API key does not match', () => {
    setApiKey('different-key');
    // No Bearer header, so verifyToken is only called once (from the X-API-Key path)
    mockedVerifyToken.mockReturnValueOnce({ userId: 7, username: 'bob' });
    const req = mockReq({ headers: { 'x-api-key': 'a-jwt-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('rejects API key in query param (round-2: query-string fallback removed)', () => {
    setApiKey('query-key');
    mockedGetUserCount.mockReturnValue(1);
    const req = mockReq({ query: { apiKey: 'query-key' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });

  it('allows open access when no API key configured and no users exist (fresh install)', () => {
    setApiKey('');
    mockedGetUserCount.mockReturnValue(0);
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
    expect(req.userRole).toBe('admin');
  });

  it('rejects when auth required but not provided', () => {
    setApiKey('configured-key');
    mockedGetUserCount.mockReturnValue(1);
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });

  it('rejects invalid Bearer token when API key also does not match', () => {
    setApiKey('real-key');
    mockedGetUserCount.mockReturnValue(1);
    const req = mockReq({ headers: { authorization: 'Bearer wrong-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });

  it('sets req.userId, req.username, and req.userRole from verified JWT payload', () => {
    mockedVerifyToken.mockReturnValue({ userId: 99, username: 'charlie', role: 'admin' });
    const req = mockReq({ headers: { authorization: 'Bearer good-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(req.userId).toBe(99);
    expect(req.username).toBe('charlie');
    expect(req.userRole).toBe('admin');
    expect(next).toHaveBeenCalled();
  });

  it('rejects API key via query param even when key matches (round-2)', () => {
    setApiKey('query-key');
    mockedGetUserCount.mockReturnValue(1);
    const req = mockReq({ query: { apiKey: 'query-key' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(req.userRole).toBeUndefined();
  });

  it('allows GET during fresh-install open-access window (no users, no key)', () => {
    setApiKey('');
    mockedGetUserCount.mockReturnValue(0);
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userRole).toBe('admin');
  });

  it('denies PUT during fresh-install open-access window (round-2 2.3 fix)', () => {
    setApiKey('');
    mockedGetUserCount.mockReturnValue(0);
    const req = mockReq({ method: 'PUT' });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'SETUP_REQUIRED', expect.stringContaining('first user'));
  });

  it('denies DELETE during fresh-install open-access window (round-2 2.3 fix)', () => {
    setApiKey('');
    mockedGetUserCount.mockReturnValue(0);
    const req = mockReq({ method: 'DELETE' });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'SETUP_REQUIRED', expect.stringContaining('first user'));
  });
});

// Regression suite for CODE_AUDIT.md Findings 1+2+3: a device-scoped JWT
// (carries `jti`) used to be trusted for role and identity straight off the
// signed payload as long as its connectedDevices row was still active. That
// let a deleted user's paired device keep authenticating (Finding 1) and a
// demoted admin's paired device keep admin rights (Finding 2) for up to the
// token's 30-day expiry. The fix re-resolves the owning user from the DB on
// every device-token request and takes the role from there, never from the
// JWT claim.
describe('apiAuth device-token (jti) branch — token revocation regressions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedIsDeviceActive.mockReturnValue(true);
    mockedGetUserCount.mockReturnValue(1);
  });

  it('rejects a device token whose owning user was deleted (Finding 1)', () => {
    mockedVerifyToken.mockReturnValue({ userId: 'deleted-user', username: 'ghost', role: 'admin', jti: 'device-1' });
    mockedGetUserById.mockReturnValue(undefined); // user row gone
    const req = mockReq({ headers: { authorization: 'Bearer device-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'USER_NOT_FOUND', expect.any(String));
    expect(req.userRole).toBeUndefined();
  });

  it('uses the live DB role, not the stale JWT claim, for a demoted admin device token (Finding 2)', () => {
    // Token was signed while the user was still admin; DB now says viewer.
    mockedVerifyToken.mockReturnValue({ userId: 'user-1', username: 'alice', role: 'admin', jti: 'device-2' });
    mockedGetUserById.mockReturnValue({ id: 'user-1', username: 'alice', role: 'viewer' });
    const req = mockReq({ headers: { authorization: 'Bearer device-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userRole).toBe('viewer');
  });

  it('still grants admin for an active device token whose owner remains admin', () => {
    mockedVerifyToken.mockReturnValue({ userId: 'user-1', username: 'alice', role: 'admin', jti: 'device-3' });
    mockedGetUserById.mockReturnValue({ id: 'user-1', username: 'alice', role: 'admin' });
    const req = mockReq({ headers: { authorization: 'Bearer device-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userRole).toBe('admin');
    expect(req.userId).toBe('user-1');
    expect(mockedTouchDevice).toHaveBeenCalledWith('device-3');
  });

  it('still rejects a revoked device before ever consulting the user row', () => {
    mockedIsDeviceActive.mockReturnValue(false);
    mockedVerifyToken.mockReturnValue({ userId: 'user-1', username: 'alice', role: 'admin', jti: 'device-4' });
    const req = mockReq({ headers: { authorization: 'Bearer device-token' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'DEVICE_REVOKED', expect.any(String));
    expect(mockedGetUserById).not.toHaveBeenCalled();
  });

  it('applies the same resolution through the X-API-Key JWT fallback path', () => {
    mockedVerifyToken.mockReturnValue({ userId: 'deleted-user', username: 'ghost', role: 'admin', jti: 'device-5' });
    mockedGetUserById.mockReturnValue(undefined);
    const req = mockReq({ headers: { 'x-api-key': 'device-token-in-header' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'USER_NOT_FOUND', expect.any(String));
  });
});

// Regression suite: the path-bypass list in apiAuth previously used `\b`
// after each path prefix, which is a *word*-boundary check, not a
// path-segment boundary. That let `/library/file%00something` and similar
// suffixes slip past auth. The fix anchors every entry on `(?:\?|/|$)`.
// These tests pin the new behavior so a future edit can't quietly regress it.
describe('apiAuth bypass-list anchoring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedVerifyToken.mockImplementation(() => {
      throw new Error('invalid token');
    });
    // Mark the install as non-fresh so anything that does NOT bypass auth
    // hits AUTH_REQUIRED rather than the fresh-install open-access window.
    mockedGetUserCount.mockReturnValue(1);
    setApiKey('configured-key');
  });

  function check(path: string, method = 'GET') {
    const req = mockReq({ path, method });
    const res = mockRes();
    const next = vi.fn();
    apiAuth(req, res, next);
    return { req, res, next };
  }

  // --- paths that MUST be bypassed (browsers load them via <img>/<a>) ---
  it.each([
    '/library/file',
    '/library/file?id=abc',
    '/library/file/sub/path.jpg',
    '/library/video',
    '/library/video?path=Moon/2026-08-27-202843-Lunar-timelapse.mp4',
    '/library/objects/M42/thumbnail',
    '/library/objects/M42/thumbnail?size=large',
    '/library/processed-images/something.jpg',
    '/library/download/tmp/abc-123',
    '/telescope/files',
    '/telescope/files?path=M42',
    '/telescope/objects/M42/thumbnail',
    '/reports/session/M42/2024-10-15',
    '/catalog/M42/image',
    '/catalog/M42/image?size=large',
    '/health',
    '/pair/start',
    '/pair/poll',
  ])('bypasses auth for %s', (path) => {
    const { next, res } = check(path);
    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
  });

  // --- paths that look bypassable under the old `\b` regex but MUST NOT be
  // --- under the new anchored regex ---
  it.each([
    // \x00 was the documented regression — word-boundary matched after `file`
    '/library/file%00something',
    '/library/filesensitive',
    '/library/fileSecret',
    '/telescope/filesEvil',
    '/library/objects/M42/thumbnailExtra',
    '/catalog/M42/imageData',
    // /reports/session/ requires a trailing slash with at least the prefix —
    // /reports/sessions/* (plural) is not in the bypass list at all
    '/reports/sessions',
    '/reports/sessions/secret',
    '/reports/session', // missing trailing slash — bypass requires `/reports/session/`
    // /pair/lookup and /pair/approve must require auth
    '/pair/lookup',
    '/pair/approve',
    // Unrelated paths
    '/library/objects/M42/delete',
    '/admin/users',
  ])('does NOT bypass auth for %s', (path) => {
    const { next, res } = check(path);
    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });

  // The whole-object ZIP GET is only reachable without a session when it
  // carries a valid signed `?t=` token (minted by the authenticated
  // POST .../link). The POST sub-routes under the same prefix always require
  // normal auth.
  it.each([
    '/library/download/objects/M42/subframes',
    '/library/download/objects/M42/subframe-filters',
    '/library/download/objects/M42/link',
  ])('does NOT bypass auth for POST %s', (path) => {
    const { next, res } = check(path, 'POST');
    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });

  it('does NOT bypass auth for GET /library/download/objects/M42 without a token', () => {
    mockedVerifyDownloadToken.mockReturnValue(false);
    const { next, res } = check('/library/download/objects/M42', 'GET');
    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });

  it('does NOT bypass auth for GET /library/download/objects/M42 with an invalid token', () => {
    mockedVerifyDownloadToken.mockReturnValue(false);
    const req = mockReq({ path: '/library/download/objects/M42', method: 'GET', query: { t: 'bogus' } });
    const res = mockRes();
    const next = vi.fn();
    apiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(mockedVerifyDownloadToken).toHaveBeenCalledWith('bogus', '/library/download/objects/M42');
  });

  it('bypasses auth for GET /library/download/objects/M42 with a valid signed token', () => {
    mockedVerifyDownloadToken.mockReturnValue(true);
    const req = mockReq({ path: '/library/download/objects/M42', method: 'GET', query: { t: 'valid-token' } });
    const res = mockRes();
    const next = vi.fn();
    apiAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
  });

  it('still bypasses auth for HEAD /library/file', () => {
    const { next, res } = check('/library/file', 'HEAD');
    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
  });

  // The bypass is READ-only. `DELETE /library/file` and `DELETE /telescope/files`
  // sit behind requireAdmin; if the bypass covered them it would strip
  // req.userRole and the guard would 403 every caller, admin included. They must
  // fall through to real auth here.
  it.each([
    ['/library/file', 'DELETE'],
    ['/telescope/files', 'DELETE'],
    ['/library/file', 'POST'],
    ['/library/objects/M42/thumbnail', 'DELETE'],
  ])('does NOT bypass auth for %s %s', (path, method) => {
    const { next, res } = check(path, method);
    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });
});

// Exercises the real admin-API-key path end to end (DB-backed setApiKey/
// getApiKey, sealed at rest, compared with timingSafeEqual) rather than the
// stale fs-mocked `loadApiKey()` helper above, which no longer intercepts
// anything real and only passes by accident via the fresh-install fallback.
describe('apiAuth admin API key (real DB-backed storage)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedVerifyToken.mockImplementation(() => {
      throw new Error('invalid token');
    });
    // Non-fresh-install: without this, a wrong/missing key request with no
    // other credentials would fall through to the open-access GET bypass
    // and pass for the wrong reason, exactly like the stale tests above.
    mockedGetUserCount.mockReturnValue(1);
  });

  afterEach(() => {
    setRealApiKey('');
  });

  it('round-trips a key through the sealed storage unchanged', () => {
    setRealApiKey('shub_roundtrip_test_key');
    expect(getRealApiKey()).toBe('shub_roundtrip_test_key');
  });

  it('accepts the real key in the Bearer header and grants admin', () => {
    setRealApiKey('shub_bearer_test_key');
    const req = mockReq({ headers: { authorization: 'Bearer shub_bearer_test_key' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
    expect(req.userRole).toBe('admin');
  });

  it('accepts the real key in the X-API-Key header and grants admin', () => {
    setRealApiKey('shub_header_test_key');
    const req = mockReq({ headers: { 'x-api-key': 'shub_header_test_key' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.apiError).not.toHaveBeenCalled();
    expect(req.userRole).toBe('admin');
  });

  it('rejects a same-length wrong key', () => {
    setRealApiKey('shub_correct_key_12345');
    const req = mockReq({ headers: { 'x-api-key': 'shub_wr0ng_key_abcdefg' } });
    const res = mockRes();
    const next = vi.fn();

    apiAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });

  it('rejects a different-length wrong key without throwing (timingSafeEqual length guard)', () => {
    setRealApiKey('shub_a_much_longer_configured_key');
    const req = mockReq({ headers: { 'x-api-key': 'short' } });
    const res = mockRes();
    const next = vi.fn();

    expect(() => apiAuth(req, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.apiError).toHaveBeenCalledWith(401, 'AUTH_REQUIRED', expect.stringContaining('Authentication required'));
  });
});
