import { describe, it, expect, afterEach } from 'vitest';
import { getSettingsData, updateSettingsData } from '../../server/lib/telescopes';

afterEach(() => updateSettingsData({ objectPageLayout: 'media' }));

describe('objectPageLayout setting', () => {
  it('defaults to the combined layout', () => {
    expect(getSettingsData().objectPageLayout).toBe('media');
  });

  it('round-trips the classic layout', () => {
    updateSettingsData({ objectPageLayout: 'nights' });
    expect(getSettingsData().objectPageLayout).toBe('nights');
  });

  it('falls back to the default for an unknown value instead of storing it', () => {
    updateSettingsData({ objectPageLayout: 'nights' });
    updateSettingsData({ objectPageLayout: 'grid' });
    expect(getSettingsData().objectPageLayout).toBe('media');
  });

  it('keeps the other settings when only the layout changes', () => {
    updateSettingsData({ groupCatalogCompanions: false });
    updateSettingsData({ objectPageLayout: 'media' });
    expect(getSettingsData().groupCatalogCompanions).toBe(false);
    updateSettingsData({ groupCatalogCompanions: true });
  });
});
