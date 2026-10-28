import { describe, it, expect } from 'vitest';
import {
  suggestIntegration,
  filterLine,
  meanSurfaceBrightness,
  brightnessClassFor,
  BASE_HOURS,
  REFERENCE_BORTLE,
  type SuggestionInput,
} from '../../src/lib/integrationSuggestion';

const base: SuggestionInput = {
  objectType: 'Spiral Galaxy',
  magnitude: 9,
  majorAxisArcmin: 10,
  bortle: REFERENCE_BORTLE,
  rig: 'mono',
  moon: 'dark',
  tier: 'standard',
};

const total = (over: Partial<SuggestionInput>) => suggestIntegration({ ...base, ...over }).totalHours;

describe('meanSurfaceBrightness', () => {
  it('matches the catalog objects the doc uses as worked examples', () => {
    expect(meanSurfaceBrightness(5.8, 16.5)).toBeCloseTo(20.5, 1); // M13
    expect(meanSurfaceBrightness(3.44, 177.83)).toBeCloseTo(23.3, 1); // M31
    expect(meanSurfaceBrightness(4, 90)).toBeCloseTo(22.4, 1); // M42
  });

  it('is null when either input is missing or unusable', () => {
    expect(meanSurfaceBrightness(null, 10)).toBeNull();
    expect(meanSurfaceBrightness(8, null)).toBeNull();
    expect(meanSurfaceBrightness(8, 0)).toBeNull();
    expect(meanSurfaceBrightness(Number.NaN, 10)).toBeNull();
  });

  it('gets fainter as the same light spreads over a larger object', () => {
    expect(meanSurfaceBrightness(8, 20)!).toBeGreaterThan(meanSurfaceBrightness(8, 5)!);
  });
});

describe('brightnessClassFor', () => {
  it('splits on the documented edges', () => {
    expect(brightnessClassFor(20.99)).toBe('bright');
    expect(brightnessClassFor(21.0)).toBe('moderate');
    expect(brightnessClassFor(22.49)).toBe('moderate');
    expect(brightnessClassFor(22.5)).toBe('faint');
    expect(brightnessClassFor(23.99)).toBe('faint');
    expect(brightnessClassFor(24.0)).toBe('very-faint');
  });
});

describe('suggestIntegration: object', () => {
  it('uses the base figure at the reference sky, dark Moon, standard tier', () => {
    const m31 = suggestIntegration({ ...base, objectType: 'Galaxy', magnitude: 3.44, majorAxisArcmin: 177.83 });
    expect(m31.basis.brightness).toBe('faint');
    expect(m31.basis.brightnessSource).toBe('surface-brightness');
    expect(m31.totalHours).toBe(BASE_HOURS.faint);
  });

  it('asks for less time on a bright compact object than a faint extended one', () => {
    const m13 = total({ objectType: 'Globular Cluster', magnitude: 5.8, majorAxisArcmin: 16.5 });
    const m31 = total({ objectType: 'Galaxy', magnitude: 3.44, majorAxisArcmin: 177.83 });
    expect(m13).toBeLessThan(m31);
  });

  it('halves the time for star-dominated types', () => {
    const cluster = suggestIntegration({ ...base, objectType: 'Open Cluster', magnitude: 6, majorAxisArcmin: 15 });
    expect(cluster.basis.factors.type).toBe(0.5);
    const nebula = suggestIntegration({ ...base, objectType: 'Emission Nebula', magnitude: 6, majorAxisArcmin: 15 });
    expect(nebula.basis.factors.type).toBe(1);
  });

  it('falls back to the type default when magnitude or size is missing', () => {
    const noSize = suggestIntegration({ ...base, objectType: 'Galaxy', majorAxisArcmin: null });
    expect(noSize.basis.brightnessSource).toBe('type-default');
    expect(noSize.basis.surfaceBrightness).toBeNull();
    expect(noSize.basis.brightness).toBe('faint');
    const pn = suggestIntegration({ ...base, objectType: 'Planetary Nebula', magnitude: null });
    expect(pn.basis.brightness).toBe('bright');
  });

  it('never throws on an unknown or empty type', () => {
    for (const objectType of [null, undefined, '', 'Unknown', 'Other']) {
      const s = suggestIntegration({ ...base, objectType, magnitude: null, majorAxisArcmin: null });
      expect(s.totalHours).toBeGreaterThan(0);
      expect(s.filters.length).toBeGreaterThan(0);
    }
  });
});

