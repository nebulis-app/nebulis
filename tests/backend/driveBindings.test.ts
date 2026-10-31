/**
 * Two telescopes of one model, both plugged in over USB. The OS mounts them wherever it likes, so a USB path saved as a
 * plain folder is not an identity. These cover telling the drives apart by the ID written on each one: following a
 * drive that moved, refusing one that belongs to a different telescope, and pairing a drive when it is picked.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Own DATA_DIR: the modules prepare statements against the database at load.
const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-bindings-test-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

// Which drives are "mounted" is the one thing the tests decide; reading the ID off each drive stays real.
vi.mock('../../server/lib/driveEnumeration', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../server/lib/driveEnumeration')>();
  return { ...real, detectDrives: vi.fn(async () => []) };
});

import fs from 'fs';
import path from 'path';
import db from '../../server/lib/db';
import { detectDrives, type DetectedDrive } from '../../server/lib/driveEnumeration';
import { createProfile, getProfileById, setProfileDeviceId, type TelescopeProfile } from '../../server/lib/telescopes';
import { addTransport, selectActiveTransport, invalidateActiveTransportCache } from '../../server/lib/telescopeTransports';
import {
  refreshDriveBindings, prepareActiveTransport, bindProfileToDrive, checkDriveMatchesProfile, checkDriveForNewProfile,
  judgeStorageIdentity, resetDriveBindingScan,
} from '../../server/lib/driveBindings';

afterAll(() => fs.rmSync(H.dir, { recursive: true, force: true }));

let n = 0;
/** A folder that looks like a Seestar's storage, optionally already marked with a device ID. */
function makeDrive(deviceId?: string): string {
  const dir = fs.mkdtempSync(path.join(H.dir, `drive-${++n}-`));
  fs.mkdirSync(path.join(dir, 'MyWorks'));
  if (deviceId) {
    fs.writeFileSync(path.join(dir, '.nebulis.dat'), JSON.stringify({ deviceId, createdAt: new Date().toISOString(), model: 'x', appVersion: '0' }));
  }
  return dir;
}

function detected(mountPath: string, deviceId: string | null): DetectedDrive {
  return {
    mountPath, volumeName: path.basename(mountPath), looksLikeSeestar: true, looksLikeDwarf: false, looksLikeAsiair: false,
    alreadyKnownDeviceId: deviceId, alreadyKnownProfileId: null, alreadyKnownProfileName: null,
    totalBytes: 0, freeBytes: 0, writable: true,
  };
}

function mount(...drives: DetectedDrive[]) {
  vi.mocked(detectDrives).mockResolvedValue(drives);
}

/** A telescope with one USB connection and, optionally, an ID already paired to it. */
function telescope(name: string, usbPath: string, deviceId?: string, kind: 'seestar-s50' | 'seestar-s30' = 'seestar-s50'): TelescopeProfile {
  const profile = createProfile({ name, kind, hostname: '' });
  db.prepare('DELETE FROM telescopeTransports WHERE profileId = ?').run(profile.id);
  addTransport(profile.id, { kind: 'local', localPath: usbPath });
  if (deviceId) setProfileDeviceId(profile.id, deviceId);
  invalidateActiveTransportCache(profile.id);
  return getProfileById(profile.id)!;
}

beforeEach(() => {
  db.prepare('DELETE FROM telescopeTransports').run();
  db.prepare('DELETE FROM telescopeProfiles').run();
  invalidateActiveTransportCache();
  resetDriveBindingScan();
  mount();
});

