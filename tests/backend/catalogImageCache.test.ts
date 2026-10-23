import { describe, it, expect } from 'vitest';
import { catalogImageCacheControl } from '../../server/lib/catalogImageCache';

describe('catalog image Cache-Control', () => {
  it('keeps a final Hubble or Wikipedia picture for a year and never revalidates it', () => {
    for (const source of ['hubble', 'wiki'] as const) {
      const cc = catalogImageCacheControl(source);
      expect(cc).toContain('max-age=31536000');
      expect(cc).toContain('immutable');
    }
  });

  it('holds a DSS2 plate for 30 days, since a catalog pack can still replace it under the same URL', () => {
    const cc = catalogImageCacheControl('dss2');
    expect(cc).toContain('max-age=2592000');
    expect(cc).not.toContain('immutable');
  });
});
