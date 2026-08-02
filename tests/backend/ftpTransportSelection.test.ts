/**
 * Transport ranking and profile defaults once `ftp` joined the union.
 *
 * The ranking matters because a Dwarf owner typically has both an FTP
 * transport (always configured) and a USB one (only usable while the cable is
 * plugged in). Picking the wrong one silently means either a failed import or
 * a slow one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addTransport,
  selectActiveTransport,
  invalidateActiveTransportCache,
  TRANSPORT_KINDS,
} from '../../server/lib/telescopeTransports';
import { createProfile } from '../../server/lib/telescopes';
import db from '../../server/lib/db';
import os from 'os';

/** A directory that definitely exists, so a 'local' transport counts as
 *  "mounted" for selectActiveTransport's stat check. */
const MOUNTED_PATH = os.tmpdir();

function freshProfile(kind: 'dwarf-3' | 'seestar-s50') {
  const profile = createProfile({ name: `Test ${kind}`, kind, hostname: '192.168.88.1' });
  // createProfile seeds one transport from the profile's own fields. Clear it
  // so each case starts from a known set.
  db.prepare('DELETE FROM telescopeTransports WHERE profileId = ?').run(profile.id);
  invalidateActiveTransportCache(profile.id);
  return profile;
}

describe('ftp transport kind', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM telescopeTransports').run();
    db.prepare('DELETE FROM telescopeProfiles').run();
    invalidateActiveTransportCache();
  });

  it('is part of the transport union', () => {
    expect(TRANSPORT_KINDS).toContain('ftp');
  });

  it('defaults Dwarf profiles to ftp, since they serve no SMB share', () => {
    const profile = createProfile({ name: 'Dwarf', kind: 'dwarf-3', hostname: '192.168.88.1' });
    expect(profile.connectionType).toBe('ftp');
  });

  it('leaves Seestar profiles on smb', () => {
    const profile = createProfile({ name: 'Seestar', kind: 'seestar-s50', hostname: '10.0.0.5' });
    expect(profile.connectionType).toBe('smb');
  });

  it('seeds a Dwarf profile with an ftp transport carrying no share name', () => {
    const profile = createProfile({ name: 'Dwarf', kind: 'dwarf-3', hostname: '192.168.88.1' });
    const active = selectActiveTransport(profile.id);
    expect(active?.kind).toBe('ftp');
    expect(active?.hostname).toBe('192.168.88.1');
    // "EMMC Images" on an FTP row would be meaningless noise at best and a
    // misread path at worst.
    expect(active?.shareName).toBe('');
  });
});

describe('selectActiveTransport ranking', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM telescopeTransports').run();
    db.prepare('DELETE FROM telescopeProfiles').run();
    invalidateActiveTransportCache();
  });

  it('picks ftp when it is the only transport', () => {
    const profile = freshProfile('dwarf-3');
    addTransport(profile.id, { kind: 'ftp', hostname: '192.168.88.1' });
    expect(selectActiveTransport(profile.id)?.kind).toBe('ftp');
  });

  it('prefers a mounted USB volume over ftp', () => {
    const profile = freshProfile('dwarf-3');
    addTransport(profile.id, { kind: 'ftp', hostname: '192.168.88.1' });
    addTransport(profile.id, { kind: 'local', localPath: MOUNTED_PATH });
    // USB is faster and does not touch the network, so a plugged-in cable wins.
    expect(selectActiveTransport(profile.id)?.kind).toBe('local');
  });

  it('falls back to ftp when the USB volume is not mounted', () => {
    const profile = freshProfile('dwarf-3');
    addTransport(profile.id, { kind: 'ftp', hostname: '192.168.88.1' });
    addTransport(profile.id, { kind: 'local', localPath: '/definitely/not/mounted/anywhere' });
    expect(selectActiveTransport(profile.id)?.kind).toBe('ftp');
  });

  it('prefers ftp over a stale smb row on the same profile', () => {
    const profile = freshProfile('dwarf-3');
    addTransport(profile.id, { kind: 'smb', hostname: '192.168.88.1' });
    addTransport(profile.id, { kind: 'ftp', hostname: '192.168.88.1' });
    // A Dwarf serves no SMB share, so an smb row here is a leftover from an
    // earlier edit and would fail every import if it were chosen.
    expect(selectActiveTransport(profile.id)?.kind).toBe('ftp');
  });

  it('ignores an ftp transport with no hostname', () => {
    const profile = freshProfile('dwarf-3');
    addTransport(profile.id, { kind: 'ftp', hostname: '' });
    addTransport(profile.id, { kind: 'smb', hostname: '10.0.0.9' });
    expect(selectActiveTransport(profile.id)?.kind).toBe('smb');
  });

  it('returns null when nothing is addressable', () => {
    const profile = freshProfile('dwarf-3');
    addTransport(profile.id, { kind: 'ftp', hostname: '' });
    expect(selectActiveTransport(profile.id)).toBeNull();
  });
});
