import { describe, it, expect, vi, afterEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    Promise.resolve(execFileMock(...args.slice(0, -1))).then(
      result => cb(null, result ?? { stdout: '', stderr: '' }),
      err => cb(err instanceof Error ? err : new Error(String(err))),
    );
  },
}));

const tcpProbeMock = vi.fn();
vi.mock('../../server/lib/smbReachability', () => ({
  tcpProbe: (...args: unknown[]) => tcpProbeMock(...args),
  SMB_PORT: 445,
}));

import {
  resolveNetworkLibraryPath,
  ensureNetworkLibraryConnected,
  testNetworkLibraryConnection,
  invalidateNetworkLibraryReachability,
  forgetWindowsNetworkLibrarySession,
  NETWORK_MOUNT_DIR,
  type NetworkLibraryConfig,
} from '../../server/lib/libraryNetwork';

function cfg(overrides: Partial<NetworkLibraryConfig> = {}): NetworkLibraryConfig {
  return { host: 'nas.local', share: 'Photos', domain: '', username: 'alice', password: 'hunter2', subpath: 'Nebulis', ...overrides };
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const ORIGINAL_PLATFORM = process.platform;

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  execFileMock.mockReset();
  tcpProbeMock.mockReset();
  // The reachability probe caches per-host for 5s; clear it so a result from
  // one test (e.g. "unreachable") can't bleed into the next for the same host.
  invalidateNetworkLibraryReachability();
  forgetWindowsNetworkLibrarySession();
});

describe('resolveNetworkLibraryPath', () => {
  it('builds a UNC path on win32', () => {
    setPlatform('win32');
    expect(resolveNetworkLibraryPath(cfg())).toBe('\\\\nas.local\\Photos\\Nebulis');
  });

  it('clamps a traversal subpath to the share root on win32, never escaping it', () => {
    // Node's own win32 path normalization already treats \\host\share as an
    // anchor that '..' can't climb past (like a drive root) — this asserts
    // that behavior holds so the defense-in-depth check never needs to fire.
    setPlatform('win32');
    const resolved = resolveNetworkLibraryPath(cfg({ subpath: '..\\..\\escape' }));
    expect(resolved.toLowerCase().startsWith('\\\\nas.local\\photos')).toBe(true);
  });

  it('resolves to the fixed mount dir on darwin, appending the subpath', () => {
    setPlatform('darwin');
    expect(resolveNetworkLibraryPath(cfg({ subpath: '' }))).toBe(NETWORK_MOUNT_DIR);
    expect(resolveNetworkLibraryPath(cfg({ subpath: 'Nebulis' }))).toBe(`${NETWORK_MOUNT_DIR}/Nebulis`);
  });

  it('rejects a traversal subpath on darwin', () => {
    setPlatform('darwin');
    expect(() => resolveNetworkLibraryPath(cfg({ subpath: '../../etc' }))).toThrow();
  });

  it('never throws on unsupported platforms (e.g. linux/Docker): returns a UNC-style display path', () => {
    // getLibraryDir() calls this unconditionally, including from read-only
    // endpoints (GET /storage/library-location) and the reset recovery route
    // whose whole purpose is unsticking a config this platform can't otherwise
    // act on. Platform support is enforced at the connect step
    // (ensureNetworkLibraryConnected) and surfaced via networkLibrarySupported,
    // not here. See resolveNetworkLibraryPath's doc comment.
    setPlatform('linux');
    expect(resolveNetworkLibraryPath(cfg())).toBe('\\\\nas.local\\Photos\\Nebulis');
  });
});

describe('ensureNetworkLibraryConnected', () => {
  it('returns false and skips the native call when the host is unreachable', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(null); // unreachable
    await expect(ensureNetworkLibraryConnected(cfg())).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns false when host/share are not configured yet', async () => {
    setPlatform('darwin');
    await expect(ensureNetworkLibraryConnected(cfg({ host: '' }))).resolves.toBe(false);
    expect(tcpProbeMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns true (reachable) but swallows a native connect failure rather than throwing', async () => {
    setPlatform('win32');
    tcpProbeMock.mockResolvedValue(12); // reachable
    execFileMock.mockRejectedValue(new Error('net use failed'));
    await expect(ensureNetworkLibraryConnected(cfg())).resolves.toBe(true);
  });

  it('runs net use once for repeated connects with the same credentials on Windows', async () => {
    setPlatform('win32');
    tcpProbeMock.mockResolvedValue(12);
    await ensureNetworkLibraryConnected(cfg());
    await ensureNetworkLibraryConnected(cfg());
    await ensureNetworkLibraryConnected(cfg());
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects on Windows when the password changes', async () => {
    setPlatform('win32');
    tcpProbeMock.mockResolvedValue(12);
    await ensureNetworkLibraryConnected(cfg());
    await ensureNetworkLibraryConnected(cfg({ password: 'new-secret' }));
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('retries net use on Windows after a failed attempt', async () => {
    setPlatform('win32');
    tcpProbeMock.mockResolvedValue(12);
    execFileMock.mockRejectedValueOnce(new Error('net use failed'));
    await ensureNetworkLibraryConnected(cfg());
    await ensureNetworkLibraryConnected(cfg());
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('testNetworkLibraryConnection', () => {
  it('requires a server address', async () => {
    const result = await testNetworkLibraryConnection(cfg({ host: '' }));
    expect(result).toEqual({ ok: false, reason: 'Enter a server address.' });
  });

  it('requires a share name', async () => {
    const result = await testNetworkLibraryConnection(cfg({ share: '' }));
    expect(result).toEqual({ ok: false, reason: 'Enter a share name.' });
  });

  it('rejects unsupported platforms before touching the network', async () => {
    setPlatform('linux');
    const result = await testNetworkLibraryConnection(cfg());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not supported on this platform/);
    expect(tcpProbeMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable host without attempting a native connect', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(null);
    const result = await testNetworkLibraryConnection(cfg());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not reachable/);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
