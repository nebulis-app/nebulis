/**
 * Two fake Seestars on a REAL network share, through the server's real SMB layer (mount_smbfs on macOS, smbclient elsewhere): listing,
 * reading, marking each with its own `.nebulis.dat`, and noticing when one camera's address starts answering with another's storage.
 *
 * Opt-in, because it needs a real share. Skipped unless these are set:
 *   NEBULIS_TEST_SMB_HOST    the server, e.g. 192.168.1.12
 *   NEBULIS_TEST_SMB_SHARE   the share name, e.g. Nebulis-2
 *   NEBULIS_TEST_SMB_MOUNT   where that same share is mounted on this machine (used to build and remove the fixture folders)
 *   NEBULIS_TEST_SMB_USER    (default guest)     NEBULIS_TEST_SMB_PASSWORD   (default empty; not needed if the share is already mounted)
 *
 *   NEBULIS_TEST_SMB_HOST=192.168.1.12 NEBULIS_TEST_SMB_SHARE=Nebulis-2 NEBULIS_TEST_SMB_USER=brent \
 *   NEBULIS_TEST_SMB_MOUNT=/path/to/mount npx vitest run tests/backend/smbRealShare.test.ts
 *
 * Everything is created inside one new folder, `nebulis-test-<random>/`, at the top of the share, and only that folder is removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-smb-real-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import db from '../../server/lib/db';
import { smbListDir, smbGetFile } from '../../server/lib/smb';
import { readIdentity, writeIdentityIfMissing } from '../../server/lib/deviceIdentity';
import { createProfile, getProfileById, setProfileDeviceId } from '../../server/lib/telescopes';
import { judgeStorageIdentity } from '../../server/lib/driveBindings';
import { pickExistingMount, parseMountLine } from '../../server/lib/smb.mac';
import type { TelescopeTransport } from '../../server/lib/telescopeTransports';

const HOST = process.env.NEBULIS_TEST_SMB_HOST ?? '';
const SHARE = process.env.NEBULIS_TEST_SMB_SHARE ?? '';
const MOUNT = process.env.NEBULIS_TEST_SMB_MOUNT ?? '';
const USER = process.env.NEBULIS_TEST_SMB_USER ?? 'guest';
const PASSWORD = process.env.NEBULIS_TEST_SMB_PASSWORD ?? '';
const configured = !!(HOST && SHARE && MOUNT);

const testDir = `nebulis-test-${Math.random().toString(36).slice(2, 10)}`;
const profileFor = (who: 'A' | 'B') => ({ hostname: HOST, shareName: `${SHARE}/${testDir}/${who}`, username: USER, password: PASSWORD });
const transportFor = (who: 'A' | 'B'): TelescopeTransport => ({
  id: `t-${who}`, profileId: `p-${who}`, kind: 'smb', priority: 100, ...profileFor(who), localPath: '', lastSeenAt: null, createdAt: new Date().toISOString(),
});

afterAll(() => {
  // Only the folder this run created, and only if its name proves it.
  if (configured && testDir.startsWith('nebulis-test-')) fs.rmSync(path.join(MOUNT, testDir), { recursive: true, force: true });
  fs.rmSync(H.dir, { recursive: true, force: true });
});

describe.skipIf(!configured)('two fake Seestars on a real network share', { timeout: 120_000 }, () => {
  beforeAll(() => {
    db.prepare('DELETE FROM telescopeTransports').run();
    db.prepare('DELETE FROM telescopeProfiles').run();
    for (const [who, objects] of [['A', ['M 42', 'NGC 7000']], ['B', ['M 31', 'M 45']]] as const) {
      for (const object of objects) {
        const dir = path.join(MOUNT, testDir, who, 'MyWorks', object);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `Stacked_60_${object}_10.0s_IRCUT_20261026-213010A.jpg`), Buffer.alloc(4096, who === 'A' ? 7 : 9));
      }
    }
  });

  it('lists each Seestar\'s own objects and reads a picture back', async () => {
    const namesA = (await smbListDir('MyWorks', profileFor('A'))).map(e => e.name).sort();
    const namesB = (await smbListDir('MyWorks', profileFor('B'))).map(e => e.name).sort();
    expect(namesA).toEqual(['M 42', 'NGC 7000']);
    expect(namesB).toEqual(['M 31', 'M 45']);

    const [picture] = await smbListDir('MyWorks/M 42', profileFor('A'));
    const bytes = await smbGetFile(`MyWorks/M 42/${picture.name}`, undefined, profileFor('A'));
    expect(bytes.length).toBe(4096);
  });

  it('marks each Seestar with its own id, and reads it back', async () => {
    expect(await readIdentity(transportFor('A'))).toBeNull();
    const a = await writeIdentityIfMissing(transportFor('A'), { model: 'SeeStar S50' });
    const b = await writeIdentityIfMissing(transportFor('B'), { model: 'SeeStar S50' });
    expect(a).toMatchObject({ wrote: true, readonly: false });
    expect(b).toMatchObject({ wrote: true, readonly: false });
    expect(a.identity.deviceId).not.toBe(b.identity.deviceId);
    expect((await readIdentity(transportFor('A')))?.deviceId).toBe(a.identity.deviceId);
    expect((await readIdentity(transportFor('B')))?.deviceId).toBe(b.identity.deviceId);
  });

  it('flags a camera that answers at another camera\'s address, by name, and leaves a camera\'s own storage alone', async () => {
    const pa = createProfile({ name: 'Seestar A', kind: 'seestar-s50', hostname: HOST });
    const pb = createProfile({ name: 'Seestar B', kind: 'seestar-s50', hostname: HOST });
    const idA = (await readIdentity(transportFor('A')))!.deviceId;
    const idB = (await readIdentity(transportFor('B')))!.deviceId;
    setProfileDeviceId(pa.id, idA);
    setProfileDeviceId(pb.id, idB);

    // Profile B's import reaches A's storage, as if A had taken over B's address.
    expect(judgeStorageIdentity(getProfileById(pb.id)!, idA)).toMatchObject({ action: 'warn', reason: 'other-telescope', ownerName: 'Seestar A' });
    expect(judgeStorageIdentity(getProfileById(pa.id)!, idA)).toEqual({ action: 'keep' });
  });

  it.skipIf(process.platform !== 'darwin')('adopts the mount macOS already has for this share, and turns it down for a different camera', async () => {
    const rows = execFileSync('mount').toString().split('\n').map(parseMountLine).filter((r): r is NonNullable<typeof r> => r !== null)
      .filter(r => r.share.toLowerCase() === SHARE.toLowerCase());
    expect(rows.length).toBeGreaterThan(0);
    const mine = rows.filter(r => r.user === USER);
    expect(await pickExistingMount(mine, HOST)).toBe(mine[0].mountPoint);
    expect(await pickExistingMount(rows, '192.0.2.99')).toBeNull(); // TEST-NET-1: provably not this server
  });
});
