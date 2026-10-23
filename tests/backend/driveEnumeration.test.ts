import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Own DATA_DIR (the module prepares a telescopeProfiles statement at load) and a
// fake "/Volumes" root: fs/promises readdir/open calls under /Volumes are
// redirected into a temp directory, and process.platform is pinned to darwin, so
// detectDrives() walks a fixture tree on any host OS.
const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-drives-test-'));
  process.env.DATA_DIR = dir;
  const volumes = _path.join(dir, 'Volumes');
  _fs.mkdirSync(volumes, { recursive: true });
  const redirect = (p: unknown): unknown =>
    typeof p === 'string' && (p === '/Volumes' || p.startsWith('/Volumes/')) ? volumes + p.slice('/Volumes'.length) : p;
  return { dir, volumes, redirect };
});

vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  const readdir = (p: string, ...rest: unknown[]) => (real.readdir as (...a: unknown[]) => unknown)(H.redirect(p), ...rest);
  const open = (p: string, ...rest: unknown[]) => (real.open as (...a: unknown[]) => unknown)(H.redirect(p), ...rest);
  return { ...real, default: { ...real, readdir, open }, readdir, open };
});

import fs from 'fs';
import path from 'path';
import db from '../../server/lib/db';
import { detectDrives } from '../../server/lib/driveEnumeration';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function mkdirs(volume: string, ...dirs: string[]): void {
  for (const d of dirs) fs.mkdirSync(path.join(H.volumes, volume, d), { recursive: true });
}

async function detectOne(volume: string) {
  const all = await detectDrives();
  return all.find(d => d.volumeName === volume);
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  fs.rmSync(H.volumes, { recursive: true, force: true });
  fs.mkdirSync(H.volumes, { recursive: true });
  db.prepare('DELETE FROM telescopeProfiles').run();
});

afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  db.close();
  fs.rmSync(H.dir, { recursive: true, force: true });
});

describe('detectDrives (macOS /Volumes)', () => {
  it('ignores volumes with no telescope hallmark folders', async () => {
    mkdirs('Macintosh HD', 'Users', 'Applications');
    expect(await detectDrives()).toEqual([]);
  });

  it('flags a Seestar volume by its MyWorks folder', async () => {
    mkdirs('SEESTAR', 'MyWorks/M31');

    const d = await detectOne('SEESTAR');

    expect(d).toMatchObject({
      mountPath: '/Volumes/SEESTAR',
      looksLikeSeestar: true,
      looksLikeDwarf: false,
      looksLikeAsiair: false,
      alreadyKnownDeviceId: null,
    });
  });

  it('detects ASIAIR folders at the root and under an ASIAir/ subfolder (any casing)', async () => {
    mkdirs('AIR1', 'Autorun');
    mkdirs('AIRSTICK', 'asiair/Plan');

    expect((await detectOne('AIR1'))?.asiairSubPath).toBeUndefined();
    expect(await detectOne('AIRSTICK')).toMatchObject({ looksLikeAsiair: true, asiairSubPath: 'asiair' });
  });

  it('does not flag an ASIAir/ folder that holds no capture-mode folders', async () => {
    mkdirs('STICK', 'ASIAir/Other');
    expect(await detectOne('STICK')).toBeUndefined();
  });

  it.each([
    ['dwarf-3', ['DWARF3_RAW_M31_1', 'DWARF_RAW_M42_1', 'DWARF3_RAW_M45_1'], []],
    ['dwarf-2', ['DWARF_RAW_M31_1'], []],
    ['dwarf-mini', ['DWARF_RAW_M31_1'], ['CALI_FRAME']],
  ])('fingerprints the Dwarf model as %s', async (model, sessions, extra) => {
    mkdirs('DWARF', ...sessions.map(s => `Astronomy/${s}`), ...extra);
    expect((await detectOne('DWARF'))?.detectedDwarfModel).toBe(model);
  });

  it('flags a fresh Dwarf with no sessions but leaves the model unknown', async () => {
    mkdirs('DWARF', 'DWARF_DATA');

    const d = await detectOne('DWARF');

    expect(d?.looksLikeDwarf).toBe(true);
    expect(d?.detectedDwarfModel).toBeUndefined();
  });

  it('matches .nebulis.dat deviceId to a known telescope profile', async () => {
    mkdirs('SEESTAR', 'MyWorks');
    fs.writeFileSync(path.join(H.volumes, 'SEESTAR', '.nebulis.dat'), JSON.stringify({ deviceId: 'dev-123' }));
    db.prepare(
      `INSERT INTO telescopeProfiles (id, name, deviceId, createdAt) VALUES ('p1', 'Backyard S50', 'dev-123', '2026-01-01')`,
    ).run();

    const d = await detectOne('SEESTAR');

    expect(d).toMatchObject({ alreadyKnownDeviceId: 'dev-123', alreadyKnownProfileId: 'p1', alreadyKnownProfileName: 'Backyard S50' });
  });

  it('reports a deviceId with no matching profile, and ignores a malformed .nebulis.dat', async () => {
    mkdirs('A', 'MyWorks');
    mkdirs('B', 'MyWorks');
    fs.writeFileSync(path.join(H.volumes, 'A', '.nebulis.dat'), JSON.stringify({ deviceId: 'orphan' }));
    fs.writeFileSync(path.join(H.volumes, 'B', '.nebulis.dat'), '{"deviceId": ');

    expect(await detectOne('A')).toMatchObject({ alreadyKnownDeviceId: 'orphan', alreadyKnownProfileId: null });
    expect((await detectOne('B'))?.alreadyKnownDeviceId).toBeNull();
  });

  it('treats an empty or non-string deviceId as unknown', async () => {
    mkdirs('A', 'MyWorks');
    fs.writeFileSync(path.join(H.volumes, 'A', '.nebulis.dat'), JSON.stringify({ deviceId: '' }));
    expect((await detectOne('A'))?.alreadyKnownDeviceId).toBeNull();
  });

  it('returns [] on an unsupported platform', async () => {
    mkdirs('SEESTAR', 'MyWorks');
    Object.defineProperty(process, 'platform', { value: 'aix' });
    expect(await detectDrives()).toEqual([]);
  });
});
