import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseShareName } from '../../server/lib/smb.shared.js';
import { shareNameError } from '../../src/lib/shareName';

describe('parseShareName', () => {
  it('treats a bare share as the share root', () => {
    expect(parseShareName('EMMC Images')).toEqual({ share: 'EMMC Images', subpath: '' });
  });

  it('splits a folder inside the share off the share itself', () => {
    expect(parseShareName('UNAS/MyWorks')).toEqual({ share: 'UNAS', subpath: 'MyWorks' });
  });

  it('keeps nested folders in the subpath', () => {
    expect(parseShareName('UNAS/astro/MyWorks')).toEqual({ share: 'UNAS', subpath: 'astro/MyWorks' });
  });

  it('normalises the backslashes Windows users paste', () => {
    expect(parseShareName('seestar\\myworks')).toEqual({ share: 'seestar', subpath: 'myworks' });
  });

  it('ignores surrounding whitespace and redundant slashes', () => {
    expect(parseShareName('  /UNAS//MyWorks/  ')).toEqual({ share: 'UNAS', subpath: 'MyWorks' });
  });

  it('rejects an empty field', () => {
    expect(() => parseShareName('')).toThrow(/required/i);
    expect(() => parseShareName(null)).toThrow(/required/i);
  });

  // The bug from the screenshot: a full URL pasted into the share field, whose
  // embedded host contradicts the Hostname field. It must not be guessed at.
  it('rejects a full smb:// URL and says how to split it', () => {
    expect(() => parseShareName('smb://UNAS-Pro._smb._tcp.local/UNAS/MyWorks'))
      .toThrow('Enter the share name only, not a full smb:// URL. Put "UNAS-Pro._smb._tcp.local" in the Hostname field and "UNAS/MyWorks" here.');
  });

  it('rejects a UNC path and says how to split it', () => {
    expect(() => parseShareName('\\\\10.0.1.5\\UNAS\\MyWorks'))
      .toThrow('Put "10.0.1.5" in the Hostname field and "UNAS/MyWorks" here.');
  });

  it('rejects other URL schemes too', () => {
    expect(() => parseShareName('cifs://host/share')).toThrow(/not a full cifs:\/\/ URL/);
  });

  it('rejects traversal in the subpath', () => {
    expect(() => parseShareName('UNAS/../../etc')).toThrow(/traversal/i);
  });

  it('rejects smbclient script injection in the subpath', () => {
    expect(() => parseShareName('UNAS/a"; del *; cd "')).toThrow(/Invalid characters/i);
  });

  it('allows a share name containing characters that are unsafe only in paths', () => {
    // Shares are argv elements / percent-encoded, never shell-interpolated, so
    // restricting them would break working profiles for no security gain.
    expect(parseShareName('C$')).toEqual({ share: 'C$', subpath: '' });
  });
});

