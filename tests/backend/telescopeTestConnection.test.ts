import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Mirrors telescopeObjectTraversal.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-testconn-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// Capture what the route hands the SMB client. The route imports smbListDir
// from '../lib/smb.js'; stub it so no real smbclient runs.
const smbListDirMock = vi.hoisted(() => vi.fn());
vi.mock('../../server/lib/smb.js', () => ({
  smbListDir: smbListDirMock,
}));

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { telescopesRouter } from '../../server/routes/telescopes';
import { createProfile, deleteProfile, getAllProfiles } from '../../server/lib/telescopes';
import { addTransport, getTransportsForProfile } from '../../server/lib/telescopeTransports';
import db from '../../server/lib/db';

const MASK = '••••••••';
let server: http.Server;
let baseUrl: string;

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
  app.use('/telescopes', telescopesRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  smbListDirMock.mockReset();
  smbListDirMock.mockResolvedValue([]);
  db.prepare('DELETE FROM telescopeTransports').run();
  for (const p of getAllProfiles()) {
    try { deleteProfile(p.id); } catch { /* last profile can't be deleted */ }
  }
});

function testConn(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/telescopes/test-connection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /telescopes/test-connection — password masking', () => {
  it('falls back to the stored transport password when the field holds the mask', async () => {
    const profile = createProfile({ name: 'NAS', hostname: '10.0.0.9', kind: 'other' });
    const transport = addTransport(profile.id, {
      kind: 'smb', hostname: '10.0.0.9', shareName: 'astro', username: 'root', password: 'realsecret',
    });

    const res = await testConn({
      kind: 'other', hostname: '10.0.0.9', shareName: 'astro', username: 'root',
      password: MASK, connectionType: 'smb',
      profileId: profile.id, transportId: transport.id,
    });
    expect(res.status).toBe(200);
    expect(smbListDirMock).toHaveBeenCalledTimes(1);
    const passedProfile = smbListDirMock.mock.calls[0][1] as { password: string };
    expect(passedProfile.password).toBe('realsecret');
  });

  it('never sends the literal mask string to the SMB client', async () => {
    // No transport ids: nothing to fall back to, so the mask becomes an empty
    // password rather than the bullet string.
    const res = await testConn({
      kind: 'other', hostname: '10.0.0.9', shareName: 'astro', username: 'root',
      password: MASK, connectionType: 'smb',
    });
    expect(res.status).toBe(200);
    const passedProfile = smbListDirMock.mock.calls[0][1] as { password: string };
    expect(passedProfile.password).toBe('');
    expect(passedProfile.password).not.toBe(MASK);
  });

  it('uses a freshly typed password verbatim', async () => {
    const profile = createProfile({ name: 'NAS', hostname: '10.0.0.9', kind: 'other' });
    const transport = addTransport(profile.id, {
      kind: 'smb', hostname: '10.0.0.9', shareName: 'astro', username: 'root', password: 'oldsecret',
    });

    await testConn({
      kind: 'other', hostname: '10.0.0.9', shareName: 'astro', username: 'root',
      password: 'brand-new-typed', connectionType: 'smb',
      profileId: profile.id, transportId: transport.id,
    });
    const passedProfile = smbListDirMock.mock.calls[0][1] as { password: string };
    expect(passedProfile.password).toBe('brand-new-typed');
  });

  it('ignores a transportId that belongs to a different profile', async () => {
    const a = createProfile({ name: 'A', hostname: '10.0.0.1', kind: 'other' });
    const b = createProfile({ name: 'B', hostname: '10.0.0.2', kind: 'other' });
    const tb = addTransport(b.id, {
      kind: 'smb', hostname: '10.0.0.2', shareName: 'astro', username: 'root', password: 'b-secret',
    });

    await testConn({
      kind: 'other', hostname: '10.0.0.1', shareName: 'astro', username: 'root',
      password: MASK, connectionType: 'smb',
      profileId: a.id, transportId: tb.id,
    });
    const passedProfile = smbListDirMock.mock.calls[0][1] as { password: string };
    expect(passedProfile.password).toBe('');
  });

  it('does not substitute the stored password when the request target differs (credential exfil guard)', async () => {
    const profile = createProfile({ name: 'NAS', hostname: '10.0.0.9', kind: 'other' });
    const transport = addTransport(profile.id, {
      kind: 'smb', hostname: '10.0.0.9', shareName: 'astro', username: 'root', password: 'realsecret',
    });

    // Correct ids, but hostname swapped for an attacker-controlled one.
    await testConn({
      kind: 'other', hostname: '10.9.9.9', shareName: 'astro', username: 'root',
      password: MASK, connectionType: 'smb',
      profileId: profile.id, transportId: transport.id,
    });
    let passed = smbListDirMock.mock.calls[0][1] as { password: string };
    expect(passed.password).toBe('');

    // Same for a swapped share name or username.
    smbListDirMock.mockClear();
    await testConn({
      kind: 'other', hostname: '10.0.0.9', shareName: 'other-share', username: 'root',
      password: MASK, connectionType: 'smb',
      profileId: profile.id, transportId: transport.id,
    });
    passed = smbListDirMock.mock.calls[0][1] as { password: string };
    expect(passed.password).toBe('');
  });
});

describe('POST /telescopes/:id/transports — password masking', () => {
  it('does not store the mask string as a real password', async () => {
    const profile = createProfile({ name: 'NAS', hostname: '10.0.0.9', kind: 'other' });
    const res = await fetch(`${baseUrl}/telescopes/${profile.id}/transports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'smb', hostname: '10.0.0.9', shareName: 'astro', username: 'root', password: MASK,
      }),
    });
    expect(res.status).toBe(200);
    const stored = getTransportsForProfile(profile.id).find(t => t.kind === 'smb');
    expect(stored?.password).toBe('');
  });
});
