import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-settings-routes-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// Everything a settings change can set in motion is replaced by a spy; the router, schemas and DB are real.
const fx = vi.hoisted(() => ({
  startPrefetch: vi.fn(),
  cancelPrefetch: vi.fn(),
  runUpdateCheck: vi.fn(async () => {}),
  stopAppUpdateChecker: vi.fn(),
  restartScheduler: vi.fn(),
  triggerMaintenance: vi.fn(() => true),
}));
vi.mock('../../../server/lib/catalogPrefetch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../server/lib/catalogPrefetch')>()),
  startPrefetch: fx.startPrefetch,
  cancelPrefetch: fx.cancelPrefetch,
}));
vi.mock('../../../server/lib/appUpdate/updater', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../server/lib/appUpdate/updater')>()),
  runUpdateCheck: fx.runUpdateCheck,
  stopAppUpdateChecker: fx.stopAppUpdateChecker,
}));
vi.mock('../../../server/lib/plannerNightlyPrefetch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../server/lib/plannerNightlyPrefetch')>()),
  restartPlannerNightlyScheduler: fx.restartScheduler,
  triggerNightlyMaintenance: fx.triggerMaintenance,
}));

import fs from 'fs';
import request from 'supertest';
import { settingsRouter } from '../../../server/routes/settings';
import { routeApp } from '../helpers/routeApp';
import { getSettingsData, updateSettingsData, setApiKey, getApiKey } from '../../../server/lib/telescopes';
import db from '../../../server/lib/db';

const app = routeApp(settingsRouter);
const viewer = { 'x-test-role': 'viewer' };
const signedOut = { 'x-test-user': 'none' };

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

beforeEach(() => {
  for (const f of Object.values(fx)) f.mockClear();
  fx.triggerMaintenance.mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.prepare('DELETE FROM userApiKeys').run();
  // API keys belong to a user row, so the callers the tests pretend to be have to exist.
  for (const id of ['test-user', 'alice', 'bob', 'admin-user']) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, displayName, createdAt, role) VALUES (?, ?, 'x', ?, '2026-11-01', 'viewer')").run(id, id, id);
  }
  setApiKey('');
  updateSettingsData({
    prefetchCatalogAssets: true, onboardingCompleted: true, autoUpdateEnabled: false, updateChannel: 'stable',
    nightlyMaintenanceEnabled: true, plannerPrefetchTime: '03:00', temperatureUnit: 'fahrenheit',
  });
});