describe('suggestIntegration: sky', () => {
  it('grows monotonically with the Bortle class', () => {
    let prev = 0;
    for (let b = 1; b <= 9; b++) {
      const hours = total({ bortle: b, objectType: 'Galaxy', magnitude: 3.44, majorAxisArcmin: 177.83 });
      expect(hours).toBeGreaterThanOrEqual(prev);
      prev = hours;
    }
  });

  it('assumes the reference class when the site has none, and says so', () => {
    const s = suggestIntegration({ ...base, bortle: null });
    expect(s.basis.bortle).toBe(REFERENCE_BORTLE);
    expect(s.basis.bortleAssumed).toBe(true);
    expect(suggestIntegration({ ...base, bortle: 6 }).basis.bortleAssumed).toBe(false);
  });

  it('clamps an out-of-range class instead of indexing past the table', () => {
    expect(suggestIntegration({ ...base, bortle: 12 }).basis.bortle).toBe(9);
    expect(suggestIntegration({ ...base, bortle: 0 }).basis.bortle).toBe(1);
    expect(suggestIntegration({ ...base, bortle: 5.4 }).basis.bortle).toBe(5);
  });

  it('is damped for narrowband compared with broadband', () => {
    const bb = suggestIntegration({ ...base, objectType: 'Galaxy', bortle: 8 }).basis.factors.sky;
    const nb = suggestIntegration({ ...base, objectType: 'Emission Nebula', bortle: 8 }).basis.factors.sky;
    expect(nb).toBeLessThan(bb);
  });
});

describe('suggestIntegration: Moon', () => {
  it('costs nothing when the plan is dark', () => {
    expect(suggestIntegration({ ...base, moon: 'dark' }).basis.factors.moon).toBe(1);
  });

  it('orders dark < mixed < any', () => {
    const h = (moon: SuggestionInput['moon']) =>
      total({ moon, objectType: 'Galaxy', magnitude: 3.44, majorAxisArcmin: 177.83 });
    expect(h('dark')).toBeLessThan(h('mixed'));
    expect(h('mixed')).toBeLessThan(h('any'));
  });

  it('hurts broadband more than narrowband', () => {
    const bb = suggestIntegration({ ...base, objectType: 'Galaxy', moon: 'any' }).basis.factors.moon;
    const nb = suggestIntegration({ ...base, objectType: 'Emission Nebula', moon: 'any' }).basis.factors.moon;
    expect(bb).toBeGreaterThan(nb);
    expect(nb).toBeGreaterThan(1);
  });

  it('matters less under a bright sky, where it adds a smaller share', () => {
    const dark = suggestIntegration({ ...base, objectType: 'Galaxy', bortle: 2, moon: 'any' }).basis.factors.moon;
    const city = suggestIntegration({ ...base, objectType: 'Galaxy', bortle: 8, moon: 'any' }).basis.factors.moon;
    expect(dark).toBeGreaterThan(city);
  });
});

describe('suggestIntegration: tier and bounds', () => {
  it('doubles then doubles again across tiers', () => {
    const std = total({ tier: 'standard' });
    expect(total({ tier: 'deep' })).toBe(std * 2);
    expect(total({ tier: 'showpiece' })).toBe(std * 4);
  });

  it('never goes below one hour or above forty', () => {
    expect(total({ objectType: 'Open Cluster', magnitude: 3, majorAxisArcmin: 60, bortle: 1 })).toBeGreaterThanOrEqual(1);
    expect(total({
      objectType: 'Galaxy', magnitude: 15, majorAxisArcmin: 2, bortle: 9, moon: 'any', tier: 'showpiece',
    })).toBeLessThanOrEqual(40 + 2);
  });

  it('reports factors whose product reproduces the unrounded total', () => {
    const s = suggestIntegration({ ...base, bortle: 6, moon: 'mixed', tier: 'deep' });
    const f = s.basis.factors;
    const expected = f.base * f.type * f.sky * f.moon * f.tier;
    // Rounding to half hours per filter can move the sum by at most a step each.
    expect(Math.abs(s.totalHours - expected)).toBeLessThanOrEqual(0.5 * s.filters.length);
  });
});

