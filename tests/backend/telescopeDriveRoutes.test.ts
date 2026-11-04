/**
 * The telescope routes that hand a USB drive to a telescope: creating one on a drive another telescope already owns,
 * probing a drive for its identity, and listing the host's drives.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-drive-routes-test-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

vi.mock('../../server/lib/driveEnumeration', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../server/lib/driveEnumeration')>();
  return { ...real, detectDrives: vi.fn(async () => []) };
});

import fs from 'fs';
import path from 'path';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { telescopesRouter } from '../../server/routes/telescopes';
import { createProfile, getAllProfiles, setProfileDeviceId } from '../../server/lib/telescopes';
import { resetDriveBindingScan } from '../../server/lib/driveBindings';

let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.userRole = req.header('x-test-role') === 'viewer' ? 'viewer' : 'admin';
    next();
  });
  app.use('/api/v1/telescopes', telescopesRouter);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/telescopes`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  fs.rmSync(H.dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM telescopeTransports').run();
  db.prepare('DELETE FROM telescopeProfiles').run();
  resetDriveBindingScan();
});

let n = 0;
function makeDrive(deviceId?: string): string {
  const dir = fs.mkdtempSync(path.join(H.dir, `drive-${++n}-`));
  fs.mkdirSync(path.join(dir, 'MyWorks'));
  if (deviceId) {
    fs.writeFileSync(path.join(dir, '.nebulis.dat'), JSON.stringify({ deviceId, createdAt: new Date().toISOString(), model: 'x', appVersion: '0' }));
  }
  return dir;
}

async function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } };
}

const usbBody = (name: string, localPath: string, extra: Record<string, unknown> = {}) => ({
  name, model: 'SeeStar S50', kind: 'seestar-s50', connectionType: 'local', localPath, ...extra,
});

function ownedDrive(ownerName: string, deviceId: string): string {
  const drive = makeDrive(deviceId);
  const owner = createProfile({ name: ownerName, kind: 'seestar-s30', hostname: '' });
  setProfileDeviceId(owner.id, deviceId);
  return drive;
}

describe('POST /telescopes on a USB drive', () => {
  it('refuses a drive another telescope owns, and creates no profile', async () => {
    const drive = ownedDrive('S30 Pro', 'id-s30');
    const before = getAllProfiles().length;

    const { status, body } = await post('', usbBody('S50 Pro', drive));

    expect(status).toBe(409);
    expect(body.error?.code).toBe('DRIVE_BELONGS_TO_OTHER');
    expect(body.error?.message).toContain('S30 Pro');
    expect(getAllProfiles()).toHaveLength(before);
  });

  it('pairs an unmarked drive with the new telescope', async () => {
    const drive = makeDrive();

    const { status, body } = await post('', usbBody('S50 Pro', drive));

    expect(status).toBe(200);
    expect(body.data?.pairing).toMatchObject({ status: 'paired', wrote: true });
    expect(fs.existsSync(path.join(drive, '.nebulis.dat'))).toBe(true);
  });

  it('does not check or mark the drive when identity tracking is off', async () => {
    const drive = ownedDrive('S30 Pro', 'id-s30');

    const { status, body } = await post('', usbBody('S50 Pro', drive, { trackDeviceIdentity: false }));

    expect(status).toBe(200);
    expect(body.data?.pairing).toMatchObject({ status: 'unmarked', reason: 'tracking-off' });
  });

  it('still creates a Wi-Fi telescope with no drive involved', async () => {
    const { status, body } = await post('', { name: 'S50 Pro', model: 'SeeStar S50', kind: 'seestar-s50', connectionType: 'smb', hostname: '192.168.1.50' });
    expect(status).toBe(200);
    expect(body.data?.pairing ?? null).toBeNull();
  });
});

describe('POST /telescopes/probe-identity', () => {
  const probe = (localPath: string, extra: Record<string, unknown> = {}) =>
    post('/probe-identity', { transport: { kind: 'local', localPath }, model: 'SeeStar S50', ...extra });

  it('marks an unmarked drive by default', async () => {
    const drive = makeDrive();
    const { body } = await probe(drive);
    expect(body.data?.wrote).toBe(true);
    expect(fs.existsSync(path.join(drive, '.nebulis.dat'))).toBe(true);
  });

  it('writes nothing when identity tracking is off', async () => {
    const drive = makeDrive();
    const { status, body } = await probe(drive, { trackDeviceIdentity: false });
    expect(status).toBe(200);
    expect(body.data?.wrote).toBe(false);
    expect(fs.existsSync(path.join(drive, '.nebulis.dat'))).toBe(false);
  });

  it('still reports the telescope that owns a marked drive when tracking is off', async () => {
    const drive = ownedDrive('S30 Pro', 'id-s30');
    const { body } = await probe(drive, { trackDeviceIdentity: false });
    expect(body.data).toMatchObject({ alreadyKnownProfileName: 'S30 Pro', wrote: false });
  });
});

describe('GET /telescopes/drives', () => {
  it('is for administrators only', async () => {
    const viewer = await fetch(`${base}/drives`, { headers: { 'x-test-role': 'viewer' } });
    expect(viewer.status).toBe(403);
    const admin = await fetch(`${base}/drives`);
    expect(admin.status).toBe(200);
  });
});
