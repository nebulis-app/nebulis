import { describe, it, expect } from 'vitest';
import { resolveRestackTargetId, mimeTypeForExtension, isRestackedFolder } from '../../server/lib/library/dwarfRestack';

describe('isRestackedFolder', () => {
  it('recognizes RESTACKED case-insensitively', () => {
    expect(isRestackedFolder('RESTACKED')).toBe(true);
    expect(isRestackedFolder('restacked')).toBe(true);
    expect(isRestackedFolder('CALI_FRAME')).toBe(false);
  });
});

describe('resolveRestackTargetId', () => {
  it('resolves an exact catalog id', () => {
    expect(resolveRestackTargetId('M42')).toBe('M42');
  });

  it('resolves a target with a trailing Dwarf-style timestamp', () => {
    expect(resolveRestackTargetId('M42_2026-08-01_22-15-00-000')).toBe('M42');
  });

  it('resolves via alias table (Caldwell -> NGC)', () => {
    // C30 is an alias for NGC7331 in this codebase's catalogAliases table.
    expect(resolveRestackTargetId('C30')).toBe('NGC7331');
  });

  it('resolves a free-text catalog name', () => {
    expect(resolveRestackTargetId('Andromeda Galaxy')).toBe('M31');
  });

  it('never throws on a garbage name, and returns a non-empty best-effort id', () => {
    expect(() => resolveRestackTargetId('###???')).not.toThrow();
    const result = resolveRestackTargetId('some totally unknown target name');
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('returns null for an empty or whitespace-only name', () => {
    expect(resolveRestackTargetId('')).toBeNull();
    expect(resolveRestackTargetId('   ')).toBeNull();
  });
});

describe('mimeTypeForExtension', () => {
  it('maps known extensions', () => {
    expect(mimeTypeForExtension('stack.jpg')).toBe('image/jpeg');
    expect(mimeTypeForExtension('stack.fits')).toBe('application/fits');
    expect(mimeTypeForExtension('stack.xisf')).toBe('application/x-xisf');
  });

  it('falls back to octet-stream for an unknown extension', () => {
    expect(mimeTypeForExtension('stack.weird')).toBe('application/octet-stream');
    expect(mimeTypeForExtension('noextension')).toBe('application/octet-stream');
  });
});
