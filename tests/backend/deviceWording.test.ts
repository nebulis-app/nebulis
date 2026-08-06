import { describe, it, expect, vi } from 'vitest';

// Redirect DATA_DIR before any server module loads: importing the import
// pipeline for friendlyImportError pulls in the DB.
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-wording-test-'));
});

import { deviceNoun, isGenericShare, offlineAdvice } from '../../server/lib/deviceWording.js';
import { unreachableMessage } from '../../server/lib/smbReachability.js';
import { friendlyImportError } from '../../server/lib/library/import.js';
import type { TelescopeProfile } from '../../server/lib/telescopes.js';

describe('deviceWording', () => {
  it('calls the "other" kind a server, not a telescope', () => {
    expect(isGenericShare('other')).toBe(true);
    expect(deviceNoun('other')).toBe('server');
  });

  it('calls every real telescope kind a telescope', () => {
    for (const kind of ['seestar-s50', 'seestar-s30', 'dwarf-3', 'dwarf-2', 'dwarf-mini'] as const) {
      expect(isGenericShare(kind)).toBe(false);
      expect(deviceNoun(kind)).toBe('telescope');
    }
  });

  it('falls back to telescope wording when the kind is unknown', () => {
    // Ad-hoc profiles built by routes may not carry a kind. Telescope is the
    // safer default: it is what the overwhelming majority of profiles are.
    expect(deviceNoun(undefined)).toBe('telescope');
    expect(deviceNoun(null)).toBe('telescope');
  });

  it('does not tell a NAS owner to check its Wi-Fi or battery', () => {
    expect(offlineAdvice('other')).not.toMatch(/powered on|Wi-Fi/i);
    expect(offlineAdvice('seestar-s50')).toMatch(/powered on/i);
  });
});

describe('unreachableMessage', () => {
  // The reported bug: a mistyped address on a custom SMB share reported a
  // missing telescope, sending the user to look at hardware they do not have.
  it('names a custom SMB share a server, and says what to check', () => {
    const message = unreachableMessage('10.0.1.5', 'other');
    expect(message).toBe(
      'The server at 10.0.1.5 is not reachable on the network (port 445). '
      + 'Check the address is right and that the server is on and sharing over SMB.',
    );
    expect(message).not.toMatch(/telescope/i);
  });

  it('still names a real telescope a telescope', () => {
    const message = unreachableMessage('192.168.1.50', 'seestar-s50');
    expect(message).toContain('The telescope at 192.168.1.50 is not reachable');
    expect(message).toMatch(/powered on/i);
  });

  it('always names the host and the port it tried', () => {
    for (const kind of ['other', 'dwarf-3'] as const) {
      expect(unreachableMessage('10.0.1.5', kind)).toContain('10.0.1.5');
      expect(unreachableMessage('10.0.1.5', kind)).toContain('port 445');
    }
  });
});

describe('friendlyImportError', () => {
  const profile = (over: Partial<TelescopeProfile>): TelescopeProfile =>
    ({ id: 't1', name: 'MyNAS', kind: 'other', hostname: '10.0.1.5', ...over }) as TelescopeProfile;

  it('gives a custom SMB share advice that applies to a NAS', () => {
    const message = friendlyImportError(new Error('EHOSTUNREACH'), profile({}));
    expect(message).toBe(
      'MyNAS is not reachable on the network. '
      + 'Check the address is right and that the server is on and sharing over SMB.',
    );
  });

  it('keeps telescope advice for a telescope', () => {
    const message = friendlyImportError(
      new Error('EHOSTUNREACH'),
      profile({ kind: 'seestar-s50', name: 'SeeStar' }),
    );
    expect(message).toMatch(/powered on and connected to the same network/i);
  });

  it('does not blame a NAS for not being booted when the share name is wrong', () => {
    const message = friendlyImportError(new Error('NT_STATUS_BAD_NETWORK_NAME'), profile({}));
    expect(message).toMatch(/check the SMB share name/i);
    expect(message).not.toMatch(/fully booted/i);
  });

  it('tells a telescope owner to check the device is booted for the same error', () => {
    const message = friendlyImportError(
      new Error('NT_STATUS_BAD_NETWORK_NAME'),
      profile({ kind: 'dwarf-3', name: 'Dwarf' }),
    );
    expect(message).toMatch(/fully booted/i);
  });

  it('falls back to a kind-appropriate noun when the profile has no name', () => {
    expect(friendlyImportError(new Error('EHOSTUNREACH'), profile({ name: undefined })))
      .toMatch(/^the server is not reachable/);
  });

  it('passes an unrecognised error through untouched', () => {
    // Support still needs the raw signal for anything not in the table.
    expect(friendlyImportError(new Error('something odd'), profile({}))).toBe('something odd');
  });
});
