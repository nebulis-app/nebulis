import { describe, it, expect } from 'vitest';
import { getCatalogEntry, searchCatalog, getAllCatalogEntries } from '../../server/data/catalog';

describe('catalog data', () => {
  describe('getAllCatalogEntries', () => {
    it('returns a non-empty array', () => {
      const entries = getAllCatalogEntries();
      expect(entries.length).toBeGreaterThan(40);
    });

    it('each entry has required fields with non-whitespace content', () => {
      // Previously paired `typeof === 'string'` (which TS already enforces)
      // with `length > 0` (which passes for '  '). Trim-then-check actually
      // proves the value is content, not whitespace.
      const entries = getAllCatalogEntries();
      for (const entry of entries) {
        expect(entry.id.trim().length).toBeGreaterThan(0);
        expect(entry.name.trim().length).toBeGreaterThan(0);
        expect(entry.type.trim().length).toBeGreaterThan(0);
        expect(entry.constellation.trim().length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe('string'); // may be empty
      }
    });
  });

  describe('getCatalogEntry', () => {
    it('finds M42 (Orion Nebula)', () => {
      const entry = getCatalogEntry('M42');
      // Next-line `entry!.name` would throw on undefined; the explicit
      // `toBeDefined` was redundant. Use `?.` so the assertion narrows
      // implicitly.
      expect(entry?.name).toBe('Orion Nebula');
      expect(entry?.constellation).toBe('Orion');
      expect(entry?.type).toContain('Nebula');
    });

    it('finds NGC7000 (North America Nebula)', () => {
      const entry = getCatalogEntry('NGC7000');
      expect(entry?.name).toBe('North America Nebula');
    });

    it('finds IC434 (Horsehead Nebula)', () => {
      const entry = getCatalogEntry('IC434');
      expect(entry?.name).toBe('Horsehead Nebula');
    });

    it('is case-insensitive', () => {
      const lower = getCatalogEntry('m42');
      const upper = getCatalogEntry('M42');
      // toEqual on both sides catches the "both undefined" case anyway, but
      // adding a real value check ensures the test would fail if lookup
      // started returning undefined for both casings (regression direction).
      expect(lower?.name).toBe('Orion Nebula');
      expect(upper).toEqual(lower);
      expect(getCatalogEntry('ngc7000')?.name).toBe('North America Nebula');
    });

    it('resolves Seestar solar and lunar folder aliases', () => {
      expect(getCatalogEntry('solar')?.name).toBe('The Sun');
      expect(getCatalogEntry('lunar')?.name).toBe('The Moon');
    });

    it('returns undefined for unknown IDs', () => {
      expect(getCatalogEntry('NOTREAL123')).toBeUndefined();
    });
  });

  describe('searchCatalog', () => {
    it('searches by ID', () => {
      const results = searchCatalog('M42');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.id === 'M42')).toBe(true);
    });

    it('searches by name', () => {
      const results = searchCatalog('Orion');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.name === 'Orion Nebula')).toBe(true);
    });

    it('searches by constellation', () => {
      const results = searchCatalog('Cygnus');
      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    it('searches by type', () => {
      const results = searchCatalog('Spiral Galaxy');
      expect(results.length).toBeGreaterThanOrEqual(5);
    });

    it('returns empty for no match', () => {
      const results = searchCatalog('xyznotfound');
      expect(results).toHaveLength(0);
    });

    it('is case-insensitive', () => {
      const r1 = searchCatalog('orion');
      const r2 = searchCatalog('ORION');
      expect(r1.length).toBe(r2.length);
    });
  });
});
