/**
 * FTP telescope transport (server/lib/smb.ftp.ts).
 *
 * Exercised against a real in-process FTP server (tests/backend/helpers/
 * fakeFtpServer.ts) rather than mocks, because the parts most likely to break
 * are protocol-level: passive-mode transfers, `ls -l` listing parsing, and the
 * per-model storage-root probe. A mocked basic-ftp would test none of them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ftpListDir,
  ftpGetFile,
  ftpCopyFileTo,
  ftpPutFile,
  ftpDelete,
  ftpTestConnection,
  parseFtpHost,
  invalidateFtpCache,
  closeAllFtpConnections,
  FTP_PORT,
} from '../../server/lib/smb.ftp';
import { startFakeFtpServer, type FakeFtpServer, type FakeDir } from './helpers/fakeFtpServer';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/** Storage layout a Dwarf 3 serves: Astronomy sits at the FTP root. */
function dwarf3Tree(): FakeDir {
  return {
    Astronomy: {
      'DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345': {
        'shotsInfo.json': Buffer.from('{"target":"M42"}'),
        'stacked-0001.fits': Buffer.from('FITS-STACK-DATA'),
      },
    },
    'Normal Photos': {},
  };
}

/** Storage layout a Dwarf II serves: everything under a /DWARF_II prefix. */
function dwarf2Tree(): FakeDir {
  return {
    DWARF_II: {
      Astronomy: {
        'DWARF_RAW_NGC7000_2026-01-02_21-05-30-345': {
          'stacked.jpg': Buffer.from('JPEG-BYTES'),
        },
      },
    },
  };
}

let server: FakeFtpServer | null = null;

/** Profile pointed at the fake server. The `host:port` form is how the
 *  transport addresses a non-standard port. */
function profileFor(s: FakeFtpServer) {
  return { hostname: `127.0.0.1:${s.port}`, username: 'Anonymous', password: '' };
}

afterEach(async () => {
  closeAllFtpConnections();
  invalidateFtpCache();
  if (server) {
    await server.close();
    server = null;
  }
});

describe('parseFtpHost', () => {
  it('defaults to port 21 when no suffix is given', () => {
    expect(parseFtpHost('192.168.88.1')).toEqual({ host: '192.168.88.1', port: FTP_PORT });
  });

  it('splits a :port suffix', () => {
    expect(parseFtpHost('192.168.88.1:2121')).toEqual({ host: '192.168.88.1', port: 2121 });
  });

  it('trims surrounding whitespace', () => {
    expect(parseFtpHost('  dwarf.local:21  ')).toEqual({ host: 'dwarf.local', port: 21 });
  });

  it('leaves a bare IPv6 literal intact rather than eating its last group', () => {
    expect(parseFtpHost('fe80::1')).toEqual({ host: 'fe80::1', port: FTP_PORT });
  });

  it('reads the port off a bracketed IPv6 literal', () => {
    expect(parseFtpHost('[fe80::1]:2121')).toEqual({ host: 'fe80::1', port: 2121 });
  });

  it('treats an out-of-range port as part of the hostname', () => {
    expect(parseFtpHost('host:99999')).toEqual({ host: 'host:99999', port: FTP_PORT });
  });
});

describe('ftpListDir', () => {
  it('lists a directory on a Dwarf 3 layout, with types and sizes', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const entries = await ftpListDir('Astronomy', profileFor(server));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345',
      type: 'dir',
    });
  });

  it('reports files with their byte size', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const entries = await ftpListDir(
      'Astronomy/DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345',
      profileFor(server),
    );
    const stacked = entries.find(e => e.name === 'stacked-0001.fits');
    expect(stacked).toMatchObject({ type: 'file', size: 'FITS-STACK-DATA'.length });
  });

  it('auto-detects the /DWARF_II prefix so callers pass the same relative path', async () => {
    server = await startFakeFtpServer(dwarf2Tree());
    // The walker asks for "Astronomy" regardless of model; the transport is
    // what knows a Dwarf II keeps it under /DWARF_II.
    const entries = await ftpListDir('Astronomy', profileFor(server));
    expect(entries.map(e => e.name)).toEqual(['DWARF_RAW_NGC7000_2026-01-02_21-05-30-345']);
  });

  it('returns empty for a missing directory instead of throwing', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    await expect(ftpListDir('Astronomy/does-not-exist', profileFor(server))).resolves.toEqual([]);
  });

  it('rejects path traversal before anything reaches the wire', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    await expect(ftpListDir('Astronomy/../../etc', profileFor(server))).rejects.toThrow('Path traversal');
  });

  it('rejects CRLF in a path, which would inject a second FTP command', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    await expect(ftpListDir('Astronomy\r\nDELE evil.fits', profileFor(server)))
      .rejects.toThrow('Invalid characters');
  });

  // The path guard's character set was widened to match smb.shared.ts's
  // sanitizePath (used by the SMB/smbclient transports) for consistency,
  // even though basic-ftp sends structured protocol commands rather than a
  // shell string, so these were never a live injection vector for FTP.
  it.each(['`backtick`', '$(subshell)', 'semi;colon', 'pipe|char', 'quote"char'])(
    'rejects the widened SMB-aligned character set: %s',
    async (segment) => {
      server = await startFakeFtpServer(dwarf3Tree());
      await expect(ftpListDir(`Astronomy/${segment}`, profileFor(server)))
        .rejects.toThrow('Invalid characters');
    },
  );

  it('throws a clear error when no hostname is configured', async () => {
    await expect(ftpListDir('Astronomy', { hostname: '' })).rejects.toThrow('no hostname configured');
  });
});