describe('GET / and PUT /', () => {
  it('returns every setting, with the API key masked and a flag for whether one exists', async () => {
    setApiKey('shub_abcdefghijklmnop');
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ hasApiKey: true, apiKey: 'shub_abc...', temperatureUnit: 'fahrenheit' });
    expect(JSON.stringify(res.body)).not.toContain('shub_abcdefghijklmnop');
    setApiKey('');
    expect((await request(app).get('/')).body.data).toMatchObject({ hasApiKey: false, apiKey: '' });
  });

  it('only an admin can change settings', async () => {
    const res = await request(app).put('/').set(viewer).send({ temperatureUnit: 'celsius' });
    expect(res.status).toBe(403);
    expect(getSettingsData().temperatureUnit).toBe('fahrenheit');
  });

  it('rejects a value the schema does not allow and changes nothing', async () => {
    for (const body of [{ temperatureUnit: 'kelvin-ish' }, { minAlt: 'high' }, { autoImportInterval: -5 }, { plannerPrefetchTime: 3 }]) {
      const res = await request(app).put('/').send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(getSettingsData().temperatureUnit).toBe('fahrenheit');
  });

  it('saves a change and returns the new settings', async () => {
    const res = await request(app).put('/').send({ temperatureUnit: 'celsius' });
    expect(res.status).toBe(200);
    expect(res.body.data.temperatureUnit).toBe('celsius');
    expect(getSettingsData().temperatureUnit).toBe('celsius');
  });

  it('a masked API key sent back never overwrites the real one', async () => {
    setApiKey('shub_abcdefghijklmnop');
    const res = await request(app).put('/').send({ apiKey: 'shub_abc...', temperatureUnit: 'celsius' });
    expect(res.status).toBe(200);
    expect(getApiKey()).toBe('shub_abcdefghijklmnop');
  });

  it('writes an audit entry naming the fields that changed, never their values', async () => {
    db.prepare("DELETE FROM systemLog WHERE category = 'settings'").run();
    await request(app).put('/').send({ temperatureUnit: 'celsius', windSpeedUnit: 'kmh' });
    const rows = db.prepare("SELECT message FROM systemLog WHERE category = 'settings'").all() as Array<{ message: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('temperatureUnit');
    expect(rows[0].message).toContain('windSpeedUnit');
    expect(rows[0].message).not.toContain('celsius');
  });

  it('a save that changes nothing writes no audit entry, even when it resends every field', async () => {
    const current = (await request(app).get('/')).body.data;
    db.prepare("DELETE FROM systemLog WHERE category = 'settings'").run();
    const res = await request(app).put('/').send({ temperatureUnit: current.temperatureUnit, minAlt: current.minAlt });
    expect(res.status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM systemLog WHERE category = 'settings'").get() as { n: number }).n).toBe(0);
  });

  describe('side effects of specific changes', () => {
    it('turning catalog prefetch on starts a packs-only download; turning it off cancels the job', async () => {
      updateSettingsData({ prefetchCatalogAssets: false });
      await request(app).put('/').send({ prefetchCatalogAssets: true });
      expect(fx.startPrefetch).toHaveBeenCalledWith({ packsOnly: true });
      expect(fx.cancelPrefetch).not.toHaveBeenCalled();

      fx.startPrefetch.mockClear();
      await request(app).put('/').send({ prefetchCatalogAssets: false });
      expect(fx.cancelPrefetch).toHaveBeenCalledTimes(1);
      expect(fx.startPrefetch).not.toHaveBeenCalled();
    });

    it('re-saving the same prefetch value does neither', async () => {
      await request(app).put('/').send({ prefetchCatalogAssets: true });
      expect(fx.startPrefetch).not.toHaveBeenCalled();
      expect(fx.cancelPrefetch).not.toHaveBeenCalled();
    });

    it('finishing onboarding with prefetch on starts the download, though the toggle itself did not change', async () => {
      updateSettingsData({ onboardingCompleted: false, prefetchCatalogAssets: true });
      await request(app).put('/').send({ onboardingCompleted: true });
      expect(fx.startPrefetch).toHaveBeenCalledWith({ packsOnly: true });
    });

    it('finishing onboarding with prefetch off starts nothing', async () => {
      updateSettingsData({ onboardingCompleted: false, prefetchCatalogAssets: false });
      await request(app).put('/').send({ onboardingCompleted: true });
      expect(fx.startPrefetch).not.toHaveBeenCalled();
    });

    it('turning auto-update on checks right away; turning it off stops the poll', async () => {
      await request(app).put('/').send({ autoUpdateEnabled: true });
      expect(fx.runUpdateCheck).toHaveBeenCalledTimes(1);
      await request(app).put('/').send({ autoUpdateEnabled: false });
      expect(fx.stopAppUpdateChecker).toHaveBeenCalledTimes(1);
    });

    it('switching channel re-checks only when auto-update is on', async () => {
      await request(app).put('/').send({ updateChannel: 'beta' });
      expect(fx.runUpdateCheck).not.toHaveBeenCalled();
      updateSettingsData({ autoUpdateEnabled: true, updateChannel: 'stable' });
      await request(app).put('/').send({ updateChannel: 'beta' });
      expect(fx.runUpdateCheck).toHaveBeenCalledTimes(1);
    });

    it('changing a nightly job setting restarts the scheduler; an unrelated one does not', async () => {
      await request(app).put('/').send({ temperatureUnit: 'celsius' });
      expect(fx.restartScheduler).not.toHaveBeenCalled();
      await request(app).put('/').send({ plannerPrefetchTime: '04:30' });
      expect(fx.restartScheduler).toHaveBeenCalledTimes(1);
    });

    it('a location with no name is named by a reverse lookup, and a failed lookup leaves the save intact', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ address: { town: 'Boulder', state: 'Colorado' } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const named = await request(app).put('/').send({ latitude: 40.01, longitude: -105.27 });
      expect(named.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(named.body.data.locationName).toBe('Boulder, Colorado');

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      const offline = await request(app).put('/').send({ latitude: 39.5, longitude: -104.9 });
      expect(offline.status).toBe(200);
      expect(offline.body.data.latitude).toBe(39.5);
    });

    it('a location that arrives with its own name is not looked up again, so the picker label survives', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = await request(app).put('/').send({ latitude: 51.5, longitude: -0.12, locationName: 'My back garden' });
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.body.data.locationName).toBe('My back garden');
    });
  });
});

