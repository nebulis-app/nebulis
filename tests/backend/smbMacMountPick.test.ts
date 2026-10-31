/**
 * Two Seestars share a share name (`EMMC Images`) and a login (`guest`), so when one is open in Finder, the other must not
 * take over its mount, while one telescope mounted by IP by Nebulis and by Bonjour name by Finder must still be recognised.
 */
import { describe, it, expect } from 'vitest';
import { parseMountLine, compareHosts, pickExistingMount, type MountedShare } from '../../server/lib/smb.mac';

/** A resolver that knows only what the test tells it; anything else does not resolve. */
const dnsOf = (table: Record<string, string[]>) => async (host: string) => {
  const name = host.replace('._smb._tcp', '').toLowerCase();
  return /^[\d.]+$/.test(name) ? [name] : table[name] ?? [];
};

const mounted = (host: string, mountPoint = `/Volumes/${host}`): MountedShare => ({ user: 'guest', host, share: 'EMMC Images', mountPoint });

describe('reading a row of the mount table', () => {
  it('reads a Finder mount made by Bonjour name', () => {
    expect(parseMountLine('//guest@Seestar._smb._tcp.local/EMMC%20Images on /Volumes/EMMC Images (smbfs, nodev, nosuid, mounted by brent)'))
      .toEqual({ user: 'guest', host: 'Seestar._smb._tcp.local', share: 'EMMC Images', mountPoint: '/Volumes/EMMC Images' });
  });
  it('ignores rows that are not SMB shares', () => {
    expect(parseMountLine('/dev/disk3s1 on / (apfs, local, journaled)')).toBeNull();
  });
});

describe('telling hosts apart', () => {
  it('knows one machine by its name and by its address', async () => {
    const resolve = dnsOf({ 'seestar.local': ['192.168.1.50'] });
    expect(await compareHosts('Seestar._smb._tcp.local', '192.168.1.50', resolve)).toBe('same');
    expect(await compareHosts('SEESTAR.local', 'seestar.local', resolve)).toBe('same');
  });
  it('says different only when both resolve and share no address', async () => {
    const resolve = dnsOf({ 'seestar.local': ['192.168.1.50'], 'seestar-2.local': ['192.168.1.51'] });
    expect(await compareHosts('seestar.local', 'seestar-2.local', resolve)).toBe('different');
    expect(await compareHosts('seestar.local', 'gone.local', resolve)).toBe('unknown');
  });
});

describe('choosing among shares that are already mounted', () => {
  it('takes the mount with the profile\'s own host', async () => {
    const picked = await pickExistingMount([mounted('192.168.1.51'), mounted('192.168.1.50', '/Volumes/mine')], '192.168.1.50', dnsOf({}));
    expect(picked).toBe('/Volumes/mine');
  });

  it('takes a Finder mount made by Bonjour name for a profile that holds the IP', async () => {
    const resolve = dnsOf({ 'seestar.local': ['192.168.1.50'] });
    expect(await pickExistingMount([mounted('Seestar._smb._tcp.local', '/Volumes/finder')], '192.168.1.50', resolve)).toBe('/Volumes/finder');
  });

  it('does not take another camera\'s mount', async () => {
    const resolve = dnsOf({ 'seestar.local': ['192.168.1.50'] });
    expect(await pickExistingMount([mounted('Seestar._smb._tcp.local')], '192.168.1.51', resolve)).toBeNull();
  });

  it('still takes the one mount whose host cannot be looked up, as before', async () => {
    expect(await pickExistingMount([mounted('Seestar._smb._tcp.local', '/Volumes/finder')], '192.168.1.50', dnsOf({}))).toBe('/Volumes/finder');
  });

  it('will not guess between two it cannot place', async () => {
    expect(await pickExistingMount([mounted('a.local'), mounted('b.local')], '192.168.1.50', dnsOf({}))).toBeNull();
  });

  it('prefers the one it can place over one that is provably someone else\'s', async () => {
    const resolve = dnsOf({ 'other.local': ['192.168.1.99'] });
    expect(await pickExistingMount([mounted('other.local'), mounted('unplaceable.local', '/Volumes/maybe')], '192.168.1.50', resolve)).toBe('/Volumes/maybe');
  });
});
