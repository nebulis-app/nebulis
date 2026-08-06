import { describe, it, expect } from 'vitest';
import { validateHostAddress } from '../../server/lib/smb.shared.js';
import { parseFtpHost } from '../../server/lib/smb.ftp.js';
import { hostAddressError } from '../../src/lib/hostAddress';

describe('validateHostAddress', () => {
  it('accepts a plain IPv4 address', () => {
    expect(validateHostAddress('10.0.1.5')).toBe('10.0.1.5');
  });

  it('accepts a hostname and an FQDN, including the root dot', () => {
    expect(validateHostAddress('seestar')).toBe('seestar');
    expect(validateHostAddress('seestar.local')).toBe('seestar.local');
    expect(validateHostAddress('nas.home.example.com.')).toBe('nas.home.example.com.');
  });

  it('accepts the underscores in an mDNS service name', () => {
    // The share-name tests use this exact host, so rejecting `_` here would
    // make the two fields disagree about the same machine.
    expect(validateHostAddress('UNAS-Pro._smb._tcp.local')).toBe('UNAS-Pro._smb._tcp.local');
  });

  it('accepts an explicit port, which FTP transports use', () => {
    expect(validateHostAddress('192.168.88.1:2121')).toBe('192.168.88.1:2121');
  });

  it('accepts IPv6, bare and bracketed with a port', () => {
    expect(validateHostAddress('fe80::1')).toBe('fe80::1');
    expect(validateHostAddress('[fe80::1]:2121')).toBe('[fe80::1]:2121');
  });

  it('trims surrounding whitespace', () => {
    expect(validateHostAddress('  10.0.1.5  ')).toBe('10.0.1.5');
  });

  it('rejects an empty address', () => {
    expect(() => validateHostAddress('')).toThrow(/required/i);
    expect(() => validateHostAddress(null)).toThrow(/required/i);
  });

  // The bug from the screenshot: host and share typed into one field. It looked
  // saved, then every connection failed against a machine named "10.0.1.5/SeeStar/".
  it('rejects a host with the share appended, and says how to split it', () => {
    expect(() => validateHostAddress('10.0.1.5/SeeStar/'))
      .toThrow('The address cannot contain a slash. Put "10.0.1.5" here and "SeeStar" in the SMB Share Name field.');
  });

  it('rejects a trailing slash on its own', () => {
    // No share half to name, so the advice is omitted rather than invented.
    expect(() => validateHostAddress('10.0.1.5/')).toThrow('The address cannot contain a slash.');
  });

  it('rejects a full smb:// URL and says how to split it', () => {
    expect(() => validateHostAddress('smb://10.0.1.5/SeeStar'))
      .toThrow('Enter the address only, not a full smb:// URL. Put "10.0.1.5" here and "SeeStar" in the SMB Share Name field.');
  });

  it('rejects other URL schemes too', () => {
    expect(() => validateHostAddress('ftp://192.168.88.1')).toThrow(/not a full ftp:\/\/ URL/);
  });

  it('rejects a UNC path', () => {
    expect(() => validateHostAddress('\\\\10.0.1.5\\SeeStar'))
      .toThrow('Enter the address only, not a full \\\\server\\share path. Put "10.0.1.5" here and "SeeStar" in the SMB Share Name field.');
  });

  it('rejects a backslash as firmly as a forward slash', () => {
    expect(() => validateHostAddress('10.0.1.5\\SeeStar')).toThrow(/cannot contain a slash/);
  });

  it('rejects an embedded username and points at the right field', () => {
    expect(() => validateHostAddress('admin@10.0.1.5'))
      .toThrow('The address cannot contain a username. Put "10.0.1.5" here and "admin" in the Username field.');
  });

  it('rejects spaces', () => {
    expect(() => validateHostAddress('my seestar')).toThrow(/cannot contain spaces/);
  });

  it('rejects a port that is not a number or is out of range', () => {
    expect(() => validateHostAddress('10.0.1.5:abc')).toThrow(/not a valid port number/);
    expect(() => validateHostAddress('10.0.1.5:0')).toThrow(/not a valid port number/);
    expect(() => validateHostAddress('10.0.1.5:70000')).toThrow(/not a valid port number/);
  });

  it('rejects characters that cannot appear in a hostname', () => {
    expect(() => validateHostAddress('10.0.1.5;reboot')).toThrow(/not a valid IP address or hostname/);
    expect(() => validateHostAddress('host!name')).toThrow(/not a valid IP address or hostname/);
  });

  it('rejects a label that starts or ends with a hyphen', () => {
    expect(() => validateHostAddress('-seestar')).toThrow(/not a valid IP address or hostname/);
    expect(() => validateHostAddress('seestar-.local')).toThrow(/not a valid IP address or hostname/);
  });
});

// The address field feeds parseFtpHost at connection time. If the validator
// accepted something parseFtpHost splits differently, a profile could save and
// then connect somewhere else.
describe('accepted addresses survive parseFtpHost unchanged', () => {
  it.each([
    ['192.168.88.1', '192.168.88.1', 21],
    ['192.168.88.1:2121', '192.168.88.1', 2121],
    ['[fe80::1]:2121', 'fe80::1', 2121],
    ['dwarf.local', 'dwarf.local', 21],
  ])('%j parses to host %j port %i', (input, host, port) => {
    expect(validateHostAddress(input)).toBe(input);
    expect(parseFtpHost(input)).toEqual({ host, port });
  });
});

// Hand-synced copy, no monorepo (see the same note in shareName.test.ts). If
// the two disagree the UI either blocks a value the server accepts or waves
// through one it rejects.
describe('client and server host validation agree', () => {
  const accepted = [
    '10.0.1.5',
    'seestar',
    'seestar.local',
    'nas.home.example.com.',
    'UNAS-Pro._smb._tcp.local',
    '192.168.88.1:2121',
    'fe80::1',
    '[fe80::1]:2121',
    '  10.0.1.5  ',
  ];
  const rejected = [
    '10.0.1.5/SeeStar/',
    '10.0.1.5/',
    '10.0.1.5\\SeeStar',
    'smb://10.0.1.5/SeeStar',
    'ftp://192.168.88.1',
    '\\\\10.0.1.5\\SeeStar',
    'admin@10.0.1.5',
    'my seestar',
    '10.0.1.5:abc',
    '10.0.1.5:70000',
    '10.0.1.5;reboot',
    '-seestar',
  ];

  it.each(accepted)('both accept %j', (input) => {
    expect(() => validateHostAddress(input)).not.toThrow();
    expect(hostAddressError(input)).toBeNull();
  });

  it.each(rejected)('both reject %j', (input) => {
    expect(() => validateHostAddress(input)).toThrow();
    expect(hostAddressError(input)).toEqual(expect.any(String));
  });

  it('reports the same message for the case users actually hit', () => {
    const input = '10.0.1.5/SeeStar/';
    let serverMessage = '';
    try { validateHostAddress(input); } catch (err) { serverMessage = (err as Error).message; }
    expect(hostAddressError(input)).toBe(serverMessage);
  });

  it('the client treats an empty field as the caller\'s problem, the server as an error', () => {
    // Deliberate asymmetry, matching shareNameError: the form has its own
    // required-field handling and should not show a red error on a field the
    // user has not filled in yet.
    expect(hostAddressError('')).toBeNull();
    expect(() => validateHostAddress('')).toThrow(/required/i);
  });
});
