import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { verifyToken, getUserCount, getUserTokenVersion, getUserById, type UserRole } from '../lib/auth.js';
import { getApiKey } from '../lib/telescopes.js';
import { isDeviceActive, touchDevice } from '../lib/devicePairing.js';
import { verifyDownloadToken } from '../lib/downloadToken.js';

/** Constant-time string comparison for the API key check below, so a wrong
 *  guess can't be distinguished from a right one by response timing.
 *  timingSafeEqual throws on unequal-length buffers rather than returning
 *  false, so the length check has to come first — an acceptable leak (key
 *  length, not content) that's how Node's own docs recommend using it. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

interface TokenIdentity {
  userId: string;
  username: string;
  role: UserRole;
}
interface TokenRejection {
  status: number;
  code: string;
  message: string;
}

/**
 * Resolves a verified JWT payload against live DB state and decides whether
 * the request may proceed. Shared by the Bearer and X-API-Key branches below
 * so the two auth paths can't silently drift apart.
 *
 * For device-scoped tokens (`jti` set): besides the existing revocation
 * check, the owning user is looked up fresh and the ROLE IS TAKEN FROM THE
 * DB, never from the JWT claim. This closes two gaps a device token could
 * otherwise exploit for up to its 30-day expiry: a deleted user's device
 * token stops authenticating (no user row to resolve), and a demoted
 * admin's device token stops carrying admin rights (role is re-read live,
 * not trusted from the signed-but-stale claim).
 *
 * For login tokens (no `jti`): unchanged tokenVersion check, which is how
 * password changes already invalidate them.
 */
function resolveTokenAuth(payload: ReturnType<typeof verifyToken>): TokenIdentity | TokenRejection {
  if (payload.jti) {
    if (!isDeviceActive(payload.jti)) {
      return { status: 401, code: 'DEVICE_REVOKED', message: 'This device has been disconnected.' };
    }
    const owner = getUserById(payload.userId);
    if (!owner) {
      return { status: 401, code: 'USER_NOT_FOUND', message: 'Account no longer exists. Please log in again.' };
    }
    touchDevice(payload.jti);
    return { userId: owner.id, username: owner.username, role: owner.role };
  }

  // Login token: verify tokenVersion hasn't been bumped since issue.
  // Bumped on password change; version 0 is the default for existing accounts.
  const dbVersion = getUserTokenVersion(payload.userId);
  if (dbVersion === undefined) {
    return { status: 401, code: 'USER_NOT_FOUND', message: 'Account no longer exists. Please log in again.' };
  }
  if ((payload.tokenVersion ?? 0) !== dbVersion) {
    return { status: 401, code: 'SESSION_INVALIDATED', message: 'Session invalidated. Please log in again.' };
  }
  return { userId: payload.userId, username: payload.username, role: payload.role };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') {
    res.apiError(403, 'FORBIDDEN', 'This action requires admin access.');
    return;
  }
  next();
}

/**
 * Authentication middleware — accepts either:
 *   1. JWT token via `Authorization: Bearer <token>` (from user login)
 *   2. API key via `X-API-Key: <key>` header (for programmatic access)
 *
 * NOTE: The `?apiKey=` query-string fallback was REMOVED in round 2 of the
 * audit. Query strings end up in proxy access logs and browser history, which
 * leaks credentials. Use the `X-API-Key` header instead.
 *
 * When no API key is configured and no users exist, only safe (GET) and
 * auth-bootstrap paths are allowed without authentication (initial setup).
 * Writes are denied until the first user registers, closing the window where
 * a LAN-exposed fresh install was wide open (audit 2.3).
 */
