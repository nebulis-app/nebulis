import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { createHash } from 'crypto';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { apiAuth, requireAdmin } from '../../server/middleware/auth';
import { settingsRouter } from '../../server/routes/settings';
import {
  registerUser, deleteUser, updateUserRole, createApiKeyForUser, verifyApiKey, MAX_API_KEYS_PER_USER,
} from '../../server/lib/auth';
import db from '../../server/lib/db';
import { setApiKey } from '../../server/lib/telescopes';

// Personal API keys: they act as their owner with the owner's current role, and
// must never be a way to escalate (the PR this feature came from let any viewer
// mint an admin credential through the legacy global-key route).
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use(apiAuth);
  app.use('/settings', settingsRouter);
  app.get('/whoami', (req, res) => { res.apiSuccess({ userId: req.userId, role: req.userRole, viaApiKey: req.viaApiKey === true }); });
  app.get('/admin-only', requireAdmin, (_req, res) => { res.apiSuccess({ ok: true }); });
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

let admin: { token: string; id: string };
let viewer: { token: string; id: string };

beforeEach(async () => {
  db.prepare('DELETE FROM userApiKeys').run();
  db.prepare('DELETE FROM users').run();
  setApiKey('');
  const a = await registerUser('adminuser', 'password123');
  admin = { token: a.token, id: a.user.id };
  const v = await registerUser('vieweruser', 'password123', undefined, undefined, 'viewer');
  viewer = { token: v.token, id: v.user.id };
});

type Body = { ok: boolean; data: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, auth?: { bearer?: string; xApiKey?: string }, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth?.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  if (auth?.xApiKey) headers['X-API-Key'] = auth.xApiKey;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Body };
}
const createKey = async (token: string, name = 'PixInsight') =>
  (await call('POST', '/settings/api-keys', { bearer: token }, { name })).body.data as { id: string; apiKey: string; keyPrefix: string; name: string };

describe('personal API keys: lifecycle', () => {
  it('creates a neb- key, shows the secret once and stores only its hash', async () => {
    const created = await createKey(admin.token);
    expect(created.apiKey).toMatch(/^neb-[0-9a-f]{48}$/);
    const row = db.prepare('SELECT keyHash FROM userApiKeys WHERE id = ?').get(created.id) as { keyHash: string };
    expect(row.keyHash).toBe(createHash('sha256').update(created.apiKey).digest('hex'));
    const list = (await call('GET', '/settings/api-keys', { bearer: admin.token })).body.data.keys;
    expect(JSON.stringify(list)).not.toContain(created.apiKey);
    expect(list[0].keyPrefix).toBe(created.keyPrefix);
  });

  it('authenticates as the owner via X-API-Key and via Bearer', async () => {
    const { apiKey } = await createKey(admin.token);
    for (const auth of [{ xApiKey: apiKey }, { bearer: apiKey }]) {
      const { status, body } = await call('GET', '/whoami', auth);
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ userId: admin.id, role: 'admin', viaApiKey: true });
    }
  });

  it('stamps lastUsedAt', async () => {
    const { id, apiKey } = await createKey(admin.token);
    expect((db.prepare('SELECT lastUsedAt FROM userApiKeys WHERE id = ?').get(id) as { lastUsedAt: number | null }).lastUsedAt).toBeNull();
    await call('GET', '/whoami', { xApiKey: apiKey });
    expect((db.prepare('SELECT lastUsedAt FROM userApiKeys WHERE id = ?').get(id) as { lastUsedAt: number | null }).lastUsedAt).not.toBeNull();
  });

  it('a revoked key stops working immediately', async () => {
    const { id, apiKey } = await createKey(admin.token);
    expect((await call('DELETE', `/settings/api-keys/${id}`, { bearer: admin.token })).status).toBe(200);
    expect((await call('GET', '/whoami', { xApiKey: apiKey })).status).toBe(401);
    expect(verifyApiKey(apiKey)).toBeNull();
  });

  it(`caps a user at ${MAX_API_KEYS_PER_USER} keys, at the route and in the library`, async () => {
    for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) await createKey(admin.token, `k${i}`);
    const over = await call('POST', '/settings/api-keys', { bearer: admin.token }, { name: 'one too many' });
    expect(over.status).toBe(409);
    expect(over.body.error?.code).toBe('LIMIT_REACHED');
    expect(() => createApiKeyForUser(admin.id, 'direct')).toThrow(/Limit/);
    // The other user's quota is separate.
    expect((await call('POST', '/settings/api-keys', { bearer: viewer.token }, {})).status).toBe(200);
  });

  it('rejects unknown, empty and non-neb keys', async () => {
    expect(verifyApiKey('neb-' + '0'.repeat(48))).toBeNull();
    expect(verifyApiKey('')).toBeNull();
    expect(verifyApiKey('shub_whatever')).toBeNull();
  });

  it('deleting the user kills their keys', async () => {
    const { apiKey } = await createKey(viewer.token);
    deleteUser(viewer.id);
    expect((await call('GET', '/whoami', { xApiKey: apiKey })).status).toBe(401);
    expect((db.prepare('SELECT COUNT(*) c FROM userApiKeys WHERE userId = ?').get(viewer.id) as { c: number }).c).toBe(0);
  });
});

