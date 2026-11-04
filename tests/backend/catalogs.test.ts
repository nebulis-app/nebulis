import { describe, it, expect } from 'vitest';

// ── classifyType ──────────────────────────────────────────────────────────────
// Imports the real route function (server/routes/catalogs.ts) rather than a
// hand-copied mirror. The mirror this replaced still tested shorthand aliases
// (gal/oc/gc/pn/snr) that were deliberately dropped when classifyType was
// rewritten to delegate to classOfType/objectCategories.ts — it kept passing
// against its own stale copy while asserting behavior the app no longer has.
import { classifyType } from '../../server/routes/catalogs';

describe('classifyType', () => {
  it('classifies galaxies', () => {
    expect(classifyType('Galaxy')).toBe('galaxy');
    expect(classifyType('spiral galaxy')).toBe('galaxy');
  });

  it('classifies nebulae', () => {
    expect(classifyType('Emission Nebula')).toBe('nebula');
    expect(classifyType('Planetary Nebula')).toBe('nebula');
    expect(classifyType('Supernova Remnant')).toBe('nebula');
  });

  it('classifies clusters', () => {
    expect(classifyType('Open Cluster')).toBe('cluster');
    expect(classifyType('Globular Cluster')).toBe('cluster');
    expect(classifyType('Asterism')).toBe('cluster');
  });

  it('classifies unknown types, and shorthand catalog codes, as other', () => {
    expect(classifyType('Double Star')).toBe('other');
    expect(classifyType('')).toBe('other');
    expect(classifyType(undefined)).toBe('other');
  });

  it('no longer recognizes the removed shorthand aliases (gal/oc/gc/pn/snr)', () => {
    // These matched in an earlier version and were removed because none of
    // them appear in the catalog's real type strings, and 'cl' also matched
    // "Dark Cloud". Locking this in so a future revert is a visible diff here,
    // not a silent regression.
    expect(classifyType('Gal')).toBe('other');
    expect(classifyType('OC')).toBe('other');
    expect(classifyType('GC')).toBe('other');
    expect(classifyType('PN')).toBe('other');
    expect(classifyType('SNR')).toBe('other');
  });
});

// ── Catalog data integrity checks ────────────────────────────────────────────
import { getCatalogEntry } from '../../server/lib/catalogLookup';

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

  // M42 -> Orion Nebula is already asserted in catalog.test.ts against the
  // same getCatalogEntry; not repeated here.

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