describe('windows UNC guard', () => {
  // Mirrors toUncPath in smb.win.ts. The root used to be interpolated raw, so a
  // share field with a forward slash produced `\\host\share/sub` while the
  // joined path normalised to `\\host\share\sub\...`, failing the startsWith
  // check and reporting "Path traversal detected" for a legitimate path.
  function guardPasses(shareField: string, smbPath: string): boolean {
    const { share, subpath } = parseShareName(shareField);
    const root = path.win32.normalize(`\\\\10.0.1.5\\${share}`);
    const rel = path.win32.join(subpath.replace(/\//g, '\\'), smbPath.replace(/\//g, '\\'));
    const joined = path.win32.normalize(path.win32.join(root, rel));
    return joined.toLowerCase().startsWith(root.toLowerCase());
  }

  it('accepts a subpath given with a forward slash', () => {
    expect(guardPasses('seestar/myworks', 'Astronomy')).toBe(true);
  });

  it('accepts a subpath given with a backslash', () => {
    expect(guardPasses('seestar\\myworks', 'Astronomy')).toBe(true);
  });

  it('still accepts a plain share', () => {
    expect(guardPasses('EMMC Images', 'MyWorks')).toBe(true);
  });

  it('resolves the subpath into the final UNC path', () => {
    const { share, subpath } = parseShareName('seestar/myworks');
    const root = path.win32.normalize(`\\\\10.0.1.5\\${share}`);
    const joined = path.win32.normalize(path.win32.join(root, subpath, 'Astronomy'));
    expect(joined).toBe('\\\\10.0.1.5\\seestar\\myworks\\Astronomy');
  });
});

// The client validator exists so the Save button can block a bad value without
// a round-trip, but it is a hand-synced copy of parseShareName (no monorepo, so
// src/ cannot import server/). If the two ever disagree the UI either blocks a
// value the server accepts or waves through one it rejects. Pin them together.
describe('client and server share validation agree', () => {
  const accepted = [
    'EMMC Images',
    'UNAS/MyWorks',
    'UNAS/astro/MyWorks',
    'seestar\\myworks',
    '  /UNAS//MyWorks/  ',
    'C$',
  ];
  const rejected = [
    'smb://test',
    'smb://UNAS-Pro._smb._tcp.local/UNAS/MyWorks',
    'cifs://host/share',
    '\\\\10.0.1.5\\UNAS\\MyWorks',
    '//10.0.1.5/UNAS',
    'UNAS/../../etc',
    'UNAS/a"; del *; cd "',
  ];

  it.each(accepted)('both accept %j', (input) => {
    expect(() => parseShareName(input)).not.toThrow();
    expect(shareNameError(input)).toBeNull();
  });

  it.each(rejected)('both reject %j', (input) => {
    expect(() => parseShareName(input)).toThrow();
    expect(shareNameError(input)).toEqual(expect.any(String));
  });

  it('reports the same message for the case users actually hit', () => {
    const input = 'smb://UNAS-Pro._smb._tcp.local/UNAS/MyWorks';
    let serverMessage = '';
    try { parseShareName(input); } catch (err) { serverMessage = (err as Error).message; }
    expect(shareNameError(input)).toBe(serverMessage);
  });
});

// Real `mount` output on macOS. The previous findExistingMount compared the
// full mount URL (password included) against these lines; the table never
// carries a password, so the match could never succeed and macOS then failed
// the remount with "File exists".
describe('macOS mount table parsing', () => {
  interface MountedShare { user: string; host: string; share: string; mountPoint: string }
  function parseMountLine(line: string): MountedShare | null {
    const m = /^\/\/([^@/]+)@([^/]+)\/(\S+) on (.+?) \((.*)\)\s*$/.exec(line);
    if (!m || !m[5].startsWith('smbfs')) return null;
    return {
      user: decodeURIComponent(m[1].split(':')[0]),
      host: m[2],
      share: decodeURIComponent(m[3]),
      mountPoint: m[4],
    };
  }

  it('parses a Finder-mounted share', () => {
    expect(parseMountLine('//brent@Orion._smb._tcp.local/Seestar on /Volumes/Seestar (smbfs, nodev, nosuid, mounted by brent)'))
      .toEqual({ user: 'brent', host: 'Orion._smb._tcp.local', share: 'Seestar', mountPoint: '/Volumes/Seestar' });
  });

  it('strips the trailing colon from a guest mount we created ourselves', () => {
    const parsed = parseMountLine('//guest:@seestar.local/EMMC%20Images on /private/var/folders/T/nebulis-smb-Ez78uq (smbfs, nodev, nosuid)');
    expect(parsed?.user).toBe('guest');
    expect(parsed?.share).toBe('EMMC Images');
  });

  it('keeps only the username when a password is present', () => {
    expect(parseMountLine('//brent:hunter2@10.0.1.5/Seestar on /Volumes/Seestar (smbfs)')?.user).toBe('brent');
  });

  it('handles a mount point containing spaces', () => {
    expect(parseMountLine('//brent@host/EMMC%20Images on /Volumes/EMMC Images (smbfs, nodev)')?.mountPoint)
      .toBe('/Volumes/EMMC Images');
  });

  it('ignores non-smbfs filesystems', () => {
    expect(parseMountLine('/dev/disk3s1s1 on / (apfs, sealed, local, read-only)')).toBeNull();
  });

  it('finds the share the old URL comparison always missed', () => {
    const table = [
      '//brent@orion.local/TimeMachine-Brent on /Volumes/TimeMachine-Brent (smbfs, nodev, nosuid, mounted by brent)',
      '//brent@Orion._smb._tcp.local/Seestar on /Volumes/Seestar (smbfs, nodev, nosuid, mounted by brent)',
    ];
    // We hold the server as an IP; Finder mounted it by Bonjour name. Host
    // cannot be compared, so identity is share + username.
    const found = table.map(parseMountLine)
      .filter((m): m is MountedShare => !!m && m.share === 'Seestar' && m.user === 'brent');
    expect(found[0]?.mountPoint).toBe('/Volumes/Seestar');
  });
});

describe('mount error scrubbing', () => {
  function scrubUrl(text: string): string {
    return text.replace(/(\/\/[^:/@\s]+):[^@\s]*@/g, '$1:***@');
  }

  it('removes the password mount_smbfs echoes back in its error text', () => {
    const raw = 'Command failed: mount_smbfs //brent:s3cr3t!!@192.168.1.12/Seestar /tmp/x\n'
      + 'mount_smbfs: mount error: //brent:s3cr3t!!@192.168.1.12/Seestar: File exists\n';
    const scrubbed = scrubUrl(raw);
    expect(scrubbed).not.toContain('s3cr3t');
    expect(scrubbed).toContain('//brent:***@192.168.1.12/Seestar');
  });

  it('leaves an empty-password guest URL readable', () => {
    expect(scrubUrl('//guest:@seestar.local/EMMC%20Images')).toBe('//guest:***@seestar.local/EMMC%20Images');
  });
});
