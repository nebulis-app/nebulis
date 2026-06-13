import { describe, it, expect } from 'vitest';
import { getCatalog, getById, search, filterCatalog } from '../../server/lib/dsoCatalog';

describe('dsoCatalog', () => {
  describe('getCatalog', () => {
    it('returns a non-empty array', () => {
      const catalog = getCatalog();
      expect(catalog.length).toBeGreaterThan(0);
    });

    it('each entry has required fields with the expected shape', () => {
      // Pin actual shapes. ids come from multiple source catalogs (M/NGC/IC/
      // ESO/HCG/H-numbered Caldwell/Sharpless), so the regex covers any of
      // those catalog-prefix + number patterns (including NED suffixes like
      // "IC1#NED3"). Previously `toBeTruthy` passed for any non-empty string
      // including 'x'.
      const CATALOG_TAG_RE = /^[A-Z]+\d+(?:[ -]?(?:NED\d+|[A-Z]?\d+))?$/;
      const catalog = getCatalog();
      for (const entry of catalog.slice(0, 50)) {
        expect(entry.id).toMatch(CATALOG_TAG_RE);
        expect(entry.ngcName).toMatch(CATALOG_TAG_RE);
        // Type values vary widely (Galaxy, Open Cluster, Emission Nebula, …)
        // so a regex would be brittle — but the string must be non-empty
        // post-trim, which `toBeTruthy` did not enforce ('  ' is truthy).
        expect(entry.type.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('getById', () => {
    it('finds M31 (Andromeda)', () => {
      const entry = getById('M31');
      expect(entry).toBeDefined();
      expect(entry!.id).toBe('M31');
      expect(entry!.name.toLowerCase()).toContain('andromeda');
    });

    it('is case-insensitive (m31 vs M31)', () => {
      const lower = getById('m31');
      const upper = getById('M31');
      expect(lower).toBeDefined();
      expect(upper).toBeDefined();
      expect(lower!.id).toBe(upper!.id);
    });

    it('handles spaces (NGC 0224 normalized)', () => {
      const withSpace = getById('NGC 0224');
      const without = getById('NGC0224');
      expect(withSpace).toBeDefined();
      expect(without).toBeDefined();
      expect(withSpace!.id).toBe(without!.id);
    });

    it('returns undefined for unknown id', () => {
      expect(getById('NOTREAL999')).toBeUndefined();
    });
  });

  describe('search', () => {
    it('returns results for "andromeda"', () => {
      const results = search('andromeda');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.id === 'M31')).toBe(true);
    });

    it('returns empty for gibberish', () => {
      const results = search('xzqwvnm999');
      expect(results).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      const results = search('galaxy', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('filterCatalog', () => {
    it('filters by constellation', () => {
      const { entries, total } = filterCatalog({ constellation: 'Andromeda' });
      expect(total).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.constellation?.toLowerCase()).toBe('andromeda');
      }
    });

    it('filters by maxMag', () => {
      const { entries, total } = filterCatalog({ maxMag: 6 });
      expect(total).toBeGreaterThan(0);
      for (const entry of entries) {
        if (entry.magnitude != null) {
          expect(entry.magnitude).toBeLessThanOrEqual(6);
        }
      }
    });

    it('returns total and paginated entries', () => {
      const full = filterCatalog({ limit: 1000 });
      const page = filterCatalog({ limit: 5, offset: 0 });
      expect(page.total).toBe(full.total);
      expect(page.entries.length).toBeLessThanOrEqual(5);
      expect(page.total).toBeGreaterThan(5);
    });
  });
});
