import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerUser,
  loginUser,
  verifyToken,
  getUserById,
  getUserCount,
  getAllUsers,
  deleteUser,
  updateUserPassword,
} from '../../server/lib/auth';
import db from '../../server/lib/db';

describe('auth', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM users').run();
  });

  // --- registerUser ---

  it('rejects username shorter than 3 characters', async () => {
    await expect(registerUser('ab', 'password123')).rejects.toThrow(
      'Username must be at least 3 characters'
    );
  });

  it('rejects password shorter than 6 characters', async () => {
    await expect(registerUser('testuser', '12345')).rejects.toThrow(
      'Password must be at least 6 characters'
    );
  });

  it('registers a user and returns a valid AuthToken', async () => {
    const result = await registerUser('Alice', 'secret99', 'Alice W', 'alice@example.com');

    // JWTs are three base64url-encoded segments separated by dots: header.payload.signature.
    // Plain `length > 0` would pass for "x" — a regex pins the actual shape.
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(result.expiresIn).toBe('30d');
    expect(result.user.username).toBe('alice');
    expect(result.user.displayName).toBe('Alice W');
    // user.id is a randomUUID — pin its shape too.
    expect(result.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('stores username as lowercase and password as a hash', async () => {
    await registerUser('BobUser', 'mypassword');

    const raw = db.prepare('SELECT * FROM users').all() as Array<{ username: string; passwordHash: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].username).toBe('bobuser');
    expect(raw[0].passwordHash).not.toBe('mypassword');
    expect(raw[0].passwordHash.startsWith('$2')).toBe(true);
  });

  it('rejects duplicate usernames (case-insensitive)', async () => {
    await registerUser('charlie', 'password1');
    await expect(registerUser('Charlie', 'password2')).rejects.toThrow(
      'Username already exists'
    );
  });

  it('rejects duplicate emails', async () => {
    await registerUser('user1', 'password1', undefined, 'dupe@example.com');
    await expect(
      registerUser('user2', 'password2', undefined, 'Dupe@Example.com')
    ).rejects.toThrow('Email already in use');
  });

  // --- loginUser ---

  it('logs in with valid credentials', async () => {
    const reg = await registerUser('dave', 'hunter42');
    const login = await loginUser('dave', 'hunter42');

    expect(typeof login.token).toBe('string');
    expect(login.user.id).toBe(reg.user.id);
    expect(login.user.username).toBe('dave');
  });

  it('logs in with case-insensitive username', async () => {
    await registerUser('eve', 'securepass');
    const login = await loginUser('Eve', 'securepass');
    expect(login.user.username).toBe('eve');
  });

  it('rejects wrong password', async () => {
    await registerUser('frank', 'correct1');
    await expect(loginUser('frank', 'wrong')).rejects.toThrow(
      'Invalid username or password'
    );
  });

  it('rejects non-existent user', async () => {
    await expect(loginUser('nobody', 'password1')).rejects.toThrow(
      'Invalid username or password'
    );
  });

  // --- verifyToken ---

  it('verifies a valid token and returns userId and username', async () => {
    const reg = await registerUser('grace', 'tokenpwd1');
    const payload = verifyToken(reg.token);

    expect(payload.userId).toBe(reg.user.id);
    expect(payload.username).toBe('grace');
  });

  it('rejects an invalid token', () => {
    expect(() => verifyToken('garbage.token.value')).toThrow(
      'Invalid or expired token'
    );
  });

  // --- getUserById ---

  it('finds a registered user by ID', async () => {
    const reg = await registerUser('hank', 'findme99');
    const user = getUserById(reg.user.id);

    expect(user).toBeDefined();
    expect(user!.username).toBe('hank');
    expect(user!.id).toBe(reg.user.id);
  });

  it('returns undefined for unknown user ID', () => {
    expect(getUserById('nonexistent-id')).toBeUndefined();
  });

  // --- getUserCount ---

  it('returns 0 when no users exist', () => {
    expect(getUserCount()).toBe(0);
  });

  it('returns correct count after registrations', async () => {
    await registerUser('count1', 'password1');
    await registerUser('count2', 'password2');
    expect(getUserCount()).toBe(2);
  });

  // --- getAllUsers ---

  it('returns users without passwordHash', async () => {
    await registerUser('secure1', 'password1', 'Secure One');
    const allUsers = getAllUsers();

    expect(allUsers).toHaveLength(1);
    expect(allUsers[0].username).toBe('secure1');
    expect(allUsers[0].displayName).toBe('Secure One');
    expect('passwordHash' in allUsers[0]).toBe(false);
  });

  // --- deleteUser ---

  it('deletes an existing user and returns true', async () => {
    const reg = await registerUser('toDelete', 'password1');
    expect(deleteUser(reg.user.id)).toBe(true);
    expect(getUserById(reg.user.id)).toBeUndefined();
    expect(getUserCount()).toBe(0);
  });

  it('returns false when deleting unknown user', () => {
    expect(deleteUser('no-such-id')).toBe(false);
  });

  // --- updateUserPassword ---

  it('updates password so login works with new password', async () => {
    const reg = await registerUser('pwdchange', 'oldpass1');
    const updated = await updateUserPassword(reg.user.id, 'newpass1');

    expect(updated).toBe(true);
    await expect(loginUser('pwdchange', 'oldpass1')).rejects.toThrow();
    const login = await loginUser('pwdchange', 'newpass1');
    expect(login.user.id).toBe(reg.user.id);
  });

  it('rejects password update shorter than 6 characters', async () => {
    const reg = await registerUser('shortpw', 'password1');
    await expect(updateUserPassword(reg.user.id, '12345')).rejects.toThrow(
      'Password must be at least 6 characters'
    );
  });

  it('returns false when updating password for unknown user', async () => {
    const result = await updateUserPassword('no-such-id', 'validpass1');
    expect(result).toBe(false);
  });
});