describe('suggestIntegration: filter split', () => {
  const split = (objectType: string, rig: SuggestionInput['rig']) =>
    suggestIntegration({ ...base, objectType, rig, tier: 'showpiece' }).filters;

  it('gives a colour rig a single catch-all bucket', () => {
    for (const type of ['Galaxy', 'Emission Nebula', 'Double Star']) {
      const f = split(type, 'color');
      expect(f).toHaveLength(1);
      expect(f[0].filter).toBeNull();
    }
  });

  it('splits mono LRGB with luminance on top', () => {
    const f = split('Galaxy', 'mono');
    expect(f.map(x => x.filter)).toEqual(['L', 'R', 'G', 'B']);
    expect(f[0].hours).toBeGreaterThan(f[1].hours);
  });

  it('uses canonical filter names the library stores', () => {
    expect(split('Emission Nebula', 'mono').map(x => x.filter)).toEqual(['Ha', 'OIII', 'SII']);
    expect(split('Planetary Nebula', 'mono').map(x => x.filter)).toEqual(['OIII', 'Ha']);
  });

  it('follows the filter recommendation for the type', () => {
    expect(suggestIntegration({ ...base, objectType: 'Emission Nebula', rig: 'mono' }).basis.recommendation).toBe('sho');
    expect(suggestIntegration({ ...base, objectType: 'Galaxy', rig: 'color' }).basis.recommendation).toBe('no-filter-lrgb');
  });

  it('keeps every bucket a positive multiple of half an hour', () => {
    for (const rig of ['color', 'mono'] as const) {
      for (const tier of ['standard', 'deep', 'showpiece'] as const) {
        for (const f of suggestIntegration({ ...base, rig, tier }).filters) {
          expect(f.hours).toBeGreaterThanOrEqual(0.5);
          expect(f.hours * 2).toBe(Math.round(f.hours * 2));
        }
      }
    }
  });
});

describe('filterLine', () => {
  it('reads a line or colour through bandwidth, case and spelling', () => {
    expect(filterLine('Ha')).toBe('Ha');
    expect(filterLine('Ha 7nm')).toBe('Ha');
    expect(filterLine('H-alpha')).toBe('Ha');
    expect(filterLine('OIII 3nm')).toBe('OIII');
    expect(filterLine('S2')).toBe('SII');
    expect(filterLine('Luminance')).toBe('L');
    expect(filterLine('Red')).toBe('R');
  });

  it('is null for multi-band, light-pollution and unknown names', () => {
    for (const name of ['L-eXtreme', 'Duo-Band', 'SII/OIII', 'Optolong L-Pro', '', 'mystery']) {
      expect(filterLine(name)).toBeNull();
    }
  });
});

