import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// listVolumes walks /Volumes on macOS and parses PowerShell JSON on Windows.
// fs/promises calls under /Volumes are redirected into a temp dir, execFile is
// mocked, and process.platform is pinned per test, so every branch runs on any host.
const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-volumes-test-'));
  const volumes = _path.join(dir, 'Volumes');
  const redirect = (p: unknown): unknown =>
    typeof p === 'string' && (p === '/Volumes' || p.startsWith('/Volumes/')) ? volumes + p.slice('/Volumes'.length) : p;
  return { dir, volumes, redirect, psStdout: { value: '' as string | Error } };
});

vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  const readdir = (p: string, ...rest: unknown[]) => (real.readdir as (...a: unknown[]) => unknown)(H.redirect(p), ...rest);
  const stat = (p: string, ...rest: unknown[]) => (real.stat as (...a: unknown[]) => unknown)(H.redirect(p), ...rest);
  return { ...real, default: { ...real, readdir, stat }, readdir, stat };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    const v = H.psStdout.value;
    if (v instanceof Error) cb(v);
    else cb(null, { stdout: v, stderr: '' });
  };
  return { ...real, default: { ...real, execFile }, execFile };
});

import fs from 'fs';
import path from 'path';
import { listVolumes, listDirectories } from '../../server/lib/volumes';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });

beforeEach(() => {
  fs.rmSync(H.volumes, { recursive: true, force: true });
  fs.mkdirSync(H.volumes, { recursive: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  fs.rmSync(H.dir, { recursive: true, force: true });
});

describe('listVolumes on macOS', () => {
  beforeEach(() => setPlatform('darwin'));

  it('lists real volumes and hides APFS system volumes, dotfiles, dmg mounts, and plain files', async () => {
    for (const d of ['Astro SSD', 'Preboot', 'Recovery', '.timemachine', 'dmg.exv6QA', 'com.apple.TimeMachine.localsnapshots']) {
      fs.mkdirSync(path.join(H.volumes, d));
    }
    fs.writeFileSync(path.join(H.volumes, 'stray-file'), 'x');

    const vols = await listVolumes();

    expect(vols.map(v => v.label)).toEqual(['Astro SSD']);
    expect(vols[0]).toMatchObject({ path: '/Volumes/Astro SSD', external: true });
  });

  it('returns [] when /Volumes has nothing usable', async () => {
    expect(await listVolumes()).toEqual([]);
  });
});

describe('listVolumes on Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('accepts a bare single-disk object as well as an array', async () => {
    H.psStdout.value = JSON.stringify({ DeviceID: 'C:', VolumeName: 'OS', FreeSpace: 100, Size: 500, DriveType: 3 });

    const vols = await listVolumes();

    expect(vols).toEqual([{ path: 'C:\\', label: 'OS (C:)', totalBytes: 500, freeBytes: 100, writable: false, external: false }]);
  });

  it('hides optical/unknown drives and recovery partitions, and marks removable drives external', async () => {
    H.psStdout.value = JSON.stringify([
      { DeviceID: 'C:', VolumeName: 'OS', FreeSpace: 1, Size: 2, DriveType: 3 },
      { DeviceID: 'D:', VolumeName: 'DVD', DriveType: 5 },
      { DeviceID: 'E:', VolumeName: 'Unknown', DriveType: 0 },
      { DeviceID: 'R:', VolumeName: 'Recovery', DriveType: 3 },
      { DeviceID: 'F:', VolumeName: '', FreeSpace: '7', Size: '9', DriveType: 2 },
    ]);

    const vols = await listVolumes();

    expect(vols.map(v => v.path)).toEqual(['C:\\', 'F:\\']);
    expect(vols[1]).toMatchObject({ label: 'F:', totalBytes: 9, freeBytes: 7, external: true });
  });

  it('reads a non-numeric size (CIM object for huge values) as 0, not NaN', async () => {
    H.psStdout.value = JSON.stringify([{ DeviceID: 'G:', FreeSpace: { Value: 1 }, Size: 'lots', DriveType: 3 }]);

    const [g] = await listVolumes();

    expect(g.totalBytes).toBe(0);
    expect(g.freeBytes).toBe(0);
  });

  it('drops entries that are not objects or lack a DeviceID', async () => {
    H.psStdout.value = JSON.stringify([null, 'C:', { VolumeName: 'No id', DriveType: 3 }, { DeviceID: 'H:', DriveType: 4 }]);
    expect((await listVolumes()).map(v => v.path)).toEqual(['H:\\']);
  });

  it('returns [] when PowerShell fails or prints invalid JSON', async () => {
    H.psStdout.value = new Error('powershell.exe not found');
    expect(await listVolumes()).toEqual([]);
    H.psStdout.value = 'Get-CimInstance : Access denied';
    expect(await listVolumes()).toEqual([]);
  });
});

describe('listVolumes on an unsupported platform', () => {
  it('returns []', async () => {
    setPlatform('aix');
    expect(await listVolumes()).toEqual([]);
  });
});

describe('listDirectories', () => {
  it('rejects a relative path', async () => {
    await expect(listDirectories('relative/dir')).rejects.toThrow('Path must be absolute.');
  });

  it('lists only non-hidden subdirectories, sorted by name', async () => {
    const parent = path.join(H.dir, 'browse');
    for (const d of ['zeta', 'Alpha', '.hidden', 'mid']) fs.mkdirSync(path.join(parent, d), { recursive: true });
    fs.writeFileSync(path.join(parent, 'file.txt'), 'x');

    const dirs = await listDirectories(parent);

    expect(dirs.map(d => d.name)).toEqual(['Alpha', 'mid', 'zeta']);
    expect(dirs[0].path).toBe(path.join(parent, 'Alpha'));
  });

  it('rejects a path that does not exist', async () => {
    await expect(listDirectories(path.join(H.dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
