/**
 * runUpdateCheck(): the desktop updater's decision logic. Network, signature
 * and SHA checks, platform and running version are mocked; state.ts and the
 * staging directory are real (scratch DATA_DIR).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-appupdater-'));
  process.env.DATA_DIR = dir;
  return dir;
});

const m = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  fetchText: vi.fn(),
  downloadToFile: vi.fn(),
  verifySig: vi.fn(),
  verifySha: vi.fn(),
  platform: vi.fn(),
  current: vi.fn(),
  settings: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../../server/lib/catalogPack/download', () => ({ fetchJson: m.fetchJson, fetchText: m.fetchText, downloadToFile: m.downloadToFile }));
vi.mock('../../server/lib/catalogPack/verify', () => ({ verifyFileSha256: m.verifySha }));
vi.mock('../../server/lib/appUpdate/verify', () => ({ verifyAppManifestSignature: m.verifySig }));
vi.mock('../../server/lib/appUpdate/platform', async (orig) => {
  const real = await orig<typeof import('../../server/lib/appUpdate/platform')>();
  return { ...real, getUpdatePlatform: m.platform, getCurrentVersion: m.current };
});
vi.mock('../../server/lib/telescopes', () => ({ getSettingsData: m.settings }));
vi.mock('../../server/lib/systemLog', () => ({ logEvent: m.logEvent }));

import { runUpdateCheck, stopAppUpdateChecker } from '../../server/lib/appUpdate/updater';
import { getUpdateStatus, setUpdateStatus, UPDATES_DIR } from '../../server/lib/appUpdate/state';

const SHA = 'b'.repeat(64);
const URL_WIN = 'https://downloads.example/app/Nebulis-Setup-2.2.0.exe';

function manifest(over: Record<string, unknown> = {}, artifacts: Record<string, unknown> | null = null) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, channel: 'stable', generatedAt: '2026-01-01',
    latest: {
      version: '2.2.0', build: 300, minUpgradableFrom: '2.0.0', mandatory: false,
      notesUrl: 'https://example.com/notes',
      artifacts: artifacts ?? { 'win-x64': { url: URL_WIN, sha256: SHA, bytes: 10 }, 'mac-arm64': { url: 'https://example.com/m.dmg', sha256: SHA, bytes: 10 } },
      ...over,
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fs.rmSync(UPDATES_DIR, { recursive: true, force: true });
  setUpdateStatus({
    latestVersion: null, latestBuild: null, updateAvailable: false, mandatory: false, notesUrl: null,
    staged: false, stagedPath: null, stagedSha256: null, lastCheckedAt: null, lastError: null,
  });
  m.platform.mockReturnValue('win-x64');
  m.current.mockReturnValue({ version: '2.1.2', build: 295, known: true });
  m.settings.mockReturnValue({ updateChannel: 'stable', autoUpdateEnabled: false });
  m.fetchText.mockResolvedValue('sig');
  m.fetchJson.mockResolvedValue(manifest());
  m.verifySig.mockReturnValue(true);
  m.verifySha.mockReturnValue(true);
  m.downloadToFile.mockImplementation(async (_u: string, dest: string) => { fs.writeFileSync(dest, 'installer'); });
});

afterAll(() => {
  stopAppUpdateChecker();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('runUpdateCheck: what is offered', () => {
  it('reports an available newer version and stages the Windows installer', async () => {
    await runUpdateCheck();
    const s = getUpdateStatus();
    expect(s).toMatchObject({ updateAvailable: true, latestVersion: '2.2.0', latestBuild: 300, staged: true, lastError: null });
    expect(s.stagedPath).toBe(path.join(UPDATES_DIR, 'Nebulis-Setup-2.2.0.exe'));
    expect(fs.existsSync(s.stagedPath!)).toBe(true);
    expect(m.logEvent.mock.calls.map(c => c[0].event)).toEqual(['update_available', 'update_staged']);
  });

  it('on macOS reports availability but downloads nothing', async () => {
    m.platform.mockReturnValue('mac-arm64');
    await runUpdateCheck();
    expect(getUpdateStatus()).toMatchObject({ updateAvailable: true, staged: false });
    expect(m.downloadToFile).not.toHaveBeenCalled();
  });

  it('does nothing network-wise on a platform with no updater', async () => {
    m.platform.mockReturnValue(null);
    await runUpdateCheck();
    expect(m.fetchJson).not.toHaveBeenCalled();
    expect(getUpdateStatus().updateAvailable).toBe(false);
  });

  it('uses the beta channel URL when the user chose beta', async () => {
    m.settings.mockReturnValue({ updateChannel: 'beta' });
    await runUpdateCheck();
    expect(m.fetchJson.mock.calls[0][0]).toBe('https://downloads.nebulis.app/app/v1/beta/index.json');
    expect(m.fetchText.mock.calls[0][0]).toBe('https://downloads.nebulis.app/app/v1/beta/index.json.sig');
    expect(getUpdateStatus().channel).toBe('beta');
  });

  it('falls back to stable when settings cannot be read', async () => {
    m.settings.mockImplementation(() => { throw new Error('db closed'); });
    await runUpdateCheck();
    expect(m.fetchJson.mock.calls[0][0]).toContain('/stable/index.json');
  });

  it('does not log update_available again for a version it already announced', async () => {
    await runUpdateCheck();
    m.logEvent.mockClear();
    await runUpdateCheck();
    expect(m.logEvent.mock.calls.map(c => c[0].event)).not.toContain('update_available');
  });
});

describe('runUpdateCheck: downgrade protection', () => {
  it.each([
    ['older version', { version: '2.0.9', build: 999 }],
    ['same version, same build', { version: '2.1.2', build: 295 }],
    ['same version, older build', { version: '2.1.2', build: 290 }],
  ])('never offers %s', async (_label, latest) => {
    m.fetchJson.mockResolvedValue(manifest(latest));
    await runUpdateCheck();
    expect(getUpdateStatus()).toMatchObject({ updateAvailable: false, staged: false });
    expect(m.downloadToFile).not.toHaveBeenCalled();
  });

  it('offers the same version when the build is newer', async () => {
    m.fetchJson.mockResolvedValue(manifest({ version: '2.1.2', build: 296 }));
    await runUpdateCheck();
    expect(getUpdateStatus().updateAvailable).toBe(true);
  });
});

describe('runUpdateCheck: refusals', () => {
  it('ignores a manifest with a bad signature and records why', async () => {
    m.verifySig.mockReturnValue(false);
    await runUpdateCheck();
    expect(getUpdateStatus()).toMatchObject({ updateAvailable: false, lastError: 'manifest signature invalid' });
    expect(m.downloadToFile).not.toHaveBeenCalled();
    expect(m.logEvent.mock.calls[0][0].event).toBe('update_check_failed');
  });

  it('never offers or stages a yanked release', async () => {
    m.fetchJson.mockResolvedValue(manifest({ yanked: true }));
    await runUpdateCheck();
    expect(getUpdateStatus()).toMatchObject({ updateAvailable: false, latestVersion: '2.2.0', staged: false });
    expect(m.downloadToFile).not.toHaveBeenCalled();
  });

  it('blocks the in-place update from a build older than minUpgradableFrom', async () => {
    m.fetchJson.mockResolvedValue(manifest({ minUpgradableFrom: '2.1.5' }));
    await runUpdateCheck();
    const s = getUpdateStatus();
    expect(s.updateAvailable).toBe(false);
    expect(s.lastError).toMatch(/too old for an automatic update/);
    expect(m.downloadToFile).not.toHaveBeenCalled();
  });

  it('skips the minUpgradableFrom check when the running version is unknown', async () => {
    m.current.mockReturnValue({ version: '0.0.0', build: 0, known: false });
    m.fetchJson.mockResolvedValue(manifest({ minUpgradableFrom: '2.1.5' }));
    await runUpdateCheck();
    expect(getUpdateStatus().updateAvailable).toBe(true);
  });

  it('reports a missing artifact for this platform', async () => {
    m.fetchJson.mockResolvedValue(manifest({}, { 'mac-x64': { url: 'https://example.com/x.dmg', sha256: SHA, bytes: 1 } }));
    await runUpdateCheck();
    expect(getUpdateStatus()).toMatchObject({ updateAvailable: false, lastError: 'no win-x64 artifact in manifest' });
  });

  it('records a network error without throwing', async () => {
    m.fetchJson.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(runUpdateCheck()).resolves.toBeUndefined();
    expect(getUpdateStatus().lastError).toBe('ETIMEDOUT');
  });

  it('records a malformed manifest as an error', async () => {
    m.fetchJson.mockResolvedValue(Buffer.from('{"schemaVersion":1}'));
    await runUpdateCheck();
    expect(getUpdateStatus().lastError).toBeTruthy();
    expect(getUpdateStatus().updateAvailable).toBe(false);
  });
});

describe('runUpdateCheck: Windows staging', () => {
  it('deletes an installer that fails SHA-256 and does not mark it staged', async () => {
    m.verifySha.mockReturnValue(false);
    await runUpdateCheck();
    const s = getUpdateStatus();
    expect(s).toMatchObject({ staged: false, stagedPath: null, lastError: 'staged installer failed SHA-256 check' });
    expect(fs.existsSync(path.join(UPDATES_DIR, 'Nebulis-Setup-2.2.0.exe'))).toBe(false);
    expect(m.logEvent.mock.calls.map(c => c[0].event)).toContain('update_verify_failed');
  });

  it('reuses an intact installer already on disk instead of downloading again', async () => {
    fs.mkdirSync(UPDATES_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPDATES_DIR, 'Nebulis-Setup-2.2.0.exe'), 'already here');
    await runUpdateCheck();
    expect(m.downloadToFile).not.toHaveBeenCalled();
    expect(getUpdateStatus().staged).toBe(true);
  });

  it('removes stale installers from older versions but keeps apply.json', async () => {
    fs.mkdirSync(UPDATES_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPDATES_DIR, 'Nebulis-Setup-2.0.0.exe'), 'old');
    fs.writeFileSync(path.join(UPDATES_DIR, 'partial.tmp'), 'half');
    fs.writeFileSync(path.join(UPDATES_DIR, 'apply.json'), '{}');
    m.verifySha.mockImplementation((p: string) => path.basename(p) === 'Nebulis-Setup-2.2.0.exe');
    await runUpdateCheck();
    expect(fs.readdirSync(UPDATES_DIR).sort()).toEqual(['Nebulis-Setup-2.2.0.exe', 'apply.json']);
  });

  it('collapses overlapping checks into one download', async () => {
    let release!: () => void;
    m.downloadToFile.mockImplementation((_u: string, dest: string) => new Promise<void>(r => {
      release = () => { fs.writeFileSync(dest, 'x'); r(); };
    }));
    const a = runUpdateCheck();
    const b = runUpdateCheck();
    await vi.waitFor(() => expect(m.downloadToFile).toHaveBeenCalled());
    release();
    await Promise.all([a, b]);
    expect(m.downloadToFile).toHaveBeenCalledTimes(1);
    expect(m.fetchJson).toHaveBeenCalledTimes(1);
  });
});
