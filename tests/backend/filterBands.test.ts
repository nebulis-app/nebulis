import { describe, it, expect } from 'vitest';
import { bandForObjectType, bandForFilterName } from '../../server/lib/filterBands';
import * as client from '../../src/lib/filterBands';

describe('bandForObjectType', () => {
  it('follows the filter recommendations: emission-type nebulae are narrowband', () => {
    for (const t of ['Emission Nebula', 'HII Region Nebula', 'Planetary Nebula', 'Supernova Remnant', 'Cluster with Nebula', 'Emission and Reflection Nebula', 'Nebula']) {
      expect(bandForObjectType(t), t).toBe('narrowband');
    }
    for (const t of ['Spiral Galaxy', 'Open Cluster', 'Globular Cluster', 'Reflection Nebula', 'Dark Nebula', '', null]) {
      expect(bandForObjectType(t), String(t)).toBe('broadband');
    }
  });
});

describe('bandForFilterName', () => {
  it('knows line filters, dual-band products and bandwidths', () => {
    for (const f of ['H', 'Ha', 'H-alpha', 'OIII', 'SII', 'D1', 'D2', 'L-eXtreme', 'ALP-T', 'Ha 7nm', 'SII/OIII', 'Dual band']) {
      expect(bandForFilterName(f), f).toBe('narrowband');
    }
  });

  it('knows broadband ones and admits what it cannot tell', () => {
    for (const f of ['L', 'Lum', 'R', 'RGB', 'UV/IR', 'IRCUT', 'L-Pro']) expect(bandForFilterName(f), f).toBe('broadband');
    expect(bandForFilterName('Filter 3')).toBeNull();
    expect(bandForFilterName(null)).toBeNull();
  });

  it('matches the browser copy', () => {
    for (const f of ['D2', 'L-eXtreme', 'RGB', 'Filter 3']) expect(client.bandForFilterName(f)).toBe(bandForFilterName(f));
    for (const t of ['Emission Nebula', 'Reflection Nebula', 'Spiral Galaxy']) expect(client.bandForObjectType(t)).toBe(bandForObjectType(t));
  });
});