describe('personal API keys: no escalation', () => {
  it('a viewer key is a viewer: admin routes answer 403', async () => {
    const { apiKey } = await createKey(viewer.token);
    expect((await call('GET', '/whoami', { xApiKey: apiKey })).body.data.role).toBe('viewer');
    expect((await call('GET', '/admin-only', { xApiKey: apiKey })).status).toBe(403);
  });

  it('a viewer cannot use the legacy global-key routes to mint an admin credential', async () => {
    expect((await call('POST', '/settings/generate-api-key', { bearer: viewer.token })).status).toBe(403);
    expect((await call('DELETE', '/settings/api-key', { bearer: viewer.token })).status).toBe(403);
    const { apiKey } = await createKey(viewer.token);
    expect((await call('POST', '/settings/generate-api-key', { xApiKey: apiKey })).status).toBe(403);
  });

  it('a key follows its owner\'s current role (demotion applies at once)', async () => {
    const { apiKey } = await createKey(admin.token);
    expect((await call('GET', '/admin-only', { xApiKey: apiKey })).status).toBe(200);
    updateUserRole(admin.id, 'viewer');
    expect((await call('GET', '/admin-only', { xApiKey: apiKey })).status).toBe(403);
  });

  it('a key cannot create or revoke keys', async () => {
    const { id, apiKey } = await createKey(admin.token);
    const create = await call('POST', '/settings/api-keys', { xApiKey: apiKey }, {});
    expect(create.status).toBe(403);
    expect(create.body.error?.code).toBe('API_KEY_NOT_ALLOWED');
    expect((await call('DELETE', `/settings/api-keys/${id}`, { xApiKey: apiKey })).status).toBe(403);
  });

  it('the legacy global key still works exactly as before (admin, no user)', async () => {
    setApiKey('shub_legacy_key_value');
    const { status, body } = await call('GET', '/whoami', { xApiKey: 'shub_legacy_key_value' });
    expect(status).toBe(200);
    expect(body.data.role).toBe('admin');
    expect(body.data.userId).toBeUndefined();
  });
});

describe('personal API keys: ownership', () => {
  it("a user cannot revoke someone else's key; an admin can", async () => {
    const mine = await createKey(admin.token);
    const theirs = await createKey(viewer.token);
    expect((await call('DELETE', `/settings/api-keys/${mine.id}`, { bearer: viewer.token })).status).toBe(404);
    expect((await call('DELETE', `/settings/api-keys/${theirs.id}`, { bearer: admin.token })).status).toBe(200);
    expect((await call('GET', '/whoami', { xApiKey: theirs.apiKey })).status).toBe(401);
  });

  it('scope=all is admin-only and includes owners', async () => {
    await createKey(admin.token, 'a');
    await createKey(viewer.token, 'v');
    expect((await call('GET', '/settings/api-keys?scope=all', { bearer: viewer.token })).status).toBe(403);
    const all = (await call('GET', '/settings/api-keys?scope=all', { bearer: admin.token })).body.data.keys as Array<{ ownerUsername: string }>;
    expect(all.map(k => k.ownerUsername).sort()).toEqual(['adminuser', 'vieweruser']);
  });

  it('lists only the caller\'s own keys by default', async () => {
    await createKey(admin.token);
    await createKey(viewer.token);
    const mine = (await call('GET', '/settings/api-keys', { bearer: viewer.token })).body.data.keys as Array<{ userId: string }>;
    expect(mine).toHaveLength(1);
    expect(mine[0].userId).toBe(viewer.id);
  });
});
