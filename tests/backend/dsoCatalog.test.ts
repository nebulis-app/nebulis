import { describe, it, expect } from 'vitest';
import { getCatalog, getById, search, searchFiltered, filterCatalog } from '../../server/lib/dsoCatalog';
import { maxPossibleAltitude } from '../../server/lib/astroCalc';

// A mid-northern site (roughly New York), used by the lat/minAlt
// ("ever visible from here") filter tests below.
const NORTHERN_LAT = 40.7;

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

    it('resolves IC1318 via curated fallback (missing from OpenNGC)', () => {
      const entry = getById('IC1318');
      expect(entry).toBeDefined();
      expect(entry!.id).toBe('IC1318');
      expect(entry!.name).toBe('Sadr Region');
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

    it('finds IC1318 (Sadr Region) via curated fallback', () => {
      // IC1318 is the star Gamma Cygni in OpenNGC, so the Seestar filter
      // drops it; only the curated catalog carries it as the Sadr Region.
      const results = search('IC1318');
      const entry = results.find(r => r.id === 'IC1318');
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('Sadr Region');
      expect(entry!.type).toBe('Emission Nebula');
      expect(entry!.constellation).toBe('Cygnus');
      // Sexagesimal curated coords must convert to decimal hours/degrees.
      expect(entry!.ra).toBeCloseTo(20 + 22 / 60, 5);
      expect(entry!.dec).toBeCloseTo(40 + 19 / 60, 5);
    });

    it('finds curated-only objects by common name too', () => {
      expect(search('sadr').some(r => r.id === 'IC1318')).toBe(true);
      expect(search('horsehead').some(r => r.id === 'B33')).toBe(true);
      // The Spindle Galaxy is canonically NGC5866; "M102" is a disputed alias
      // that now folds into that one record.
      expect(search('spindle galaxy').some(r => r.id === 'NGC5866' || r.id === 'M102')).toBe(true);
    });
  });

  describe('searchFiltered', () => {
    it('matches plain search() for the same query and limit, unfiltered', () => {
      // searchFiltered is a superset of search()'s scoring/ranking logic with
      // no type/sort override applied — the two should agree exactly.
      expect(searchFiltered('andromeda', { limit: 30 }).entries.map(e => e.id))
        .toEqual(search('andromeda', 30).map(e => e.id));
    });

    it('filters matches by type', () => {
      const { entries, total } = searchFiltered('ngc', { type: 'galaxy', limit: 500 });
      expect(total).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.type.toLowerCase()).toContain('galaxy');
      }
    });

    it('paginates the matched (not just returned) set via offset/limit, with a stable total', () => {
      const full = searchFiltered('nebula', { limit: 500 });
      const page = searchFiltered('nebula', { limit: 5, offset: 0 });
      expect(page.total).toBe(full.total);
      expect(page.entries.length).toBeLessThanOrEqual(5);
      expect(page.total).toBeGreaterThan(5);
      // The next page picks up where the first left off, not a repeat of it.
      const nextPage = searchFiltered('nebula', { limit: 5, offset: 5 });
      expect(nextPage.entries.map(e => e.id)).toEqual(full.entries.slice(5, 10).map(e => e.id));
    });

    it('sorts by name across the full matched set, overriding relevance order', () => {
      const { entries } = searchFiltered('nebula', { sort: 'name', limit: 500 });
      const names = entries.map(e => (e.name || e.id).toLowerCase());
      expect(names).toEqual([...names].sort());
    });

    it('with lat/minAlt, drops every match that can never clear that altitude from that latitude', () => {
      const unfiltered = searchFiltered('nebula', { limit: 500 });
      const filtered = searchFiltered('nebula', { lat: NORTHERN_LAT, minAlt: 20, limit: 500 });
      expect(filtered.total).toBeLessThan(unfiltered.total);
      for (const entry of filtered.entries) {
        expect(maxPossibleAltitude(NORTHERN_LAT, entry.dec)).toBeGreaterThanOrEqual(20);
      }
      // Every dropped match is dropped for the stated reason, not silently
      // lost for some other one.
      const filteredIds = new Set(filtered.entries.map(e => e.id));
      for (const entry of unfiltered.entries) {
        if (!filteredIds.has(entry.id)) {
          expect(maxPossibleAltitude(NORTHERN_LAT, entry.dec)).toBeLessThan(20);
        }
      }
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

    it('sorts by magnitude, nulls last', () => {
      // The whole catalog: null magnitudes only start after ~3,700 measured entries, so a 500-row page never reaches them.
      const { entries } = filterCatalog({ limit: 100_000, sort: 'magnitude' });
      const mags = entries.map(e => e.magnitude);
      const withMag = mags.filter((m): m is number => m != null);
      expect(withMag).toEqual([...withMag].sort((a, b) => a - b));
      // Every null-magnitude entry sorts after every real measurement.
      const firstNullIndex = mags.indexOf(null);
      // The test is only meaningful if the page really contains a null magnitude.
      expect(firstNullIndex).toBeGreaterThan(-1);
      expect(mags.slice(firstNullIndex).every(m => m == null)).toBe(true);
    });

    it('with lat/minAlt, keeps only entries that can clear that altitude from that latitude', () => {
      const unfiltered = filterCatalog({ limit: 500 });
      const filtered = filterCatalog({ lat: NORTHERN_LAT, minAlt: 20, limit: 500 });
      expect(filtered.total).toBeLessThan(unfiltered.total);
      for (const entry of filtered.entries) {
        expect(maxPossibleAltitude(NORTHERN_LAT, entry.dec)).toBeGreaterThanOrEqual(20);
      }
    });

    it('lat with no minAlt defaults to "ever rises above the horizon at all" (0°)', () => {
      const { entries } = filterCatalog({ lat: NORTHERN_LAT, limit: 500 });
      for (const entry of entries) {
        expect(maxPossibleAltitude(NORTHERN_LAT, entry.dec)).toBeGreaterThanOrEqual(0);
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
