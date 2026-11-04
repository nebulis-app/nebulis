/**
 * checkAndUpdatePacks(): decides which catalog tiers to install from the signed
 * remote index. The network, signature check, pack state, installer and
 * prefetch job are all mocked; this pins the decision logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  fetchText: vi.fn(),
  verify: vi.fn(),
  getAllPackStates: vi.fn(),
  install: vi.fn(),
  prefetchStatus: vi.fn(),
  startPrefetch: vi.fn(),
}));

vi.mock('../../server/lib/catalogPack/download', () => ({ fetchJson: m.fetchJson, fetchText: m.fetchText }));
vi.mock('../../server/lib/catalogPack/verify', () => ({ verifyManifestSignature: m.verify }));
vi.mock('../../server/lib/catalogPack/state', () => ({ getAllPackStates: m.getAllPackStates }));
vi.mock('../../server/lib/catalogPack/install', () => ({ installCatalogPacks: m.install }));
vi.mock('../../server/lib/catalogPrefetch', () => ({ getPrefetchStatus: m.prefetchStatus, startPrefetch: m.startPrefetch }));

import { checkAndUpdatePacks } from '../../server/lib/catalogPack/updater';

const prewarm = vi.fn(async () => {});

function entry(tier: string, version: string) {
  return {
    tier, version, archiveUrl: 'a', manifestUrl: 'm', manifestSigUrl: 's',
    archiveSha256: 'a'.repeat(64), archiveBytes: 10, totalObjects: 5, minAppVersion: '1.0.0', updatedAt: '2026-01-01',
  };
}

function remoteIndex(...tiers: Array<[string, string]>) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-01-01', tiers: tiers.map(([t, v]) => entry(t, v)) }));
}

function installed(...tiers: Array<[string, string]>) {
  m.getAllPackStates.mockReturnValue(tiers.map(([tier, version]) => ({ tier, version, objectCount: 1, installedAt: 'x' })));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.verify.mockReturnValue(true);
  m.fetchText.mockResolvedValue('sig');
  m.prefetchStatus.mockReturnValue({ running: false });
  m.install.mockResolvedValue(undefined);
});

describe('checkAndUpdatePacks', () => {
  it('starts the initial download when nothing is installed, and does not fetch the index', async () => {
    m.getAllPackStates.mockReturnValue([]);
    await checkAndUpdatePacks(prewarm);
    expect(m.startPrefetch).toHaveBeenCalledWith({ packsOnly: true });
    expect(m.fetchJson).not.toHaveBeenCalled();
  });

  it('does not start a second download when the prefetch job is already running', async () => {
    m.getAllPackStates.mockReturnValue([]);
    m.prefetchStatus.mockReturnValue({ running: true });
    await checkAndUpdatePacks(prewarm);
    expect(m.startPrefetch).not.toHaveBeenCalled();
  });

  it('installs nothing when every installed tier is current', async () => {
    installed(['messier', '3'], ['caldwell', '2']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '3'], ['caldwell', '2']));
    await checkAndUpdatePacks(prewarm);
    expect(m.install).not.toHaveBeenCalled();
  });

  it('installs only the tiers whose version differs', async () => {
    installed(['messier', '3'], ['caldwell', '2']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '4'], ['caldwell', '2']));
    await checkAndUpdatePacks(prewarm);
    expect(m.install).toHaveBeenCalledTimes(1);
    expect(m.install.mock.calls[0][0]).toEqual(['messier']);
    expect(m.install.mock.calls[0][2]).toBe(prewarm);
  });

  it('also installs a tier that is in the index but was never installed', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '3'], ['sharpless', '1']));
    await checkAndUpdatePacks(prewarm);
    expect(m.install.mock.calls[0][0]).toEqual(['sharpless']);
  });

  it('ignores an installed tier the remote index no longer lists', async () => {
    installed(['messier', '3'], ['extended', '1']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '3']));
    await checkAndUpdatePacks(prewarm);
    expect(m.install).not.toHaveBeenCalled();
  });

  it('refuses an index with a bad signature', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '9']));
    m.verify.mockReturnValue(false);
    await checkAndUpdatePacks(prewarm);
    expect(m.install).not.toHaveBeenCalled();
  });

  it('refuses an index that does not parse as a PackIndex', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockResolvedValue(Buffer.from(JSON.stringify({ schemaVersion: 2, tiers: [] })));
    await expect(checkAndUpdatePacks(prewarm)).resolves.toBeUndefined();
    expect(m.install).not.toHaveBeenCalled();
  });

  it('defers while the prefetch job is running', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '4']));
    m.prefetchStatus.mockReturnValue({ running: true });
    await checkAndUpdatePacks(prewarm);
    expect(m.install).not.toHaveBeenCalled();
  });

  it('swallows a network failure', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockRejectedValue(new Error('ECONNRESET'));
    await expect(checkAndUpdatePacks(prewarm)).resolves.toBeUndefined();
    expect(m.install).not.toHaveBeenCalled();
  });

  it('swallows an install failure', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '4']));
    m.install.mockRejectedValue(new Error('disk full'));
    await expect(checkAndUpdatePacks(prewarm)).resolves.toBeUndefined();
  });

  it('collapses overlapping calls into one run', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '4']));
    let release!: () => void;
    m.install.mockReturnValue(new Promise<void>(r => { release = r; }));

    const a = checkAndUpdatePacks(prewarm);
    const b = checkAndUpdatePacks(prewarm);
    await vi.waitFor(() => expect(m.install).toHaveBeenCalled());
    release();
    await Promise.all([a, b]);

    expect(m.install).toHaveBeenCalledTimes(1);
    expect(m.fetchJson).toHaveBeenCalledTimes(1);
  });

  it('runs again once the previous run has finished', async () => {
    installed(['messier', '3']);
    m.fetchJson.mockResolvedValue(remoteIndex(['messier', '4']));
    await checkAndUpdatePacks(prewarm);
    await checkAndUpdatePacks(prewarm);
    expect(m.install).toHaveBeenCalledTimes(2);
  });
});