describe('following a drive that moved', () => {
  it('sends each telescope to its own drive when the OS swapped where they mounted', async () => {
    const s50Drive = makeDrive('id-s50');
    const s30Drive = makeDrive('id-s30');
    // Each telescope's saved path now holds the other one's drive.
    const s50 = telescope('S50 Pro', s30Drive, 'id-s50');
    const s30 = telescope('S30 Pro', s50Drive, 'id-s30', 'seestar-s30');
    mount(detected(s50Drive, 'id-s50'), detected(s30Drive, 'id-s30'));

    await refreshDriveBindings({ force: true });

    expect(selectActiveTransport(s50.id)?.localPath).toBe(s50Drive);
    expect(selectActiveTransport(s30.id)?.localPath).toBe(s30Drive);
  });

  it('leaves a telescope alone when its drive is already at the saved path', async () => {
    const drive = makeDrive('id-a');
    const a = telescope('A', drive, 'id-a');
    mount(detected(drive, 'id-a'));
    await refreshDriveBindings({ force: true });
    expect(selectActiveTransport(a.id)?.localPath).toBe(drive);
  });
});

describe('refusing another telescope\'s drive', () => {
  it('stops an import when the saved path holds a drive that belongs to a different telescope', async () => {
    const s30Drive = makeDrive('id-s30');
    telescope('S30 Pro', s30Drive, 'id-s30', 'seestar-s30');
    // The S50's own drive is not plugged in; the S30's is sitting at the S50's saved path.
    const s50 = telescope('S50 Pro', s30Drive, 'id-s50');
    mount(detected(s30Drive, 'id-s30'));

    const prepared = await prepareActiveTransport(s50);

    expect(prepared.transport).toBeNull();
    expect(prepared.error).toContain('belongs to S30 Pro');
    expect(prepared.error).toContain('S50 Pro');
  });

  it('refuses a telescope that is not paired yet when the drive is already paired to another', async () => {
    const s30Drive = makeDrive('id-s30');
    telescope('S30 Pro', s30Drive, 'id-s30', 'seestar-s30');
    const fresh = telescope('Second Seestar', s30Drive);
    mount(detected(s30Drive, 'id-s30'));

    const prepared = await prepareActiveTransport(fresh);
    expect(prepared.error).toContain('belongs to S30 Pro');
  });

  it('uses the Wi-Fi connection instead when the USB drive is the wrong one', async () => {
    const s30Drive = makeDrive('id-s30');
    telescope('S30 Pro', s30Drive, 'id-s30', 'seestar-s30');
    const s50 = telescope('S50 Pro', s30Drive, 'id-s50');
    addTransport(s50.id, { kind: 'smb', hostname: '192.168.1.50' });
    invalidateActiveTransportCache(s50.id);
    mount(detected(s30Drive, 'id-s30'));

    const prepared = await prepareActiveTransport(s50);

    expect(prepared.error).toBeNull();
    expect(prepared.transport?.kind).toBe('smb');
  });

  it('checks the drive in front of it even when the scan is stale', async () => {
    const s30Drive = makeDrive('id-s30');
    telescope('S30 Pro', s30Drive, 'id-s30', 'seestar-s30');
    const s50 = telescope('S50 Pro', s30Drive, 'id-s50');
    const check = await checkDriveMatchesProfile(s50, s30Drive);
    expect(check.ok).toBe(false);
  });
});

describe('drives that cannot be told apart', () => {
  it('trusts a drive with no ID at its saved path, as before', async () => {
    const unmarked = makeDrive();
    const a = telescope('A', unmarked, 'id-a');
    mount(detected(unmarked, null));
    const prepared = await prepareActiveTransport(a);
    expect(prepared.error).toBeNull();
    expect(prepared.transport?.localPath).toBe(unmarked);
  });

  it('does nothing for a telescope that opted out of device identity', async () => {
    const s30Drive = makeDrive('id-s30');
    telescope('S30 Pro', s30Drive, 'id-s30', 'seestar-s30');
    const s50 = telescope('S50 Pro', s30Drive, 'id-s50');
    db.prepare('UPDATE telescopeProfiles SET trackDeviceIdentity = 0 WHERE id = ?').run(s50.id);
    mount(detected(s30Drive, 'id-s30'));
    const prepared = await prepareActiveTransport(getProfileById(s50.id)!);
    expect(prepared.error).toBeNull();
    expect(prepared.transport?.localPath).toBe(s30Drive);
  });
});

