/**
 * User authentication — JWT-based.
 * Users stored in SQLite. Passwords hashed with bcrypt.
 */
import fs from 'fs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { DATA_DIR } from './paths.js';
import path from 'path';
import db from './db.js';

function loadJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const secretPath = path.join(DATA_DIR, '.jwt-secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  const generated = randomBytes(32).toString('base64');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

const JWT_SECRET = loadJwtSecret();

const TOKEN_EXPIRY = '30d';

export type UserRole = 'admin' | 'viewer';

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  createdAt: string;
  role: UserRole;
  tokenVersion: number;
}

export interface AuthToken {
  token: string;
  expiresIn: string;
  user: { id: string; username: string; displayName: string; role: UserRole };
}

type PublicUser = Omit<User, 'passwordHash'>;
interface CountRow { c: number }

// Typed prepared statements — shapes propagate to `.get()` / `.all()`.
// SQL trust boundary: column types are enforced by the users CREATE TABLE in db.ts.
const stmts = {
  getById: db.prepare<[string], User>('SELECT * FROM users WHERE id = ?'),
  getByUsername: db.prepare<[string], User>('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  getByEmail: db.prepare<[string], User>('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  getAll: db.prepare<[], PublicUser>('SELECT id, username, email, displayName, createdAt, role FROM users'),
  count: db.prepare<[], CountRow>('SELECT COUNT(*) as c FROM users'),
  insert: db.prepare(
    'INSERT INTO users (id, username, email, passwordHash, displayName, createdAt, role) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  delete: db.prepare('DELETE FROM users WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?'),
  updateRole: db.prepare("UPDATE users SET role = ? WHERE id = ?"),
  updateProfile: db.prepare('UPDATE users SET displayName = ?, email = ? WHERE id = ?'),
  bumpTokenVersion: db.prepare('UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?'),
  getTokenVersion: db.prepare<[string], { tokenVersion: number }>('SELECT tokenVersion FROM users WHERE id = ?'),
};

export async function registerUser(
  username: string,
  password: string,
  displayName?: string,
  email?: string,
  role: UserRole = 'admin',
): Promise<AuthToken> {
  // Validate
  if (!username || username.length < 3) {
    throw new Error('Username must be at least 3 characters');
  }
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
  if (stmts.getByUsername.get(username)) {
    throw new Error('Username already exists');
  }
  if (email && stmts.getByEmail.get(email)) {
    throw new Error('Email already in use');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user: User = {
    id: randomUUID(),
    username: username.toLowerCase(),
    email: email?.toLowerCase() || '',
    passwordHash,
    displayName: displayName || username,
    createdAt: new Date().toISOString(),
    role,
    tokenVersion: 0,
  };

  stmts.insert.run(user.id, user.username, user.email, user.passwordHash, user.displayName, user.createdAt, user.role);

  return generateToken(user);
}

export async function loginUser(username: string, password: string): Promise<AuthToken> {
  const user = stmts.getByUsername.get(username);

  if (!user) {
    throw new Error('Invalid username or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid username or password');
  }

  return generateToken(user);
}

function isJwtPayload(value: unknown): value is { userId: string; username: string; role?: string; jti?: string; tokenVersion?: number } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.userId === 'string' && typeof v.username === 'string';
}

export function verifyToken(token: string): { userId: string; username: string; role: UserRole; jti?: string; tokenVersion?: number } {
  try {
    const payload: unknown = jwt.verify(token, JWT_SECRET);
    if (!isJwtPayload(payload)) {
      throw new Error('Token payload missing userId/username');
    }
    const role: UserRole = payload.role === 'viewer' ? 'viewer' : 'admin';
    return {
      userId: payload.userId,
      username: payload.username,
      role,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      tokenVersion: typeof payload.tokenVersion === 'number' ? payload.tokenVersion : undefined,
    };
  } catch {
    throw new Error('Invalid or expired token');
  }
}

/**
 * Issue a long-lived JWT scoped to a specific device. The `jti` claim ties
 * the token to a row in `connectedDevices` so users can revoke individual
 * devices from Settings without invalidating their other sessions.
 */
export function generateDeviceToken(user: User, deviceId: string): string {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role, jti: deviceId },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

export function getUserById(userId: string): User | undefined {
  return stmts.getById.get(userId);
}

export function getUserCount(): number {
  const row = stmts.count.get();
  return row?.c ?? 0;
}

export function getAllUsers(): Array<Omit<User, 'passwordHash'>> {
  return stmts.getAll.all();
}

export function deleteUser(userId: string): boolean {
  const result = stmts.delete.run(userId);
  return result.changes > 0;
}

export async function updateUserPassword(userId: string, newPassword: string): Promise<boolean> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  // Bump tokenVersion atomically with the password change so any existing login
  // tokens for this user are rejected by the auth middleware immediately.
  const tx = db.transaction(() => {
    const r = stmts.updatePassword.run(passwordHash, userId);
    stmts.bumpTokenVersion.run(userId);
    return r;
  });
  const result = tx();
  return result.changes > 0;
}

export function updateUserRole(userId: string, role: UserRole): boolean {
  const result = stmts.updateRole.run(role, userId);
  return result.changes > 0;
}

export function updateUserProfile(userId: string, displayName: string, email: string): boolean {
  const result = stmts.updateProfile.run(displayName, email.toLowerCase(), userId);
  return result.changes > 0;
}

export function getUserTokenVersion(userId: string): number | undefined {
  return stmts.getTokenVersion.get(userId)?.tokenVersion;
}

function generateToken(user: User): AuthToken {
  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  return {
    token,
    expiresIn: TOKEN_EXPIRY,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
  };
}