describe('ftpGetFile', () => {
  it('downloads a whole file', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const buf = await ftpGetFile(
      'Astronomy/DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345/stacked-0001.fits',
      undefined,
      profileFor(server),
    );
    expect(buf.toString()).toBe('FITS-STACK-DATA');
  });

  it('honours maxBytes for header-only reads', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const buf = await ftpGetFile(
      'Astronomy/DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345/stacked-0001.fits',
      4,
      profileFor(server),
    );
    expect(buf).toHaveLength(4);
    expect(buf.toString()).toBe('FITS');
  });

  it('reports a missing file as an error rather than empty bytes', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    await expect(ftpGetFile('Astronomy/nope.fits', undefined, profileFor(server)))
      .rejects.toThrow('File not found on telescope');
  });
});

describe('ftpCopyFileTo', () => {
  it('streams a file straight to disk', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nebulis-ftp-test-'));
    const dest = path.join(dir, 'stacked.fits');
    try {
      await ftpCopyFileTo(
        'Astronomy/DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345/stacked-0001.fits',
        dest,
        profileFor(server),
      );
      expect(await fs.readFile(dest, 'utf8')).toBe('FITS-STACK-DATA');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves no partial file behind when the download fails', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nebulis-ftp-test-'));
    const dest = path.join(dir, 'missing.fits');
    try {
      await expect(ftpCopyFileTo('Astronomy/nope.fits', dest, profileFor(server))).rejects.toThrow();
      // A leftover zero-byte file would be indistinguishable from a good
      // import to everything downstream.
      await expect(fs.access(dest)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ftpPutFile and ftpDelete', () => {
  it('uploads a file (this is how .nebulis.dat gets written)', async () => {
    const tree = dwarf3Tree();
    server = await startFakeFtpServer(tree);
    await ftpPutFile('.nebulis.dat', Buffer.from('{"deviceId":"abc"}'), profileFor(server));
    expect((tree['.nebulis.dat'] as Buffer).toString()).toBe('{"deviceId":"abc"}');
  });

  it('deletes a file', async () => {
    const tree = dwarf3Tree();
    server = await startFakeFtpServer(tree);
    const sessionDir = 'Astronomy/DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345';
    await ftpDelete(`${sessionDir}/shotsInfo.json`, profileFor(server));
    const entries = await ftpListDir(sessionDir, profileFor(server));
    expect(entries.map(e => e.name)).not.toContain('shotsInfo.json');
  });

  it('treats deleting an already-missing file as success', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    await expect(ftpDelete('Astronomy/gone.fits', profileFor(server))).resolves.toBeUndefined();
  });
});

describe('ftpTestConnection', () => {
  it('reports the detected storage root for a Dwarf 3', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const result = await ftpTestConnection(profileFor(server), 'Astronomy');
    expect(result.remoteRoot).toBe('');
    expect(result.entries).toHaveLength(1);
  });

  it('reports the DWARF_II prefix for a Dwarf II', async () => {
    server = await startFakeFtpServer(dwarf2Tree());
    const result = await ftpTestConnection(profileFor(server), 'Astronomy');
    expect(result.remoteRoot).toBe('DWARF_II');
    expect(result.entries).toHaveLength(1);
  });

  it('falls back to the FTP root on an unrecognised layout', async () => {
    server = await startFakeFtpServer({ SomethingElse: { 'a.txt': Buffer.from('x') } });
    const result = await ftpTestConnection(profileFor(server), '');
    expect(result.remoteRoot).toBe('');
    expect(result.entries.map(e => e.name)).toEqual(['SomethingElse']);
  });
});

describe('connection handling', () => {
  it('reuses one control connection across sequential operations', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const profile = profileFor(server);
    await ftpListDir('Astronomy', profile);
    await ftpListDir('Astronomy', profile);
    await ftpListDir('Astronomy', profile);
    // A fresh login per operation would be three sessions; the pool is what
    // keeps an import sweep from paying a TCP handshake plus login per file.
    expect(server.sessionCount).toBe(1);
  });

  it('serialises concurrent operations onto the single control socket', async () => {
    server = await startFakeFtpServer(dwarf3Tree());
    const profile = profileFor(server);
    const sessionDir = 'Astronomy/DWARF3_RAW_M42_EXP_30_GAIN_80_2026-01-02_21-05-30-345';
    // The import pipeline fires downloads concurrently. Interleaving commands
    // on one FTP control socket corrupts every response, so these must queue.
    const results = await Promise.all([
      ftpGetFile(`${sessionDir}/stacked-0001.fits`, undefined, profile),
      ftpGetFile(`${sessionDir}/shotsInfo.json`, undefined, profile),
      ftpListDir(sessionDir, profile),
    ]);
    expect((results[0] as Buffer).toString()).toBe('FITS-STACK-DATA');
    expect((results[1] as Buffer).toString()).toBe('{"target":"M42"}');
    expect(server.sessionCount).toBe(1);
    // The reachability probe is single-flighted too, so a burst of concurrent
    // operations opens one probe socket, not one per operation.
    expect(server.socketCount).toBe(2);
  });

  it('fails fast with a clear message when nothing is listening', async () => {
    // Port 1 is reserved and never has an FTP server on it.
    await expect(ftpListDir('Astronomy', { hostname: '127.0.0.1:1' }))
      .rejects.toThrow('not answering on FTP');
  });
});
