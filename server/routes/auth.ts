import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { registerUser, loginUser, verifyToken, getUserById, getUserCount, getAllUsers, deleteUser, updateUserPassword, updateUserRole, updateUserProfile } from '../lib/auth.js';
import type { UserRole } from '../lib/auth.js';
import { requireAdmin } from '../middleware/auth.js';

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
  if (bucket.failures >= MAX_FAILURES) {
    bucket.blockedUntil = now + LOCKOUT_MS;
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
  role: z.enum(['admin', 'viewer']).optional(),
});

const PasswordBodySchema = z.object({
  password: z.string().min(1),
});

const ProfileBodySchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
});

const RoleBodySchema = z.object({
  role: z.enum(['admin', 'viewer']),
});

// Register the first user (setup only — closed once any account exists).
// Subsequent accounts must be created by an admin via POST /users.
router.post('/register', rateLimit, async (req: Request, res: Response) => {
  if (getUserCount() > 0) {
    res.apiError(403, 'REGISTRATION_CLOSED', 'Registration is closed. Ask an admin to create your account.');
    return;
  }
  const parsed = RegisterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  try {
    const { username, password, displayName, email } = parsed.data;
    const result = await registerUser(username, password, displayName, email);
    res.apiSuccess(result);
  } catch (err: unknown) {
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
    res.apiSuccess(result);
  } catch (err: unknown) {
    noteFailure(req);
    const username = (req.body as { username?: unknown })?.username;
    const message = err instanceof Error ? err.message : 'Login failed';
    console.warn('[auth] login_attempt outcome=failure username=%s ip=%s ua=%s error=%s', typeof username === 'string' ? username : 'unknown', ip, userAgent, message);
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
    const { userId } = verifyToken(token);
    const user = getUserById(userId);
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
    const userRole: UserRole = role === 'admin' ? 'admin' : 'viewer';
    await registerUser(username, password, displayName, email, userRole);
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
    const updated = await updateUserPassword(id, password);
    if (updated) {
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
  if (role !== 'admin') {
    const allUsers = getAllUsers();
    const target = allUsers.find(u => u.id === id);
    if (target?.role === 'admin' && allUsers.filter(u => u.role === 'admin').length <= 1) {
      res.apiError(400, 'LAST_ADMIN', 'Cannot remove admin role from the last admin account');
      return;
    }
  }
  const updated = updateUserRole(id, role as UserRole);
  if (updated) {
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