describe('what the ID on network storage says about the telescope', () => {
  const noId = () => createProfile({ name: 'S50', kind: 'seestar-s50', hostname: '192.168.1.5' });
  const withId = (name: string, id: string) => {
    const p = createProfile({ name, kind: 'seestar-s50', hostname: '192.168.1.6' });
    setProfileDeviceId(p.id, id);
    return getProfileById(p.id)!;
  };

  it('keeps going when the storage has no ID or this telescope\'s own', () => {
    const p = withId('S50', 'mine');
    expect(judgeStorageIdentity(p, null)).toEqual({ action: 'keep' });
    expect(judgeStorageIdentity(p, 'mine')).toEqual({ action: 'keep' });
  });

  it('lets a telescope with no ID take the one on storage nobody else owns', () => {
    expect(judgeStorageIdentity(noId(), 'fresh')).toEqual({ action: 'adopt', deviceId: 'fresh' });
  });

  it('does not let a telescope take an ID another telescope owns', () => {
    withId('S30', 'id-s30');
    expect(judgeStorageIdentity(noId(), 'id-s30')).toMatchObject({ action: 'warn', reason: 'other-telescope', ownerName: 'S30' });
  });

  it('warns, without refusing, when a paired telescope\'s storage carries another telescope\'s ID', () => {
    withId('S30', 'id-s30');
    expect(judgeStorageIdentity(withId('S50', 'mine'), 'id-s30')).toMatchObject({ action: 'warn', reason: 'other-telescope', ownerName: 'S30' });
  });

  it('warns about an ID nobody owns that differs from the telescope\'s, as a telescope first paired over USB can have', () => {
    expect(judgeStorageIdentity(withId('S50', 'mine'), 'left-by-old-import')).toMatchObject({ action: 'warn', reason: 'different-id', ownerName: null });
  });
});

describe('the transport an import would use, as drives come and go', () => {
  /** A telescope reachable over Wi-Fi and by USB at `usbPath`, which may not exist yet. */
  function dual(usbPath: string): TelescopeProfile {
    const profile = createProfile({ name: 'S50', kind: 'seestar-s50', hostname: '192.168.1.5' });
    addTransport(profile.id, { kind: 'local', localPath: usbPath, priority: 50 });
    invalidateActiveTransportCache(profile.id);
    return getProfileById(profile.id)!;
  }

  it('stops choosing a USB drive once it has been unplugged, without waiting out the cache', () => {
    const drive = makeDrive();
    const p = dual(drive);
    expect(selectActiveTransport(p.id)?.kind).toBe('local');
    fs.rmSync(drive, { recursive: true });
    expect(selectActiveTransport(p.id)?.kind).toBe('smb');
  });

  it('starts choosing a USB drive once the scan sees it plugged in', async () => {
    const drive = path.join(H.dir, `later-${++n}`);
    const p = dual(drive);
    expect(selectActiveTransport(p.id)?.kind).toBe('smb');

    fs.mkdirSync(path.join(drive, 'MyWorks'), { recursive: true });
    await refreshDriveBindings({ force: true });

    expect(selectActiveTransport(p.id)?.kind).toBe('local');
  });
});

