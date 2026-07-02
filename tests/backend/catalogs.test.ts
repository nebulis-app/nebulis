import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── classifyType logic (extracted for unit testing) ───────────────────────────
// Mirror the same classification function from the route so we can test it
// without spinning up Express.

type ObjectClass = 'galaxy' | 'nebula' | 'cluster' | 'other';

function classifyType(type: string | undefined): ObjectClass {
  const t = (type ?? '').toLowerCase();
  if (t.includes('galaxy') || t.includes('gal') || t === 'g') return 'galaxy';
  if (
    t.includes('nebula') || t.includes('neb') || t.includes('planetary') ||
    t.includes('supernova') || t.includes('remnant') || t === 'pn' || t === 'snr'
  ) return 'nebula';
  if (
    t.includes('cluster') || t.includes('cl') || t.includes('asterism') ||
    t === 'oc' || t === 'gc' || t === 'ocl' || t === 'gcl'
  ) return 'cluster';
  return 'other';
}

describe('classifyType', () => {
  it('classifies galaxies', () => {
    expect(classifyType('Galaxy')).toBe('galaxy');
    expect(classifyType('spiral galaxy')).toBe('galaxy');
    expect(classifyType('Gal')).toBe('galaxy');
  });

  it('classifies nebulae', () => {
    expect(classifyType('Emission Nebula')).toBe('nebula');
    expect(classifyType('Planetary Nebula')).toBe('nebula');
    expect(classifyType('Supernova Remnant')).toBe('nebula');
    expect(classifyType('SNR')).toBe('nebula');
    expect(classifyType('PN')).toBe('nebula');
  });

  it('classifies clusters', () => {
    expect(classifyType('Open Cluster')).toBe('cluster');
    expect(classifyType('Globular Cluster')).toBe('cluster');
    expect(classifyType('OC')).toBe('cluster');
    expect(classifyType('GC')).toBe('cluster');
    expect(classifyType('Asterism')).toBe('cluster');
  });

  it('classifies unknown types as other', () => {
    expect(classifyType('Double Star')).toBe('other');
    expect(classifyType('')).toBe('other');
    expect(classifyType(undefined)).toBe('other');
  });
});

// ── Catalog data integrity checks ────────────────────────────────────────────
import { getCatalogEntry } from '../../server/data/catalog';

describe('Messier catalog entries', () => {
  it('has a resolvable entry for every M1–M110', () => {
    const missing: string[] = [];
    for (let n = 1; n <= 110; n++) {
      const id = `M${n}`;
      const entry = getCatalogEntry(id);
      if (!entry) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it('M42 resolves to Orion Nebula', () => {
    const e = getCatalogEntry('M42');
    expect(e?.name).toBe('Orion Nebula');
  });

  it('M31 resolves to Andromeda Galaxy', () => {
    const e = getCatalogEntry('M31');
    expect(e?.name).toMatch(/andromeda/i);
  });

  it('M45 resolves to Pleiades', () => {
    const e = getCatalogEntry('M45');
    expect(e?.name).toMatch(/pleiad/i);
  });

  it('all 110 entries have id, name and type', () => {
    for (let n = 1; n <= 110; n++) {
      const e = getCatalogEntry(`M${n}`);
      expect(e?.id?.trim().length).toBeGreaterThan(0);
      expect(e?.name?.trim().length).toBeGreaterThan(0);
      expect(e?.type?.trim().length).toBeGreaterThan(0);
    }
  });
});
