import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { registerUser, loginUser, verifyToken, getUserById, getUserCount, getAllUsers, deleteUser, updateUserPassword, updateUserRole, updateUserProfile, getUserTokenVersion, USER_ROLES } from '../lib/auth.js';
import { requireAdmin } from '../middleware/auth.js';
import { isDeviceActive, touchDevice, revokeAllDevicesForUser } from '../lib/devicePairing.js';
import { logEvent } from '../lib/systemLog.js';

const router = Router();

// ─── Lightweight in-memory rate limiter for auth endpoints ──────────────────
// Limits failed attempts per source IP. Acceptable for a single-process LAN
// server; not suitable behind a load balancer (state isn't shared).
interface RateLimitBucket { failures: number; firstFailureAt: number; blockedUntil: number }
const rateBuckets = new Map<string, RateLimitBucket>();
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 10;                // per window, per IP
const LOCKOUT_MS = 15 * 60 * 1000;     // block duration after exceeding
const MAX_BUCKETS = 10_000;             // hard cap — evicts oldest on overflow

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = clientIp(req);
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (bucket) {
    if (bucket.blockedUntil > now) {
      res.setHeader('Retry-After', Math.ceil((bucket.blockedUntil - now) / 1000));
      res.apiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.');
      return;
    }
    // Reset window if expired
    if (now - bucket.firstFailureAt > RATE_WINDOW_MS) {
      rateBuckets.delete(ip);
    }
  }
  next();
}

function noteFailure(req: Request): void {
  const ip = clientIp(req);
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.firstFailureAt > RATE_WINDOW_MS) {
    if (rateBuckets.size >= MAX_BUCKETS) {
      rateBuckets.delete(rateBuckets.keys().next().value!);
    }
    rateBuckets.set(ip, { failures: 1, firstFailureAt: now, blockedUntil: 0 });
    return;
  }
  bucket.failures++;
  if (bucket.failures >= MAX_FAILURES && bucket.blockedUntil <= now) {
    bucket.blockedUntil = now + LOCKOUT_MS;
    logEvent({
      category: 'auth',
      event: 'rate_limited',
      level: 'warning',
      message: `Blocked further sign-in attempts from ${ip} after ${bucket.failures} failures.`,
      ip,
      metadata: { failures: bucket.failures, lockoutMs: LOCKOUT_MS },
    });
  }
}

function noteSuccess(req: Request): void {
  rateBuckets.delete(clientIp(req));
}

// Periodic GC so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) {
    if (b.blockedUntil < now && now - b.firstFailureAt > RATE_WINDOW_MS) {
      rateBuckets.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref?.();

const RegisterBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  displayName: z.string().optional(),
  email: z.string().optional(),
});

const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const CreateUserBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  displayName: z.string().optional(),
  email: z.string().optional(),
  role: z.enum(USER_ROLES).optional(),
});

const PasswordBodySchema = z.object({
  password: z.string().min(1),
});

const ProfileBodySchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
});

const RoleBodySchema = z.object({
  role: z.enum(USER_ROLES),
});

// getUserCount() > 0 and the eventual insert inside registerUser() are
// separated by an await (bcrypt.hash), so two concurrent first-registration
// requests could both observe count === 0 and both create an admin account
// (CODE_AUDIT.md Finding 10). Serializing the whole check-then-register
// sequence through this process-local queue closes the window — the server
// is a single Node process, so this is sufficient without a DB-level lock.
let registrationQueue: Promise<void> = Promise.resolve();
function serializeFirstRegistration<T>(fn: () => Promise<T>): Promise<T> {
  const run = registrationQueue.then(fn);
  registrationQueue = run.then(() => undefined, () => undefined);
  return run;
}

class RegistrationClosedError extends Error {}
class RegisterValidationError extends Error {}

// Register the first user (setup only — closed once any account exists).
// Subsequent accounts must be created by an admin via POST /users.
router.post('/register', rateLimit, async (req: Request, res: Response) => {
  try {
    const result = await serializeFirstRegistration(async () => {
      if (getUserCount() > 0) {
        throw new RegistrationClosedError();
      }
      const parsed = RegisterBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RegisterValidationError(parsed.error.issues[0]?.message ?? 'Invalid request body');
      }
      const { username, password, displayName, email } = parsed.data;
      return registerUser(username, password, displayName, email);
    });
    logEvent({
      category: 'auth',
      event: 'first_user_registered',
      message: `Created the first account, "${result.user.username}".`,
      userId: result.user.id,
      username: result.user.username,
      ip: clientIp(req),
    });
    res.apiSuccess(result);
  } catch (err: unknown) {
    if (err instanceof RegistrationClosedError) {
      res.apiError(403, 'REGISTRATION_CLOSED', 'Registration is closed. Ask an admin to create your account.');
      return;
    }
    if (err instanceof RegisterValidationError) {
      res.apiError(422, 'VALIDATION_ERROR', err.message);
      return;
    }
    noteFailure(req);
    const message = err instanceof Error ? err.message : 'Registration failed';
    res.apiError(400, 'REGISTRATION_FAILED', message);
  }
});