describe('an ASIAIR stick, however the telescope points at it', () => {
  /** A volume root with the device's `ASIAir/` folder inside, optionally marked at the root the way the Mac marks it. */
  function stick(rootId?: string) {
    const root = fs.mkdtempSync(path.join(H.dir, `stick-${++n}-`));
    fs.mkdirSync(path.join(root, 'ASIAir', 'Autorun'), { recursive: true });
    if (rootId) fs.writeFileSync(path.join(root, '.nebulis.dat'), JSON.stringify({ deviceId: rootId, createdAt: new Date().toISOString(), model: 'asiair', appVersion: '0' }));
    return { root, sub: path.join(root, 'ASIAir') };
  }

  it('pairs a path inside ASIAir with the ID the Mac wrote at the root, without writing a second one', async () => {
    const { root, sub } = stick('mac-id');
    const asiair = telescope('ASIAIR', sub, undefined, 'seestar-s50');
    const result = await bindProfileToDrive(asiair, sub);
    expect(result).toMatchObject({ status: 'paired', deviceId: 'mac-id', wrote: false });
    expect(getProfileById(asiair.id)?.deviceId).toBe('mac-id');
    expect(fs.existsSync(path.join(sub, '.nebulis.dat'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.nebulis.dat'), 'utf8')).toContain('mac-id');
  });

  it('marks an unmarked stick at the root, from either path', async () => {
    const { root, sub } = stick();
    const asiair = telescope('ASIAIR', sub, undefined, 'seestar-s50');
    await bindProfileToDrive(asiair, sub);
    expect(fs.existsSync(path.join(root, '.nebulis.dat'))).toBe(true);
    expect(fs.existsSync(path.join(sub, '.nebulis.dat'))).toBe(false);
  });

  it('does not call the same stick a second drive when the telescope points at the volume and detection reports the folder', async () => {
    const { root, sub } = stick();
    const asiair = telescope('ASIAIR', root, 'id-asiair', 'seestar-s50');
    mount({ ...detected(root, 'id-asiair'), asiairSubPath: 'ASIAir' });
    expect(sub.startsWith(root)).toBe(true);
    const result = await bindProfileToDrive(asiair, root);
    expect(result).toMatchObject({ status: 'paired', deviceId: 'id-asiair' });
  });

  it('recognises the stick as the telescope\'s own whichever way its path was saved', async () => {
    const { root, sub } = stick('asiair-id');
    const asiair = telescope('ASIAIR', sub, 'asiair-id', 'seestar-s50');
    expect(await checkDriveMatchesProfile(asiair, sub)).toEqual({ ok: true });
    expect(await checkDriveMatchesProfile(asiair, root)).toEqual({ ok: true });
    const other = telescope('Other', makeDrive(), 'other-id', 'seestar-s30');
    expect(await checkDriveMatchesProfile(other, sub)).toMatchObject({ ok: false });
  });
});

describe('a drive offered to a telescope that does not exist yet', () => {
  it('is refused when it already belongs to another telescope', async () => {
    const drive = makeDrive('id-s30');
    telescope('S30 Pro', drive, 'id-s30', 'seestar-s30');

    expect(await checkDriveForNewProfile(drive)).toMatchObject({ status: 'conflict', reason: 'other-telescope', ownerName: 'S30 Pro' });
    expect(fs.readFileSync(path.join(drive, '.nebulis.dat'), 'utf8')).toContain('id-s30');
  });

  it('passes an unmarked drive and writes nothing to it', async () => {
    const drive = makeDrive();
    expect(await checkDriveForNewProfile(drive)).toBeNull();
    expect(fs.existsSync(path.join(drive, '.nebulis.dat'))).toBe(false);
  });

  it('passes a drive whose ID no telescope owns, and a path that is not there', async () => {
    expect(await checkDriveForNewProfile(makeDrive('id-nobody'))).toBeNull();
    expect(await checkDriveForNewProfile(path.join(H.dir, 'not-mounted'))).toBeNull();
    expect(await checkDriveForNewProfile('')).toBeNull();
  });
});

describe('pairing a drive with a telescope', () => {
  it('marks an unmarked drive with the telescope\'s ID, so every later plug-in is recognised', async () => {
    const drive = makeDrive();
    const s50 = telescope('S50 Pro', drive);

    const result = await bindProfileToDrive(s50, drive);

    expect(result.status).toBe('paired');
    const onDrive = JSON.parse(fs.readFileSync(path.join(drive, '.nebulis.dat'), 'utf8')) as { deviceId: string };
    expect(getProfileById(s50.id)?.deviceId).toBe(onDrive.deviceId);
  });

  it('puts the telescope\'s existing ID on a new drive instead of inventing a second one', async () => {
    const drive = makeDrive();
    const s50 = telescope('S50 Pro', drive, 'id-from-wifi');
    await bindProfileToDrive(s50, drive);
    const onDrive = JSON.parse(fs.readFileSync(path.join(drive, '.nebulis.dat'), 'utf8')) as { deviceId: string };
    expect(onDrive.deviceId).toBe('id-from-wifi');
  });

  it('keeps two telescopes apart when both are paired one after the other', async () => {
    const driveA = makeDrive();
    const driveB = makeDrive();
    const a = telescope('S50 Pro', driveA);
    const b = telescope('S30 Pro', driveB, undefined, 'seestar-s30');
    await bindProfileToDrive(a, driveA);
    await bindProfileToDrive(b, driveB);
    expect(getProfileById(a.id)?.deviceId).not.toBe(getProfileById(b.id)?.deviceId);
  });

  it('refuses a drive that already belongs to another telescope, and changes nothing', async () => {
    const drive = makeDrive('id-s30');
    telescope('S30 Pro', drive, 'id-s30', 'seestar-s30');
    const s50 = telescope('S50 Pro', drive);

    const result = await bindProfileToDrive(s50, drive);

    expect(result).toMatchObject({ status: 'conflict', reason: 'other-telescope', ownerName: 'S30 Pro' });
    expect(getProfileById(s50.id)?.deviceId).toBeNull();
  });

  it('will not put one telescope\'s ID on a second drive while the first is still plugged in', async () => {
    const first = makeDrive('id-s50');
    const second = makeDrive();
    const s50 = telescope('S50 Pro', second, 'id-s50');
    mount(detected(first, 'id-s50'), detected(second, null));

    const result = await bindProfileToDrive(s50, second);

    expect(result).toMatchObject({ status: 'conflict', reason: 'telescope-paired-elsewhere', otherPath: first });
    expect(fs.existsSync(path.join(second, '.nebulis.dat'))).toBe(false);
  });

  it('pairs the new drive with a fresh ID when the person confirms they swapped it', async () => {
    const first = makeDrive('id-s50');
    const second = makeDrive();
    const s50 = telescope('S50 Pro', second, 'id-s50');
    mount(detected(first, 'id-s50'), detected(second, null));

    const result = await bindProfileToDrive(s50, second, { replace: true });

    expect(result.status).toBe('paired');
    const onDrive = JSON.parse(fs.readFileSync(path.join(second, '.nebulis.dat'), 'utf8')) as { deviceId: string };
    expect(onDrive.deviceId).not.toBe('id-s50');
    expect(getProfileById(s50.id)?.deviceId).toBe(onDrive.deviceId);
  });

  it('says so when the drive cannot be written to, and keeps the saved path as the identity', async () => {
    const drive = makeDrive();
    // A directory where the file would go makes the write fail whatever the user running the tests may do.
    fs.mkdirSync(path.join(drive, '.nebulis.dat'));
    const s50 = telescope('S50 Pro', drive);

    const result = await bindProfileToDrive(s50, drive);

    expect(result).toEqual({ status: 'unmarked', reason: 'read-only' });
    expect(getProfileById(s50.id)?.deviceId).toBeNull();
  });

  it('does not pair a telescope that opted out of device identity', async () => {
    const drive = makeDrive();
    const s50 = telescope('S50 Pro', drive);
    db.prepare('UPDATE telescopeProfiles SET trackDeviceIdentity = 0 WHERE id = ?').run(s50.id);
    const result = await bindProfileToDrive(getProfileById(s50.id)!, drive);
    expect(result).toEqual({ status: 'unmarked', reason: 'tracking-off' });
    expect(fs.existsSync(path.join(drive, '.nebulis.dat'))).toBe(false);
  });
});
