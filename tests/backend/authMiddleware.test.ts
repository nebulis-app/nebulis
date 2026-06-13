import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiAuth } from '../../server/middleware/auth';

// Mock the auth module
vi.mock('../../server/lib/auth', () => ({
  verifyToken: vi.fn(),
  getUserCount: vi.fn(),
}));

import { verifyToken, getUserCount } from '../../server/lib/auth';

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

const mockedVerifyToken = verifyToken as ReturnType<typeof vi.fn>;
const mockedGetUserCount = getUserCount as ReturnType<typeof vi.fn>;
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

  function check(path: string) {
    const req = mockReq({ path });
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
    '/library/objects/M42/thumbnail',
    '/library/objects/M42/thumbnail?size=large',
    '/library/processed-images/something.jpg',
    '/library/download/objects/M42',
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
});
