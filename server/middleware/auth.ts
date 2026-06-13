import { Request, Response, NextFunction } from 'express';
import { verifyToken, getUserCount } from '../lib/auth.js';
import { getApiKey } from '../lib/telescopes.js';
import { isDeviceActive, touchDevice } from '../lib/devicePairing.js';

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
  // direct navigation — these cannot send Authorization headers.
  // The "Download All" button uses a plain <a href> that streams a ZIP from
  // /library/download/objects/:id, so it falls in the same bucket as /library/file:
  // path-derived bytes, no session header. (Two-phase /download/tmp flow exists
  // for multi-session subframes but isn't used here.)
  //
  // Anchored explicitly to "?", "/", or end-of-path. Using \b after the path
  // matched arbitrary characters (e.g. `/library/file%00something`) because \b
  // is a word-boundary check, not a path-segment check.
  if (
    req.path.match(/^\/library\/file(\?|\/|$)/) ||
    req.path.match(/^\/library\/file\/thumbnail(\?|\/|$)/) ||
    req.path.match(/^\/library\/objects\/[^/]+\/thumbnail(\?|\/|$)/) ||
    req.path.match(/^\/library\/processed-images\//) ||
    req.path.match(/^\/library\/download\/objects\//) ||
    req.path.match(/^\/library\/download\/tmp\//) ||
    req.path.match(/^\/telescope\/files(\?|\/|$)/) ||
    req.path.match(/^\/telescope\/objects\/[^/]+\/thumbnail(\?|\/|$)/) ||
    req.path.match(/^\/reports\/session\//) ||
    req.path.match(/^\/catalog\/[^/]+\/image(\?|\/|$)/) ||
    req.path.match(/^\/catalog\/prefetch\/pack-debug(\?|$)/)
  ) {
    return next();
  }

  // Try JWT token first (from Authorization: Bearer header)
  const bearerMatch = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    const token = bearerMatch[1];

    // Try as JWT first
    try {
      const payload = verifyToken(token);
      // Device-scoped tokens carry a `jti`. If the user has revoked the device
      // (or it was deleted), reject the token even though the signature is valid.
      if (payload.jti) {
        if (!isDeviceActive(payload.jti)) {
          res.apiError(401, 'DEVICE_REVOKED', 'This device has been disconnected.');
          return;
        }
        touchDevice(payload.jti);
      }
      // Attach user info to request for downstream use
      req.userId = payload.userId;
      req.username = payload.username;
      req.userRole = payload.role;
      return next();
    } catch {
      // Not a valid JWT — try as API key below
    }

    // Try as API key — API key holders get admin access
    const configuredKey = getApiKey();
    if (configuredKey && token === configuredKey) {
      req.userRole = 'admin';
      return next();
    }
  }

  // Try X-API-Key header
  const rawHeaderKey = req.headers['x-api-key'];
  const headerKey = typeof rawHeaderKey === 'string' ? rawHeaderKey : undefined;
  if (headerKey) {
    const configuredKey = getApiKey();
    if (configuredKey && headerKey === configuredKey) {
      req.userRole = 'admin';
      return next();
    }
    // Also try as JWT
    try {
      const payload = verifyToken(headerKey);
      if (payload.jti) {
        if (!isDeviceActive(payload.jti)) {
          res.apiError(401, 'DEVICE_REVOKED', 'This device has been disconnected.');
          return;
        }
        touchDevice(payload.jti);
      }
      req.userId = payload.userId;
      req.username = payload.username;
      req.userRole = payload.role;
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
