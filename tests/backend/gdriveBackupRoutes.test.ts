import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { Router } from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-gdrive-routes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { registerGdriveBackupRoutes, VIEW_TTL_MS } from '../../server/routes/storageGdrive';
import { ARCHIVE_SETTINGS_COLUMNS } from '../../server/lib/archive/archiveColumns';
import { getGdriveBackupConfig, setGdriveBackupConfig, setGdriveConnection } from '../../server/lib/archive/gdrive/gdriveBackupConfig';
import { setGdriveFetchForTests } from '../../server/lib/archive/gdrive/driveAuth';
import { resetGdriveBackupStateForTests } from '../../server/lib/archive/gdrive/gdriveBackupRunner';
import { FakeGoogleDrive } from './helpers/fakeGoogleDrive';
import { updateSettingsData } from '../../server/lib/telescopes';

/**
 * The Google Drive backup routes, mounted on a plain router over real HTTP: the
 * setup flow the settings page follows (prepare the folder, save it, turn the backup
 * on), and the refusals that keep the switch and the adoption behind their own routes.
 */

let server: http.Server;
let baseUrl: string;
let drive: FakeGoogleDrive;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface RouteData {
  created?: boolean;
  folder?: { id: string; name: string };
  config: Record<string, unknown>;
  destination: { state: string };
  running?: boolean;
}
const data = (r: { json: Record<string, unknown> }) => r.json.data as RouteData;
const errorCode = (r: { json: Record<string, unknown> }) => (r.json.error as { code: string } | undefined)?.code;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = 'admin';
    next();
  });
  const router = Router();
  registerGdriveBackupRoutes(router);
  app.use('/storage', router);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  drive = new FakeGoogleDrive();
  setGdriveFetchForTests(drive.fetch);
});

afterEach(() => {
  setGdriveFetchForTests(null);
  resetGdriveBackupStateForTests();
  const sets = ARCHIVE_SETTINGS_COLUMNS.filter(c => c.name.startsWith('archiveGdrive')).map(c => `${c.name} = ${/ DEFAULT (.+)$/.exec(c.ddl)?.[1] ?? "''"}`);
  db.prepare(`UPDATE appSettings SET ${sets.join(', ')} WHERE id = 1`).run();
});

function signIn(): void {
  setGdriveBackupConfig({ clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'client-secret' });
  setGdriveConnection('refresh-token', 'astro@example.com');
}

