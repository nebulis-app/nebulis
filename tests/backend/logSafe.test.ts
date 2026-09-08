import { describe, it, expect } from 'vitest';
import { redactUrl } from '../../server/lib/logSafe';

describe('redactUrl', () => {
  it('returns the path unchanged when there is no query string', () => {
    expect(redactUrl('/api/v1/library/objects/M42')).toBe('/api/v1/library/objects/M42');
  });

  it('returns empty string for nullish input', () => {
    expect(redactUrl(undefined)).toBe('');
    expect(redactUrl(null)).toBe('');
    expect(redactUrl('')).toBe('');
  });

  it('redacts a signed download token', () => {
    const out = redactUrl('/library/download/objects/M42?t=abc.def.ghi');
    expect(out).toBe('/library/download/objects/M42?t=<redacted>');
    expect(out).not.toContain('abc.def.ghi');
  });

  it('redacts every sensitive key while keeping benign params', () => {
    const out = redactUrl('/x?token=secret1&size=200&apiKey=secret2&fov=1.5&signature=secret3');
    expect(out).not.toContain('secret1');
    expect(out).not.toContain('secret2');
    expect(out).not.toContain('secret3');
    expect(out).toContain('size=200');
    expect(out).toContain('fov=1.5');
  });

  it('matches sensitive keys case-insensitively', () => {
    const out = redactUrl('/x?APIKEY=nope&T=nope2');
    expect(out).not.toContain('nope');
  });

  it('leaves a query with no sensitive keys readable', () => {
    expect(redactUrl('/catalog/M42/image?source=dss2&size=400')).toBe(
      '/catalog/M42/image?source=dss2&size=400',
    );
  });

  it('drops an unparseable query rather than risk leaking it', () => {
    // URLSearchParams itself does not throw, but guard the contract anyway.
    const out = redactUrl('/x?a=b');
    expect(out).toBe('/x?a=b');
  });
});
