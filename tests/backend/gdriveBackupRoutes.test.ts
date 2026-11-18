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
import { registerGdriveBackupRoutes } from '../../server/routes/storageGdrive';
import { ARCHIVE_SETTINGS_COLUMNS } from '../../server/lib/archive/archiveColumns';
import { getGdriveBackupConfig, setGdriveBackupConfig, setGdriveConnection } from '../../server/lib/archive/gdrive/gdriveBackupConfig';
import { setGdriveFetchForTests } from '../../server/lib/archive/gdrive/driveAuth';
import { resetGdriveBackupStateForTests } from '../../server/lib/archive/gdrive/gdriveBackupRunner';
import { FakeGoogleDrive } from './helpers/fakeGoogleDrive';

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

  it('keeps the switch, the adoption and the run record out of a settings save', async () => {
    for (const key of ['enabled', 'archiveId', 'lastRunAt', 'lastResult']) {
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
