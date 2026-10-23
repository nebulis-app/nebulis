import { describe, it, expect } from 'vitest';
import { hasEnhancedWhatsNew, versionSeries, ENHANCED_WHATS_NEW } from '../../src/components/help/whatsNewRegistry';

describe('whatsNewRegistry', () => {
  it('reduces a version to its major.minor series', () => {
    expect(versionSeries('2.2.0')).toBe('2.2');
    expect(versionSeries('2.1.2')).toBe('2.1');
    expect(versionSeries('nonsense')).toBe('nonsense');
  });

  it('has a reel for the 2.0 and 2.2 series and no other', () => {
    expect(Object.keys(ENHANCED_WHATS_NEW).sort()).toEqual(['2.0', '2.2']);
  });

  it('opens the 2.2 reel for any 2.2.x and falls back to the changelog for 2.1.x', () => {
    expect(hasEnhancedWhatsNew('2.2.0')).toBe(true);
    expect(hasEnhancedWhatsNew('2.2.3')).toBe(true);
    expect(hasEnhancedWhatsNew('2.1.2')).toBe(false);
    expect(hasEnhancedWhatsNew(null)).toBe(false);
  });
});
