import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { authRouter } from '../../server/routes/auth';
import { registerUser } from '../../server/lib/auth';
import db from '../../server/lib/db';

// The login limiter counts failures per source IP. A successful sign-in used to wipe that count, so anyone with
// one valid account (a family member's viewer login) could reset it between guesses at the admin password and
// never reach the lockout. Mounts the real router, same as authMeRoute.test.ts.
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  db.prepare('DELETE FROM users').run();
  await registerUser('lockadmin', 'correct-admin-pw');
  await registerUser('lockviewer', 'correct-viewer-pw', undefined, undefined, 'viewer');

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use('/', authRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.prepare('DELETE FROM users').run();
});

const login = (username: string, password: string) =>
  fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

describe('POST /auth/login lockout', () => {
  it('is not reset by a successful sign-in to a different account', async () => {
    for (let i = 0; i < 9; i++) {
      expect((await login('lockadmin', `wrong-guess-${i}`)).status).toBe(401);
    }
    // The attacker signs into their own account between guesses.
    expect((await login('lockviewer', 'correct-viewer-pw')).status).toBe(200);

    // The tenth failure still counts, so the lockout applies.
    expect((await login('lockadmin', 'wrong-guess-9')).status).toBe(401);
    const blocked = await login('lockadmin', 'correct-admin-pw');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  }, 60_000);
});
