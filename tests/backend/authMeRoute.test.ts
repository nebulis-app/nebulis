import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { authRouter } from '../../server/routes/auth';
import { registerUser, updateUserPassword } from '../../server/lib/auth';
import db from '../../server/lib/db';

// /auth/me used to only verify the JWT signature/expiry — a token issued
// before a password change (which bumps tokenVersion) still passed this
// "is my session valid?" probe, unlike every other authenticated route,
// which goes through middleware/auth.ts's tokenVersion check. Mounts the
// real router (plain express + http + fetch, mirroring routeDecoding.test.ts)
// so this exercises the actual route wiring, not just the underlying
// verifyToken()/getUserTokenVersion() functions in isolation.
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use('/', authRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  db.prepare('DELETE FROM users').run();
});

async function getMe(token: string) {
  const res = await fetch(`${baseUrl}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() as { ok: boolean; data: unknown; error?: { code: string } } };
}

describe('GET /auth/me', () => {
  it('accepts a freshly issued token', async () => {
    const { token } = await registerUser('meuser', 'password123');
    const { status, body } = await getMe(token);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('rejects a token issued before a password change (stale tokenVersion)', async () => {
    const { token, user } = await registerUser('staleuser', 'password123');
    // Bumps tokenVersion in the DB; the already-issued token still carries the old one.
    await updateUserPassword(user.id, 'newpassword456');

    const { status, body } = await getMe(token);
    expect(status).toBe(401);
    expect(body.error?.code).toBe('SESSION_INVALIDATED');
  });

  it('rejects a request with no token', async () => {
    const res = await fetch(`${baseUrl}/me`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: { code: string } };
    expect(body.error?.code).toBe('NO_TOKEN');
  });
});
