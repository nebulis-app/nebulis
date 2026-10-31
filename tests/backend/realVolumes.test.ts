/**
 * Two Seestar memory cards as real mounted volumes (macOS disk images), run through the server's real drive code: detection by
 * scanning /Volumes, pairing, following a card that moved, and refusing one that belongs to another telescope. Two images with the
 * same volume name are what two real Seestars look like to macOS: the second one gets a numeric suffix, and which card holds which
 * path depends on the order they were plugged in.
 *
 * macOS only (hdiutil); skipped everywhere else. Only volumes this test mounts are ejected.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-real-volumes-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

import fs from 'fs';
import path from 'path';
import db from '../../server/lib/db';
import { detectDrives, type DetectedDrive } from '../../server/lib/driveEnumeration';
import { createProfile, getProfileById, type TelescopeProfile } from '../../server/lib/telescopes';
import { addTransport, selectActiveTransport, invalidateActiveTransportCache } from '../../server/lib/telescopeTransports';
import {
  bindProfileToDrive, checkDriveMatchesProfile, prepareActiveTransport, refreshDriveBindings, resetDriveBindingScan,
} from '../../server/lib/driveBindings';
import { canMountDiskImages, makeCard, plug, unplug, unplugAll, uniqueVolumeName } from './helpers/diskImages';

afterAll(() => fs.rmSync(H.dir, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare('DELETE FROM telescopeTransports').run();
  db.prepare('DELETE FROM telescopeProfiles').run();
  invalidateActiveTransportCache();
  resetDriveBindingScan();
});
afterEach(() => unplugAll());

/** A telescope with only a USB transport, at `usbPath`. */
function telescope(name: string, usbPath: string, extra: Partial<TelescopeProfile> = {}): TelescopeProfile {
  const profile = createProfile({ name, kind: 'seestar-s50', hostname: '', ...extra });
  db.prepare('DELETE FROM telescopeTransports WHERE profileId = ?').run(profile.id);
  addTransport(profile.id, { kind: 'local', localPath: usbPath });
  invalidateActiveTransportCache(profile.id);
  return getProfileById(profile.id)!;
}

const fresh = (p: TelescopeProfile) => getProfileById(p.id)!;
const idOnCard = (mount: string) => (JSON.parse(fs.readFileSync(path.join(mount, '.nebulis.dat'), 'utf8')) as { deviceId: string }).deviceId;
const drivesNamed = async (label: string): Promise<DetectedDrive[]> => (await detectDrives()).filter(d => d.mountPath.startsWith(`/Volumes/${label}`));

/** Two same-named cards, plugged in A then B, each with its own telescope already paired to it. */
async function pairedPair() {
  const work = fs.mkdtempSync(path.join(H.dir, 'cards-'));
  const label = uniqueVolumeName();
  const dmgA = makeCard(work, label, ['M 42']);
  const dmgB = makeCard(work, label, ['M 31']);
  const mountA = plug(dmgA);
  const mountB = plug(dmgB);
  const a = telescope('Seestar A', mountA);
  const b = telescope('Seestar B', mountB);
  await bindProfileToDrive(a, mountA);
  await bindProfileToDrive(b, mountB);
  return { work, label, dmgA, dmgB, mountA, mountB, a: fresh(a), b: fresh(b) };
}

