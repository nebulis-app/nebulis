import { describe, it, expect } from 'vitest';
import { queryString, queryNumber, contentDispositionHeader } from '../../server/lib/queryHelpers';

describe('queryString', () => {
  it('returns a plain string value unchanged', () => {
    expect(queryString('M42')).toBe('M42');
  });

  it('takes the first element of a string array', () => {
    expect(queryString(['M42', 'M43'])).toBe('M42');
  });

  it('returns undefined for a non-string, non-array value', () => {
    expect(queryString(42)).toBeUndefined();
    expect(queryString({ nested: 'M42' })).toBeUndefined();
  });

  it('returns undefined for an empty array or an array of non-strings', () => {
    expect(queryString([])).toBeUndefined();
    expect(queryString([{ a: 1 }])).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(queryString(undefined)).toBeUndefined();
  });
});

describe('queryNumber', () => {
  it('parses a numeric string', () => {
    expect(queryNumber('42')).toBe(42);
  });

  it('parses a numeric string from a string array', () => {
    expect(queryNumber(['3.5', '7'])).toBe(3.5);
  });

  it('returns undefined for a non-numeric string', () => {
    expect(queryNumber('not-a-number')).toBeUndefined();
  });

  it('returns undefined when queryString itself returns undefined', () => {
    expect(queryNumber(undefined)).toBeUndefined();
    expect(queryNumber({ nested: 1 })).toBeUndefined();
  });

  it('accepts numeric edge cases: leading/trailing space, sign, decimal-only', () => {
    expect(queryNumber(' 12 ')).toBe(12);
    expect(queryNumber('-5')).toBe(-5);
    expect(queryNumber('.5')).toBe(0.5);
  });
});

describe('contentDispositionHeader', () => {
  it('builds an attachment header with both the ASCII fallback and the RFC 5987 filename*', () => {
    const header = contentDispositionHeader('attachment', 'M42.zip');
    expect(header).toBe(`attachment; filename="M42.zip"; filename*=UTF-8''M42.zip`);
  });

  it('builds an inline header', () => {
    const header = contentDispositionHeader('inline', 'Light_001.fit');
    expect(header).toMatch(/^inline;/);
  });

  it('strips double-quotes and backslashes from the ASCII fallback', () => {
    const header = contentDispositionHeader('attachment', 'weird"name\\.zip');
    expect(header).toContain('filename="weird_name_.zip"');
    // The RFC 5987 filename* form still carries the encoded original bytes —
    // only the ASCII fallback is sanitized.
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('weird"name\\.zip')}`);
  });

  it('strips control characters, including CRLF, from the ASCII fallback', () => {
    const header = contentDispositionHeader('attachment', 'evil\r\nSet-Cookie: x=1.zip');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="evil__Set-Cookie: x=1.zip"');
  });

  it('percent-encodes Unicode file names in the filename* parameter', () => {
    const header = contentDispositionHeader('attachment', 'Andromeda_Ω.zip');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('Andromeda_Ω.zip')}`);
  });

  it('leaves an ordinary ASCII filename with no special characters untouched', () => {
    const header = contentDispositionHeader('attachment', 'session-2026-06-21.zip');
    expect(header).toBe(
      `attachment; filename="session-2026-06-21.zip"; filename*=UTF-8''session-2026-06-21.zip`,
    );
  });
});