export function apiAuth(req: Request, res: Response, next: NextFunction) {
  // Skip auth for public auth endpoints only.
  // User-management routes (/auth/users*) still require a valid token.
  const PUBLIC_AUTH = ['/auth/login', '/auth/register', '/auth/status'];
  if (PUBLIC_AUTH.some(p => req.path === p || req.path.startsWith(p + '?'))) {
    return next();
  }

  // TV pairing: /pair/start and /pair/poll are reached *before* the device
  // has a token. /pair/lookup and /pair/approve still require a logged-in
  // user and fall through to the regular auth path below.
  if (req.path === '/pair/start' || req.path === '/pair/poll') {
    return next();
  }

  // Skip auth for the health endpoint so Docker/orchestrator healthchecks
  // can probe it without credentials.
  if (req.path === '/health') {
    return next();
  }

  // The native menubar app polls this to pick up applyRequested and mirror the
  // user's channel/auto-update preference onto Sparkle. It has no auth token,
  // and the response is version-status only — nothing sensitive. Writes
  // (POST /meta/update/apply) are still guarded by requireAdmin separately.
  if (req.path === '/meta/update' && (req.method === 'GET' || req.method === 'HEAD')) {
    return next();
  }

  // Skip auth for file-serving endpoints that browsers load via <img> tags or
  // direct navigation — these cannot send Authorization headers. Path-derived
  // bytes, no session header. The whole-object ZIP ("Download All") is NOT in
  // this list: it goes through a signed `?t=` token instead (see the dedicated
  // block below), because a ZIP of everything is both sensitive and expensive
  // and does not need to be a bare public URL the way an <img> src does.
  //
  // READ METHODS ONLY. Several of these prefixes also host a mutating route:
  // `DELETE /library/file` and `DELETE /telescope/files` both sit behind
  // `requireAdmin`. If the bypass covered them it would strip `req.userRole`
  // before that guard ran, so the guard would 403 EVERY caller including a real
  // admin, making the route impossible to use (regression seen 2026-08).
  //
  // Anchored explicitly to "?", "/", or end-of-path. Using \b after the path
  // matched arbitrary characters (e.g. `/library/file%00something`) because \b
  // is a word-boundary check, not a path-segment check.
  const isReadMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';

  // Whole-object ZIP download. A browser <a download> click cannot send an
  // Authorization header, so the SPA first calls the authenticated
  // `POST /library/download/objects/:id/link` to mint a short-lived signed
  // token and the browser then GETs this route with `?t=<token>`. The token is
  // bound to this exact path and expires in minutes (see lib/downloadToken.ts).
  // An ordinary authenticated request (fetch with Bearer) has no `t` and just
  // falls through to the normal auth path below. The `[^/]+` segment keeps the
  // POST sub-routes (`/subframes`, `/subframe-filters`, `/link`) out of this.
  if (isReadMethod && /^\/library\/download\/objects\/[^/]+\/?$/.test(req.path)) {
    const t = req.query.t;
    let scope = req.path;
    try { scope = decodeURIComponent(req.path); } catch { /* keep raw */ }
    if (typeof t === 'string' && verifyDownloadToken(t, scope)) {
      return next();
    }
  }

  if (
    isReadMethod && (
      req.path.match(/^\/library\/file(\?|\/|$)/) ||
      req.path.match(/^\/library\/file\/thumbnail(\?|\/|$)/) ||
      // <video src> and the native clients' AVPlayer/ExoPlayer cannot send an
      // Authorization header, same as <img>. Path-derived bytes, contained to the
      // library root by the route.
      req.path.match(/^\/library\/video(\?|\/|$)/) ||
      req.path.match(/^\/library\/fits-thumbnail(\?|\/|$)/) ||
      req.path.match(/^\/library\/tiff-thumbnail(\?|\/|$)/) ||
      req.path.match(/^\/library\/objects\/[^/]+\/thumbnail(\?|\/|$)/) ||
      req.path.match(/^\/library\/processed-images\//) ||
      // Pre-built subframe ZIPs served by one-time token (the token IS the
      // credential — see the 3-phase flow in routes/library.ts). The
      // whole-object ZIP route (`/library/download/objects/:id`) is handled
      // separately above via a signed `?t=` token.
      req.path.match(/^\/library\/download\/tmp\//) ||
      req.path.match(/^\/telescope\/files(\?|\/|$)/) ||
      req.path.match(/^\/telescope\/objects\/[^/]+\/thumbnail(\?|\/|$)/) ||
      req.path.match(/^\/reports\/session\//) ||
      req.path.match(/^\/catalog\/[^/]+\/image(\?|\/|$)/) ||
      req.path.match(/^\/catalog\/[^/]+\/sky(\?|\/|$)/) ||
      req.path.match(/^\/catalog\/prefetch\/pack-debug(\?|$)/)
    )
  ) {
    return next();
  }

  // Try JWT token first (from Authorization: Bearer header)
  // \s+ followed by .+ are adjacent quantifiers over overlapping character
  // classes (both match a space) — worst-case quadratic backtracking on a
  // client-controlled header. \S+ for the token is disjoint from \s+ (a JWT
  // never contains whitespace anyway), which removes the ambiguity entirely.
  const bearerMatch = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (bearerMatch) {
    const token = bearerMatch[1];

    // Try as JWT first
    try {
      const payload = verifyToken(token);
      const identity = resolveTokenAuth(payload);
      if ('status' in identity) {
        res.apiError(identity.status, identity.code, identity.message);
        return;
      }
      // Attach user info to request for downstream use
      req.userId = identity.userId;
      req.username = identity.username;
      req.userRole = identity.role;
      return next();
    } catch {
      // Not a valid JWT — try as API key below
    }

    // Try as API key — API key holders get admin access
    const configuredKey = getApiKey();
    if (configuredKey && safeEqual(token, configuredKey)) {
      req.userRole = 'admin';
      return next();
    }
  }

  // Try X-API-Key header
  const rawHeaderKey = req.headers['x-api-key'];
  const headerKey = typeof rawHeaderKey === 'string' ? rawHeaderKey : undefined;
  if (headerKey) {
    const configuredKey = getApiKey();
    if (configuredKey && safeEqual(headerKey, configuredKey)) {
      req.userRole = 'admin';
      return next();
    }
    // Also try as JWT
    try {
      const payload = verifyToken(headerKey);
      const identity = resolveTokenAuth(payload);
      if ('status' in identity) {
        res.apiError(identity.status, identity.code, identity.message);
        return;
      }
      req.userId = identity.userId;
      req.username = identity.username;
      req.userRole = identity.role;
      return next();
    } catch { /* not a JWT */ }
  }

  // The `?apiKey=` query-string fallback was removed: query parameters end up
  // in HTTP access logs, browser history, and Referer headers. Use the
  // `X-API-Key` header (or `Authorization: Bearer`) instead.

  // No auth provided — check if auth is required
  const configuredKey = getApiKey();
  let hasUsers = false;
  try {
    hasUsers = getUserCount() > 0;
  } catch (err) {
    // DB unavailable: fail closed — never silently grant admin
    console.error('[auth] DB unavailable during open-access check, denying request:', err);
    res.apiError(503, 'SERVICE_UNAVAILABLE', 'Database unavailable');
    return;
  }

  // If no API key configured AND no users exist, allow open access for SAFE
  // requests only (GETs + the auth/pair/health bootstrap surface). State-
  // changing methods are denied so a LAN-exposed fresh install can't be
  // mutated by an unauthenticated network neighbour. The onboarding flow
  // calls POST /auth/register first (which is in the PUBLIC_AUTH list above
  // and bypasses this branch), then attaches the issued Bearer token to
  // every subsequent write.
  if (!configuredKey && !hasUsers) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      req.userRole = 'admin';
      return next();
    }
    res.apiError(401, 'SETUP_REQUIRED',
      'Create the first user account before performing write operations.');
    return;
  }

  res.apiError(401, 'AUTH_REQUIRED',
    'Authentication required. Use Authorization: Bearer <token> from /auth/login, or X-API-Key header.');
}