describe('suggestIntegration with a kit', () => {
  const emission = { ...base, objectType: 'Emission Nebula', magnitude: 6, majorAxisArcmin: 30 };
  const galaxy = { ...base, objectType: 'Galaxy', magnitude: 9, majorAxisArcmin: 10 };
  const inventory = (...filters: string[]) => ({ filters, inventory: true });
  const used = (...filters: string[]) => ({ filters, inventory: false });

  it('changes nothing without a kit or with an empty list, which means not said', () => {
    const plain = suggestIntegration({ ...emission, rig: 'mono' });
    expect(suggestIntegration({ ...emission, rig: 'mono', kit: null })).toEqual(plain);
    expect(suggestIntegration({ ...emission, rig: 'mono', kit: inventory() })).toEqual(plain);
    expect(plain.basis.fellBack).toBe(false);
    expect(plain.basis.missing).toEqual([]);
  });

  describe('colour camera', () => {
    it('puts a narrowband plan on the owned dual-band filter, by its own name', () => {
      const s = suggestIntegration({ ...emission, rig: 'color', kit: inventory('UV/IR cut', 'L-eXtreme') });
      expect(s.filters.map(f => f.filter)).toEqual(['L-eXtreme']);
      expect(s.basis.fellBack).toBe(false);
      expect(s.basis.band).toBe('narrowband');
    });

    it('settles for a lone Ha filter when there is no multi-band one', () => {
      expect(suggestIntegration({ ...emission, rig: 'color', kit: inventory('Ha 7nm') }).filters[0].filter).toBe('Ha 7nm');
    });

    it('falls back to broadband when the inventory has nothing narrowband, and says what was missing', () => {
      const s = suggestIntegration({ ...emission, rig: 'color', kit: inventory('UV/IR cut', 'Luminance') });
      expect(s.basis.fellBack).toBe(true);
      expect(s.basis.requested).toBe('ha-dual');
      expect(s.basis.recommendation).toBe('no-filter-lrgb');
      expect(s.basis.band).toBe('broadband');
      expect(s.basis.missing).toEqual(['dual-band']);
      expect(s.filters.map(f => f.filter)).toEqual([null]);
    });

    it('asks for more time once it has had to drop to broadband', () => {
      const withFilter = suggestIntegration({ ...emission, rig: 'color', bortle: 8, kit: inventory('L-eXtreme') });
      const without = suggestIntegration({ ...emission, rig: 'color', bortle: 8, kit: inventory('Luminance') });
      expect(without.totalHours).toBeGreaterThan(withFilter.totalHours);
    });

    it('only names the bucket from what a smart telescope has used, and never falls back', () => {
      expect(suggestIntegration({ ...emission, rig: 'color', kit: used('Duo-Band') }).filters[0].filter).toBe('Duo-Band');
      const unnamed = suggestIntegration({ ...emission, rig: 'color', kit: used('LP') });
      expect(unnamed.filters[0].filter).toBeNull();
      expect(unnamed.basis.fellBack).toBe(false);
      expect(unnamed.basis.recommendation).toBe('ha-dual');
    });

    it('leaves a broadband object alone', () => {
      const s = suggestIntegration({ ...galaxy, rig: 'color', kit: inventory('L-eXtreme') });
      expect(s.filters.map(f => f.filter)).toEqual([null]);
      expect(s.basis.fellBack).toBe(false);
    });
  });

  describe('mono camera', () => {
    it('plans only the lines owned and gives them the whole total', () => {
      const full = suggestIntegration({ ...emission, rig: 'mono' });
      const haOnly = suggestIntegration({ ...emission, rig: 'mono', kit: inventory('Ha') });
      expect(haOnly.filters.map(f => f.filter)).toEqual(['Ha']);
      expect(haOnly.totalHours).toBe(full.totalHours);
      expect(haOnly.basis.missing).toEqual(['OIII', 'SII']);
      expect(haOnly.basis.fellBack).toBe(false);
    });

    it('renormalises a partial palette', () => {
      const s = suggestIntegration({ ...emission, rig: 'mono', tier: 'showpiece', kit: inventory('Ha 3nm', 'S2') });
      expect(s.filters.map(f => f.filter)).toEqual(['Ha', 'SII']);
      expect(s.filters[0].hours).toBeGreaterThanOrEqual(s.filters[1].hours);
    });

    it('falls back to the owned broadband filters when none of the lines are owned', () => {
      const s = suggestIntegration({ ...emission, rig: 'mono', kit: inventory('L', 'R', 'G', 'B') });
      expect(s.basis.fellBack).toBe(true);
      expect(s.basis.recommendation).toBe('lrgb');
      expect(s.basis.band).toBe('broadband');
      expect(s.filters.map(f => f.filter)).toEqual(['L', 'R', 'G', 'B']);
    });

    it('falls back to one unnamed bucket when nothing owned fits at all', () => {
      const s = suggestIntegration({ ...galaxy, rig: 'mono', kit: inventory('Ha', 'OIII') });
      expect(s.basis.fellBack).toBe(true);
      expect(s.filters.map(f => f.filter)).toEqual([null]);
      expect(s.basis.missing).toEqual(['L', 'R', 'G', 'B']);
    });

    it('does not remove anything on the strength of a smart telescope\'s used names', () => {
      const s = suggestIntegration({ ...emission, rig: 'mono', kit: used('Ha') });
      expect(s.filters.map(f => f.filter)).toEqual(['Ha', 'OIII', 'SII']);
    });

    it('keeps every bucket a positive half hour however the kit cuts the plan', () => {
      for (const filters of [['Ha'], ['SII'], ['L'], ['Ha', 'OIII'], ['R', 'G']]) {
        for (const f of suggestIntegration({ ...emission, rig: 'mono', kit: inventory(...filters) }).filters) {
          expect(f.hours).toBeGreaterThanOrEqual(0.5);
          expect(f.hours * 2).toBe(Math.round(f.hours * 2));
        }
      }
    });
  });
});