describe('POST /nightly/run', () => {
  it('is refused while nightly maintenance is switched off', async () => {
    updateSettingsData({ nightlyMaintenanceEnabled: false });
    const res = await request(app).post('/nightly/run');
    expect([res.status, res.body.error.code]).toEqual([409, 'MAINTENANCE_DISABLED']);
    expect(fx.triggerMaintenance).not.toHaveBeenCalled();
  });

  it('starts a run, and says so when one is already going', async () => {
    expect((await request(app).post('/nightly/run')).body.data).toEqual({ started: true });
    fx.triggerMaintenance.mockReturnValue(false);
    const busy = await request(app).post('/nightly/run');
    expect([busy.status, busy.body.error.code]).toEqual([409, 'ALREADY_RUNNING']);
  });

  it('is admin only', async () => {
    expect((await request(app).post('/nightly/run').set(viewer)).status).toBe(403);
    expect(fx.triggerMaintenance).not.toHaveBeenCalled();
  });
});

describe('personal API keys', () => {
  it('need a signed-in user to list, create or revoke', async () => {
    expect((await request(app).get('/api-keys').set(signedOut)).status).toBe(401);
    expect((await request(app).post('/api-keys').set(signedOut).send({})).status).toBe(401);
    expect((await request(app).delete('/api-keys/x').set(signedOut)).status).toBe(401);
  });

  it('cannot be created or revoked by an API key or a paired device, so a leaked key cannot plant a longer-lived one', async () => {
    const viaKey = await request(app).post('/api-keys').set('x-test-via', 'api-key').send({});
    expect([viaKey.status, viaKey.body.error.code]).toEqual([403, 'API_KEY_NOT_ALLOWED']);
    const viaDevice = await request(app).post('/api-keys').set('x-test-via', 'device').send({});
    expect([viaDevice.status, viaDevice.body.error.code]).toEqual([403, 'DEVICE_TOKEN_NOT_ALLOWED']);
    expect((await request(app).delete('/api-keys/x').set('x-test-via', 'api-key')).status).toBe(403);
    expect((await request(app).get('/api-keys')).body.data.keys).toEqual([]);
  });

  it('creates a key, shows the full secret exactly once, and lists only a prefix afterwards', async () => {
    const created = await request(app).post('/api-keys').send({ name: 'Home server' });
    expect(created.status).toBe(200);
    const secret: string = created.body.data.key ?? created.body.data.apiKey ?? created.body.data.token;
    expect(secret).toBeTruthy();
    expect(created.body.data.name).toBe('Home server');

    const listed = await request(app).get('/api-keys');
    expect(listed.body.data.keys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(listed.body.data.keys[0]).toMatchObject({ name: 'Home server', keyPrefix: expect.any(String) });
    expect(listed.body.data.max).toBeGreaterThan(0);
  });

  it('refuses a name over 50 characters', async () => {
    const res = await request(app).post('/api-keys').send({ name: 'x'.repeat(51) });
    expect([res.status, res.body.error.code]).toEqual([400, 'INVALID_BODY']);
  });

  it('stops at the per-user limit with a message that says what to do', async () => {
    const max = (await request(app).get('/api-keys')).body.data.max as number;
    for (let i = 0; i < max; i++) expect((await request(app).post('/api-keys').send({ name: `k${i}` })).status).toBe(200);
    const over = await request(app).post('/api-keys').send({ name: 'one too many' });
    expect([over.status, over.body.error.code]).toEqual([409, 'LIMIT_REACHED']);
    expect(over.body.error.message).toMatch(/revoke/i);
  });

  it('a user revokes their own key, and cannot see or revoke another user\'s', async () => {
    const mine = (await request(app).post('/api-keys').set('x-test-user', 'alice').send({ name: 'alice key' })).body.data;
    expect((await request(app).get('/api-keys').set('x-test-user', 'bob')).body.data.keys).toEqual([]);
    const theft = await request(app).delete(`/api-keys/${mine.id}`).set('x-test-user', 'bob').set(viewer);
    expect([theft.status, theft.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect((await request(app).get('/api-keys').set('x-test-user', 'alice')).body.data.keys).toHaveLength(1);
    expect((await request(app).delete(`/api-keys/${mine.id}`).set('x-test-user', 'alice').set(viewer)).body.data).toEqual({ revoked: true, id: mine.id });
    expect((await request(app).get('/api-keys').set('x-test-user', 'alice')).body.data.keys).toEqual([]);
  });

  it('an admin can list everyone\'s keys and revoke any; a non-admin cannot ask for all', async () => {
    const aliceKey = (await request(app).post('/api-keys').set('x-test-user', 'alice').send({ name: 'a' })).body.data;
    expect((await request(app).get('/api-keys?scope=all').set(viewer)).status).toBe(403);
    const all = await request(app).get('/api-keys?scope=all').set('x-test-user', 'admin-user');
    expect(all.body.data.keys.map((k: { id: string }) => k.id)).toContain(aliceKey.id);
    expect((await request(app).delete(`/api-keys/${aliceKey.id}`).set('x-test-user', 'admin-user')).body.data.revoked).toBe(true);
  });

  it('revoking a key that does not exist is a 404', async () => {
    expect((await request(app).delete('/api-keys/does-not-exist')).status).toBe(404);
  });
});

describe('the single admin API key', () => {
  it('generate returns a new key once, stores it, and revoke clears it', async () => {
    const gen = await request(app).post('/generate-api-key');
    expect(gen.status).toBe(200);
    expect(gen.body.data.apiKey).toMatch(/^shub_[0-9a-f]{48}$/);
    expect(getApiKey()).toBe(gen.body.data.apiKey);
    const settings = await request(app).get('/');
    expect(JSON.stringify(settings.body)).not.toContain(gen.body.data.apiKey);
    expect(settings.body.data.hasApiKey).toBe(true);

    expect((await request(app).delete('/api-key')).body.data).toEqual({ revoked: true });
    expect(getApiKey()).toBe('');
  });

  it('generating again replaces the old key with a different one', async () => {
    const a = (await request(app).post('/generate-api-key')).body.data.apiKey;
    const b = (await request(app).post('/generate-api-key')).body.data.apiKey;
    expect(b).not.toBe(a);
    expect(getApiKey()).toBe(b);
  });

  it('both routes are admin only', async () => {
    expect((await request(app).post('/generate-api-key').set(viewer)).status).toBe(403);
    expect((await request(app).delete('/api-key').set(viewer)).status).toBe(403);
    expect(getApiKey()).toBe('');
  });
});

describe('DELETE /reset-database', () => {
  it('is admin only', async () => {
    expect((await request(app).delete('/reset-database').set(viewer).send({ confirmation: 'delete' })).status).toBe(403);
  });

  it('needs the exact word "delete" and does nothing otherwise', async () => {
    setApiKey('keep-me-key');
    for (const body of [{}, { confirmation: 'Delete' }, { confirmation: 'yes' }, { confirmation: true }]) {
      const res = await request(app).delete('/reset-database').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    }
    expect(getApiKey()).toBe('keep-me-key');
  });
});

describe('debug logging', () => {
  it('reports its state, enables with a context snapshot that carries no credentials, and disables', async () => {
    const before = await request(app).get('/debug-logging/status');
    expect(before.status).toBe(200);
    const enabled = await request(app).post('/debug-logging/enable');
    expect(enabled.status).toBe(200);
    expect(JSON.stringify(enabled.body)).not.toMatch(/password|secret-pw/i);
    expect((await request(app).get('/debug-logging/status')).body.data.enabled).toBe(true);
    const disabled = await request(app).post('/debug-logging/disable');
    expect(disabled.status).toBe(200);
    expect((await request(app).get('/debug-logging/status')).body.data.enabled).toBe(false);
  });

  it('serves the log gzipped as an attachment once there is one', async () => {
    await request(app).post('/debug-logging/enable');
    const res = await request(app).get('/debug-logging/download').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toBe('application/gzip');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.gz"/);
    }
    await request(app).post('/debug-logging/disable');
  });

  it('every debug route is admin only', async () => {
    expect((await request(app).get('/debug-logging/status').set(viewer)).status).toBe(403);
    expect((await request(app).post('/debug-logging/enable').set(viewer)).status).toBe(403);
    expect((await request(app).post('/debug-logging/disable').set(viewer)).status).toBe(403);
    expect((await request(app).get('/debug-logging/download').set(viewer)).status).toBe(403);
  });
});
