import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-darklib-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// What the "device" currently holds, keyed by remote path.
const device = vi.hoisted(() => ({ files: new Map<string, string>(), failNext: false }));

vi.mock('../../server/lib/smb', () => ({ smbListDir: async () => [] }));
vi.mock('../../server/lib/library/importWrite', () => ({
  copyTransportFile: async (remotePath: string, destPath: string) => {
    if (device.failNext) {
      device.failNext = false;
      fs.writeFileSync(destPath, 'half');
      throw new Error('connection dropped');
    }
    const body = device.files.get(remotePath) ?? '';
    fs.writeFileSync(destPath, body);
    return body.length;
  },
}));

import { downloadToArchive, type RemoteArchiveCandidate } from '../../server/lib/library/remoteArchive';
import { calibrationTypeForFolderName, isCalibrationFolderName } from '../../server/lib/library/calibrationFolders';
import type { TelescopeProfile } from '../../server/lib/telescopes';

const profile = {} as TelescopeProfile;
const archiveDir = path.join(TEST_DATA_DIR, 'archive');

const candidate = (body: string, mtime: string, name = 'dark_10s.fit'): RemoteArchiveCandidate => ({
  remotePath: `darklibrary/${name}`,
  relPath: `darklibrary/${name}`,
  size: body.length,
  mtime,
});

function put(body: string, mtime: string, name = 'dark_10s.fit'): RemoteArchiveCandidate {
  device.files.set(`darklibrary/${name}`, body);
  return candidate(body, mtime, name);
}

const dest = path.join(archiveDir, 'darklibrary', 'dark_10s.fit');

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  device.files.clear();
  device.failNext = false;
  fs.rmSync(archiveDir, { recursive: true, force: true });
});

describe('SeeStar darklibrary folder name', () => {
  it('is recognized as a dark calibration folder', () => {
    expect(calibrationTypeForFolderName('darklibrary')).toBe('dark');
    expect(calibrationTypeForFolderName('DarkLibrary')).toBe('dark');
    expect(isCalibrationFolderName('darklibrary')).toBe(true);
  });

  it('does not claim a folder that merely contains the word', () => {
    expect(isCalibrationFolderName('Dark Library Nebulae')).toBe(false);
  });
});

describe('downloadToArchive replaceChanged', () => {
  it('copies a new file and stamps it with the device mtime', async () => {
    const c = put('AAAA', '2026-10-01T10:00:00.000Z');
    const r = await downloadToArchive(profile, [c], archiveDir, { replaceChanged: true });
    expect(r).toMatchObject({ copied: 1, replaced: 0, alreadyPresent: 0, failed: 0 });
    expect(fs.readFileSync(dest, 'utf8')).toBe('AAAA');
    expect(fs.statSync(dest).mtimeMs).toBeCloseTo(Date.parse('2026-10-01T10:00:00.000Z'), -3);
  });

  it('skips a file that has not changed on the device', async () => {
    const c = put('AAAA', '2026-10-01T10:00:00.000Z');
    await downloadToArchive(profile, [c], archiveDir, { replaceChanged: true });
    const again = await downloadToArchive(profile, [c], archiveDir, { replaceChanged: true });
    expect(again).toMatchObject({ copied: 0, alreadyPresent: 1 });
  });

  it('replaces in place when the device rebuilt the file at the same size, keeping the old copy', async () => {
    await downloadToArchive(profile, [put('AAAA', '2026-10-01T10:00:00.000Z')], archiveDir, { replaceChanged: true });
    const r = await downloadToArchive(profile, [put('BBBB', '2026-10-09T10:00:00.000Z')], archiveDir, { replaceChanged: true });
    expect(r).toMatchObject({ copied: 1, replaced: 1 });
    expect(fs.readFileSync(dest, 'utf8')).toBe('BBBB');
    expect(fs.readdirSync(path.join(archiveDir, 'darklibrary'))).toEqual(['dark_10s.fit']);

    const stamps = fs.readdirSync(path.join(archiveDir, '.replaced'));
    expect(stamps).toHaveLength(1);
    expect(fs.readFileSync(path.join(archiveDir, '.replaced', stamps[0], 'darklibrary', 'dark_10s.fit'), 'utf8')).toBe('AAAA');
  });

  it('replaces when only the size changed and the device reports no mtime', async () => {
    await downloadToArchive(profile, [put('AAAA', '2026-10-01T10:00:00.000Z')], archiveDir, { replaceChanged: true });
    const noTime = { ...put('LONGER', ''), mtime: undefined };
    const r = await downloadToArchive(profile, [noTime], archiveDir, { replaceChanged: true });
    expect(r.replaced).toBe(1);
    expect(fs.readFileSync(dest, 'utf8')).toBe('LONGER');
  });

  it('leaves the archived copy intact and no .part behind when the transfer fails', async () => {
    await downloadToArchive(profile, [put('AAAA', '2026-10-01T10:00:00.000Z')], archiveDir, { replaceChanged: true });
    device.failNext = true;
    const r = await downloadToArchive(profile, [put('BBBB', '2026-10-09T10:00:00.000Z')], archiveDir, { replaceChanged: true });
    expect(r.failed).toBe(1);
    expect(fs.readFileSync(dest, 'utf8')).toBe('AAAA');
    expect(fs.readdirSync(path.join(archiveDir, 'darklibrary'))).toEqual(['dark_10s.fit']);
  });

  it('without the option keeps the existing rule: a changed size lands beside the old file', async () => {
    await downloadToArchive(profile, [put('AAAA', '2026-10-01T10:00:00.000Z')], archiveDir);
    await downloadToArchive(profile, [put('LONGER', '2026-10-09T10:00:00.000Z')], archiveDir);
    expect(fs.readdirSync(path.join(archiveDir, 'darklibrary')).length).toBe(2);
  });
});
