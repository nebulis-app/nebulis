import { describe, it, expect } from 'vitest';
import { filterRecommendations } from '../../src/lib/filterRecommendations';

// ─── Emission nebulae ──────────────────────────────────────────────────────

describe('filterRecommendations — emission nebulae', () => {
  it('recommends Ha/dual and SHO for "Emission Nebula"', () => {
    const r = filterRecommendations('Emission Nebula');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('sho');
  });

  it('is case-insensitive', () => {
    expect(filterRecommendations('EMISSION NEBULA').color).toBe('ha-dual');
  });
});

// ─── Emission/Reflection hybrids ──────────────────────────────────────────

describe('filterRecommendations — emission/reflection hybrids', () => {
  it('recommends Ha/dual and Ha+OIII for "Emission/Reflection Nebula"', () => {
    const r = filterRecommendations('Emission/Reflection Nebula');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('ha-oiii');
  });

  it('matches even when words appear in either order', () => {
    const r = filterRecommendations('Reflection/Emission Nebula');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('ha-oiii');
  });
});

// ─── Reflection nebulae ───────────────────────────────────────────────────

describe('filterRecommendations — reflection nebulae', () => {
  it('recommends broadband for a pure "Reflection Nebula"', () => {
    const r = filterRecommendations('Reflection Nebula');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('lrgb');
  });
});

// ─── Planetary nebulae ────────────────────────────────────────────────────

describe('filterRecommendations — planetary nebulae', () => {
  it('recommends Ha/dual and OIII+Ha for "Planetary Nebula"', () => {
    const r = filterRecommendations('Planetary Nebula');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('oiii-ha');
  });
});

// ─── Supernova remnants ───────────────────────────────────────────────────

describe('filterRecommendations — supernova remnants', () => {
  it('recommends Ha/dual and SHO for "Supernova Remnant"', () => {
    const r = filterRecommendations('Supernova Remnant');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('sho');
  });
});

// ─── Dark nebulae ─────────────────────────────────────────────────────────

describe('filterRecommendations — dark nebulae', () => {
  it('recommends Ha/dual and Ha+OIII for "Dark Nebula"', () => {
    const r = filterRecommendations('Dark Nebula');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('ha-oiii');
  });
});

// ─── Generic nebulae ──────────────────────────────────────────────────────

describe('filterRecommendations — generic nebula', () => {
  it('recommends narrowband for a plain "Nebula" type', () => {
    const r = filterRecommendations('Nebula');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('ha-oiii');
  });
});

// ─── Clusters ─────────────────────────────────────────────────────────────

describe('filterRecommendations — clusters', () => {
  it('recommends broadband for "Open Cluster"', () => {
    const r = filterRecommendations('Open Cluster');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('lrgb');
  });

  it('recommends broadband for "Globular Cluster"', () => {
    const r = filterRecommendations('Globular Cluster');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('lrgb');
  });

  it('recommends narrowband for "Cluster + Nebula"', () => {
    const r = filterRecommendations('Cluster + Nebula');
    expect(r.color).toBe('ha-dual');
    expect(r.mono).toBe('sho');
  });
});

// ─── Galaxies ─────────────────────────────────────────────────────────────

describe('filterRecommendations — galaxies', () => {
  it('recommends broadband LRGB / luminance for "Galaxy"', () => {
    const r = filterRecommendations('Galaxy');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('luminance');
  });

  it('matches sub-types containing the word "galaxy"', () => {
    const r = filterRecommendations('Spiral Galaxy');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('luminance');
  });

  it('handles "Barred Spiral Galaxy"', () => {
    const r = filterRecommendations('Barred Spiral Galaxy');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('luminance');
  });

  it('handles "Galaxy Group"', () => {
    const r = filterRecommendations('Galaxy Group');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('luminance');
  });
});

// ─── Double stars ─────────────────────────────────────────────────────────

describe('filterRecommendations — double stars', () => {
  it('recommends no filter for "Double Star"', () => {
    const r = filterRecommendations('Double Star');
    expect(r.color).toBe('no-filter');
    expect(r.mono).toBe('no-filter');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe('filterRecommendations — edge cases', () => {
  it('returns a broadband default for null', () => {
    const r = filterRecommendations(null);
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('lrgb');
  });

  it('returns a broadband default for undefined', () => {
    const r = filterRecommendations(undefined);
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('lrgb');
  });

  it('returns a broadband default for an empty string', () => {
    const r = filterRecommendations('');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('lrgb');
  });

  it('returns a broadband default for an unknown type ("Other")', () => {
    const r = filterRecommendations('Other');
    expect(r.color).toBe('no-filter-lrgb');
    expect(r.mono).toBe('lrgb');
  });
});