// Login
router.post('/login', rateLimit, async (req: Request, res: Response) => {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] ?? 'unknown';

  const parsed = LoginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn('[auth] login_attempt outcome=missing_credentials ip=%s ua=%s', ip, userAgent);
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }

  try {
    const { username, password } = parsed.data;
    const result = await loginUser(username, password);
    noteSuccess(req);
    console.log('[auth] login_attempt outcome=success username=%s ip=%s ua=%s', username, ip, userAgent);
    logEvent({
      category: 'auth',
      event: 'login_success',
      message: `Signed in as "${username}".`,
      userId: result.user.id,
      username: result.user.username,
      ip,
    });
    res.apiSuccess(result);
  } catch (err: unknown) {
    noteFailure(req);
    const username = (req.body as { username?: unknown })?.username;
    const usernameStr = typeof username === 'string' ? username : 'unknown';
    const message = err instanceof Error ? err.message : 'Login failed';
    console.warn('[auth] login_attempt outcome=failure username=%s ip=%s ua=%s error=%s', usernameStr, ip, userAgent, message);
    logEvent({
      category: 'auth',
      event: 'login_failed',
      level: 'warning',
      message: `Failed sign-in attempt for "${usernameStr}".`,
      username: usernameStr,
      ip,
    });
    res.apiError(401, 'LOGIN_FAILED', message);
  }
});