describe.skipIf(!canMountDiskImages)('two Seestar cards as real volumes', { timeout: 120_000 }, () => {
  beforeAll(() => {
    // Skip loudly rather than fail where macOS will not mount a disk image (a locked-down CI runner, say).
    try { const probe = makeCard(fs.mkdtempSync(path.join(H.dir, 'probe-')), uniqueVolumeName()); fs.rmSync(probe, { force: true }); }
    catch (err) { throw new Error(`cannot mount a disk image here: ${err instanceof Error ? err.message : err}`); }
  }, 60_000);

  it('sees both cards, marks each with its own id, and refuses to give one the other\'s', async () => {
    const work = fs.mkdtempSync(path.join(H.dir, 'cards-'));
    const label = uniqueVolumeName();
    const mountA = plug(makeCard(work, label, ['M 42']));
    const mountB = plug(makeCard(work, label, ['M 31']));
    expect(mountB).not.toBe(mountA);

    const seen = await drivesNamed(label);
    expect(seen.map(d => d.mountPath).sort()).toEqual([mountA, mountB].sort());
    expect(seen.every(d => d.looksLikeSeestar && d.alreadyKnownDeviceId === null && d.writable)).toBe(true);

    const a = telescope('Seestar A', mountA);
    const b = telescope('Seestar B', mountB);
    expect(await bindProfileToDrive(a, mountA)).toMatchObject({ status: 'paired', wrote: true });
    expect(await bindProfileToDrive(b, mountB)).toMatchObject({ status: 'paired', wrote: true });
    expect(idOnCard(mountA)).not.toBe(idOnCard(mountB));
    expect(fresh(a).deviceId).toBe(idOnCard(mountA));
    expect(fresh(b).deviceId).toBe(idOnCard(mountB));

    // Detection now says whose each card is.
    const after = await drivesNamed(label);
    expect(after.find(d => d.mountPath === mountA)?.alreadyKnownProfileName).toBe('Seestar A');
    expect(after.find(d => d.mountPath === mountB)?.alreadyKnownProfileName).toBe('Seestar B');

    // One telescope cannot be given the other's card, by pairing or at import time.
    expect(await bindProfileToDrive(fresh(b), mountA)).toMatchObject({ status: 'conflict', reason: 'other-telescope', ownerName: 'Seestar A' });
    const wrong = await checkDriveMatchesProfile(fresh(a), mountB);
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.message).toContain('Seestar B');
    expect(await checkDriveMatchesProfile(fresh(a), mountA)).toEqual({ ok: true });
  });

  it('follows each card to its new path when the two are swapped', async ({ skip }) => {
    const { dmgA, dmgB, mountA, mountB, a, b } = await pairedPair();
    unplug(mountA); unplug(mountB);
    const nowFirst = plug(dmgB);   // B is plugged in first, so it takes the plain name A used to have
    const nowSecond = plug(dmgA);
    if (nowFirst !== mountA || nowSecond !== mountB) return skip('macOS did not reuse the mount paths in swapped order');

    await refreshDriveBindings({ force: true });

    // Each telescope's saved path now holds the other's card, but each is sent to its own card.
    expect(selectActiveTransport(a.id)?.localPath).toBe(nowSecond);
    expect(selectActiveTransport(b.id)?.localPath).toBe(nowFirst);
    expect(await prepareActiveTransport(fresh(a))).toMatchObject({ error: null, transport: { localPath: nowSecond } });
    expect(await prepareActiveTransport(fresh(b))).toMatchObject({ error: null, transport: { localPath: nowFirst } });
  });

  it('refuses to import from the other telescope\'s card sitting at the saved path, and sends the owner to where its card is', async ({ skip }) => {
    const { dmgB, mountA, mountB, a, b } = await pairedPair();
    unplug(mountA); unplug(mountB);
    const onlyB = plug(dmgB);               // only B's card is in, and it takes A's old path
    if (onlyB !== mountA) return skip('macOS did not reuse the first mount path');

    await refreshDriveBindings({ force: true });

    const refused = await prepareActiveTransport(fresh(a));
    expect(refused.transport).toBeNull();
    expect(refused.error).toContain('Seestar B');
    expect(await prepareActiveTransport(fresh(b))).toMatchObject({ error: null, transport: { localPath: onlyB } });
  });

  it('falls back to Wi-Fi the moment the card is unplugged, and back to the card when it returns', async () => {
    const work = fs.mkdtempSync(path.join(H.dir, 'cards-'));
    const dmg = makeCard(work, uniqueVolumeName());
    const mount = plug(dmg);
    const profile = createProfile({ name: 'Seestar', kind: 'seestar-s50', hostname: '192.168.1.5' });
    addTransport(profile.id, { kind: 'local', localPath: mount, priority: 50 });
    invalidateActiveTransportCache(profile.id);

    expect(selectActiveTransport(profile.id)?.kind).toBe('local');
    unplug(mount);
    expect(selectActiveTransport(profile.id)?.kind).toBe('smb');

    const back = plug(dmg);
    if (back === mount) {
      await refreshDriveBindings({ force: true });
      expect(selectActiveTransport(profile.id)?.kind).toBe('local');
    }
  });

  it('pairs a read-only card by path only, and gives the telescope no id that is not on the card', async () => {
    const work = fs.mkdtempSync(path.join(H.dir, 'cards-'));
    const mount = plug(makeCard(work, uniqueVolumeName()), { readOnly: true });
    const profile = telescope('Locked card', mount);

    expect(await bindProfileToDrive(profile, mount)).toEqual({ status: 'unmarked', reason: 'read-only' });
    expect(fresh(profile).deviceId).toBeNull();
    expect(fs.existsSync(path.join(mount, '.nebulis.dat'))).toBe(false);
    expect((await detectDrives()).find(d => d.mountPath === mount)?.writable).toBe(false);
    expect(await prepareActiveTransport(fresh(profile))).toMatchObject({ error: null, transport: { localPath: mount } });
  });

  it('writes nothing to a card when the telescope has identity tracking off', async () => {
    const work = fs.mkdtempSync(path.join(H.dir, 'cards-'));
    const mount = plug(makeCard(work, uniqueVolumeName()));
    const profile = telescope('Untracked', mount, { trackDeviceIdentity: false });

    expect(await bindProfileToDrive(profile, mount)).toEqual({ status: 'unmarked', reason: 'tracking-off' });
    expect(fs.existsSync(path.join(mount, '.nebulis.dat'))).toBe(false);
    expect(fresh(profile).deviceId).toBeNull();
  });

  it('trusts an unmarked card at its saved path (the server keeps no volume id, unlike the Mac app)', async ({ skip }) => {
    const work = fs.mkdtempSync(path.join(H.dir, 'cards-'));
    const label = uniqueVolumeName();
    const dmgA = makeCard(work, label, ['M 42']);
    const dmgB = makeCard(work, label, ['M 31']);
    const mountA = plug(dmgA);
    const profile = telescope('Seestar', mountA);
    unplug(mountA);
    const other = plug(dmgB);
    if (other !== mountA) return skip('macOS did not reuse the mount path');

    // Neither card is marked, so nothing says B's card is not this telescope's. This pins today's behaviour so that a change to it is deliberate.
    expect(await prepareActiveTransport(fresh(profile))).toMatchObject({ error: null, transport: { localPath: mountA } });
  });
});