describe('Google Drive backup routes', () => {
  it('walks the setup: prepare the folder, save it, turn on, turn off', async () => {
    signIn();
    const prepared = await call('POST', '/storage/gdrive-backup/folder');
    expect(prepared.status).toBe(200);
    expect(data(prepared)).toMatchObject({ created: true, folder: { name: 'Nebulis' } });
    const folder = data(prepared).folder!;

    const saved = await call('PUT', '/storage/gdrive-backup', { folderId: folder.id, folderPath: folder.name, includeSubframes: true });
    expect(saved.status).toBe(200);
    expect(data(saved).destination.state).toBe('absent');

    const on = await call('POST', '/storage/gdrive-backup/enable');
    expect(on.status).toBe(200);
    expect(data(on).config).toMatchObject({ enabled: true, includeSubframes: true });
    expect(data(on).destination.state).toBe('match');
    expect(drive.tree('Nebulis').has('.nebulisarchive')).toBe(true);

    const status = await call('GET', '/storage/gdrive-backup');
    expect(data(status)).toMatchObject({ running: false, config: { enabled: true, connected: true } });
    expect(JSON.stringify(status.json)).not.toContain('client-secret');

    const off = await call('POST', '/storage/gdrive-backup/disable');
    expect(data(off).config.enabled).toBe(false);
    // The adoption is kept: turning it back on does not need the marker rewritten.
    expect(getGdriveBackupConfig().archiveId).not.toBe('');
  });

  it('caches the folder view between polls, and shows the folder by its current name', async () => {
    signIn();
    const folder = data(await call('POST', '/storage/gdrive-backup/folder')).folder!;
    await call('PUT', '/storage/gdrive-backup', { folderId: folder.id, folderPath: folder.name });
    await call('POST', '/storage/gdrive-backup/enable');

    const first = data(await call('GET', '/storage/gdrive-backup')).destination as { state: string; path: string };
    // A name, not a path: no leading slash that would suggest the root of My Drive.
    expect(first).toMatchObject({ state: 'match', path: 'Google Drive: Nebulis (astro@example.com)' });

    // A second poll inside the cache's lifetime does not ask Drive again.
    const before = drive.requests;
    await call('GET', '/storage/gdrive-backup');
    expect(drive.requests).toBe(before);

    // Renamed in Drive: once the cache expires, the page shows the new name.
    drive.files.get(folder.id)!.name = 'Astro backup';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + VIEW_TTL_MS + 1_000);
      const later = data(await call('GET', '/storage/gdrive-backup')).destination as { state: string; path: string };
      expect(later).toMatchObject({ state: 'match', path: 'Google Drive: Astro backup (astro@example.com)' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('states the schedule: the time zone it runs in, where that comes from, and the next run', async () => {
    signIn();
    const folder = data(await call('POST', '/storage/gdrive-backup/folder')).folder!;
    await call('PUT', '/storage/gdrive-backup', { folderId: folder.id, folderPath: folder.name });
    await call('POST', '/storage/gdrive-backup/enable');
    type Schedule = { timeZone: string; timeZoneSource: string; nextRunAt: string | null };
    const scheduleOf = async () => (data(await call('GET', '/storage/gdrive-backup')) as unknown as { schedule: Schedule }).schedule;

    updateSettingsData({ timezone: '' });
    // Schedule off: no next run.
    expect(await scheduleOf()).toMatchObject({ timeZoneSource: 'server', nextRunAt: null });

    await call('PUT', '/storage/gdrive-backup', { scheduleEnabled: true, scheduleMode: 'custom', scheduleCron: '0 18 * * *' });
    const fromServer = await scheduleOf();
    expect(fromServer.timeZoneSource).toBe('server');
    expect(fromServer.nextRunAt).toMatch(/T\d{2}:00:00\.000Z$/);

    // With the site's zone, the schedule runs in it: 18:00 in Paris is 17:00 UTC in winter, 16:00 in summer.
    updateSettingsData({ timezone: 'Europe/Paris' });
    const fromSite = await scheduleOf();
    expect(fromSite).toMatchObject({ timeZone: 'Europe/Paris', timeZoneSource: 'site' });
    expect(fromSite.nextRunAt).toMatch(/T1[67]:00:00\.000Z$/);
    updateSettingsData({ timezone: '' });
  });

  it('keeps the switch, the adoption and the run record out of a settings save', async () => {
    for (const key of ['enabled', 'archiveId', 'lastRunAt', 'lastResult', 'lastAttemptAt']) {
      const r = await call('PUT', '/storage/gdrive-backup', { [key]: key === 'enabled' ? true : 'x' });
      expect(r.status, key).toBe(400);
      expect(errorCode(r)).toBe('GDRIVE_INVALID_CONFIG');
    }
    expect(errorCode(await call('PUT', '/storage/gdrive-backup', { scheduleHour: 99 }))).toBe('GDRIVE_INVALID_CONFIG');
    expect(getGdriveBackupConfig().enabled).toBe(false);
  });

  it('asks before taking over another install’s folder', async () => {
    signIn();
    const folder = drive.seed('root', 'Nebulis', '', 'application/vnd.google-apps.folder');
    drive.seed(folder.id, '.nebulisarchive', JSON.stringify({ archiveId: 'someone-else' }));
    await call('PUT', '/storage/gdrive-backup', { folderId: folder.id, folderPath: 'Nebulis' });

    const refused = await call('POST', '/storage/gdrive-backup/enable');
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('GDRIVE_FOREIGN_CONFIRMATION_REQUIRED');
    expect(getGdriveBackupConfig().enabled).toBe(false);

    const taken = await call('POST', '/storage/gdrive-backup/enable', { confirmArchiveId: 'someone-else' });
    expect(taken.status).toBe(200);
    expect(data(taken).config.enabled).toBe(true);
  });

  it('refuses to turn on without a folder, and to run while off', async () => {
    expect(errorCode(await call('POST', '/storage/gdrive-backup/enable'))).toBe('GDRIVE_NO_FOLDER');
    expect(errorCode(await call('POST', '/storage/gdrive-backup/run'))).toBe('GDRIVE_BACKUP_DISABLED');
    expect(errorCode(await call('POST', '/storage/gdrive-backup/run/cancel'))).toBe('GDRIVE_BACKUP_NOT_RUNNING');
  });

  it('says when the Drive API is off', async () => {
    signIn();
    drive.apiDisabled = true;
    const r = await call('POST', '/storage/gdrive-backup/folder');
    expect(r.status).toBe(409);
    expect(errorCode(r)).toBe('GDRIVE_API_DISABLED');
  });
});