// Get current user (validate token)
router.get('/me', async (req: Request, res: Response) => {
  try {
    const token = extractToken(req);
    if (!token) {
      res.apiError(401, 'NO_TOKEN', 'Authentication required');
      return;
    }
    const payload = verifyToken(token);
    // Mirror middleware/auth.ts's checks: a valid signature alone isn't
    // enough. A device-scoped token (jti) must belong to a still-active
    // device; a login token must carry the user's current tokenVersion, so
    // a revoked device or a token issued before a password change fails
    // this "is my session still valid?" probe instead of quietly passing it.
    if (payload.jti) {
      if (!isDeviceActive(payload.jti)) {
        res.apiError(401, 'DEVICE_REVOKED', 'This device has been disconnected.');
        return;
      }
      touchDevice(payload.jti);
    } else {
      const dbVersion = getUserTokenVersion(payload.userId);
      if (dbVersion === undefined) {
        res.apiError(401, 'USER_NOT_FOUND', 'Account no longer exists. Please log in again.');
        return;
      }
      if ((payload.tokenVersion ?? 0) !== dbVersion) {
        res.apiError(401, 'SESSION_INVALIDATED', 'Session invalidated. Please log in again.');
        return;
      }
    }
    const user = getUserById(payload.userId);
    if (!user) {
      res.apiError(401, 'USER_NOT_FOUND', 'User no longer exists');
      return;
    }
    res.apiSuccess({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      createdAt: user.createdAt,
      role: user.role,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Auth failed';
    res.apiError(401, 'AUTH_FAILED', message);
  }
});

// Check if setup is needed (no users exist yet)
router.get('/status', (_req: Request, res: Response) => {
  const count = getUserCount();
  res.apiSuccess({
    hasUsers: count > 0,
    userCount: count,
    requiresSetup: count === 0,
  });
});

// ─── User Management (admin) ─────────────────────────────────────

// List all users
router.get('/users', requireAdmin, (_req: Request, res: Response) => {
  const users = getAllUsers();
  res.apiSuccess(users);
});

// Create a user (admin action — no token returned, just creates the account)
router.post('/users', requireAdmin, async (req: Request, res: Response) => {
  const parsed = CreateUserBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  try {
    const { username, password, displayName, email, role } = parsed.data;
    await registerUser(username, password, displayName, email, role ?? 'viewer');
    logEvent({
      category: 'user',
      event: 'created',
      message: `Created user "${username}" with role ${role ?? 'viewer'}.`,
      userId: req.userId,
      username: req.username,
      ip: clientIp(req),
      metadata: { targetUsername: username, role: role ?? 'viewer' },
    });
    // Return user list instead of token
    res.apiSuccess(getAllUsers());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create user';
    res.apiError(400, 'CREATE_FAILED', message);
  }
});

// Delete a user
router.delete('/users/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const allUsers = getAllUsers();
  const target = allUsers.find(u => u.id === id);
  if (!target) {
    res.apiError(404, 'NOT_FOUND', 'User not found');
    return;
  }
  if (target.role === 'admin' && allUsers.filter(u => u.role === 'admin').length <= 1) {
    res.apiError(400, 'LAST_ADMIN', 'Cannot delete the last admin account');
    return;
  }
  const deleted = deleteUser(id);
  if (deleted) {
    // connectedDevices has no FK to users, so a deleted user's paired
    // devices are otherwise orphaned rows that a stolen/leaked device
    // token could still resolve against if this cleanup were skipped.
    revokeAllDevicesForUser(id, 'user_deleted');
    logEvent({
      category: 'user',
      event: 'deleted',
      level: 'warning',
      message: `Deleted user "${target.username}".`,
      userId: req.userId,
      username: req.username,
      ip: clientIp(req),
      metadata: { targetUsername: target.username, targetUserId: target.id },
    });
    res.apiSuccess(getAllUsers());
  } else {
    res.apiError(404, 'NOT_FOUND', 'User not found');
  }
});

// Reset a user's password
router.put('/users/:id/password', requireAdmin, async (req: Request, res: Response) => {
  const parsed = PasswordBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  try {
    const id = String(req.params.id);
    const { password } = parsed.data;
    const target = getAllUsers().find(u => u.id === id);
    const updated = await updateUserPassword(id, password);
    if (updated) {
      // "Change password to log out all sessions" should also cover paired
      // devices — device tokens don't carry a tokenVersion claim, so the
      // bump inside updateUserPassword only invalidates login tokens.
      revokeAllDevicesForUser(id, 'password_changed');
      logEvent({
        category: 'user',
        event: 'password_reset',
        level: 'warning',
        message: `Reset the password for "${target?.username ?? id}".`,
        userId: req.userId,
        username: req.username,
        ip: clientIp(req),
        metadata: { targetUsername: target?.username ?? null, targetUserId: id },
      });
      res.apiSuccess({ updated: true });
    } else {
      res.apiError(404, 'NOT_FOUND', 'User not found');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update password';
    res.apiError(400, 'UPDATE_FAILED', message);
  }
});

// Update a user's display name and email
router.put('/users/:id/profile', requireAdmin, async (req: Request, res: Response) => {
  const parsed = ProfileBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const id = String(req.params.id);
  const { displayName, email } = parsed.data;
  const updated = updateUserProfile(id, displayName, email ?? '');
  if (updated) {
    res.apiSuccess(getAllUsers());
  } else {
    res.apiError(404, 'NOT_FOUND', 'User not found');
  }
});

// Change a user's role
router.put('/users/:id/role', requireAdmin, (req: Request, res: Response) => {
  const parsed = RoleBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const id = String(req.params.id);
  const { role } = parsed.data;
  const allUsersBefore = getAllUsers();
  const target = allUsersBefore.find(u => u.id === id);
  if (role !== 'admin') {
    if (target?.role === 'admin' && allUsersBefore.filter(u => u.role === 'admin').length <= 1) {
      res.apiError(400, 'LAST_ADMIN', 'Cannot remove admin role from the last admin account');
      return;
    }
  }
  const updated = updateUserRole(id, role);
  if (updated) {
    logEvent({
      category: 'user',
      event: 'role_changed',
      level: 'warning',
      message: `Changed the role of "${target?.username ?? id}" from ${target?.role ?? 'unknown'} to ${role}.`,
      userId: req.userId,
      username: req.username,
      ip: clientIp(req),
      metadata: { targetUsername: target?.username ?? null, targetUserId: id, oldRole: target?.role ?? null, newRole: role },
    });
    res.apiSuccess(getAllUsers());
  } else {
    res.apiError(404, 'NOT_FOUND', 'User not found');
  }
});

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Express returns arrays when the same header is sent more than once. We
  // explicitly reject those rather than blindly casting — duplicate auth
  // headers are almost always a sign of a misconfigured proxy or attack.
  const raw = req.headers['x-auth-token'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

export { router as authRouter };
