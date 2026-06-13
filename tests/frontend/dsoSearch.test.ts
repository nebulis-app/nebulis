import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { normalizeSearch, matchesSearch } from '../../src/lib/dsoSearch';

/**
 * Property and example tests for the search-canonicalization helpers.
 *
 * normalizeSearch shapes both queries and indexed fields onto a single
 * comparable string. Two regressions we have to lock down:
 *
 *   1. Idempotence. Applying the function twice must equal applying it once.
 *      If it weren't idempotent, two callers normalizing at different points
 *      in the pipeline would disagree, and matchesSearch would silently miss
 *      results.
 *
 *   2. Leading-zero collapse only after an alpha prefix. "NGC0224" must
 *      become "ngc224", but a bare "0" or a digit-only run must not be
 *      eaten away.
 */

describe('normalizeSearch', () => {
  it('is idempotent for any string input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeSearch(s);
        const twice = normalizeSearch(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 500 }
    );
  });

  it('collapses leading zeros after an alpha prefix', () => {
    expect(normalizeSearch('NGC00224')).toBe('ngc224');
    expect(normalizeSearch('NGC0224')).toBe('ngc224');
    expect(normalizeSearch('M007')).toBe('m7');
    expect(normalizeSearch('IC0010')).toBe('ic10');
    expect(normalizeSearch('UGC0001')).toBe('ugc1');
  });

  it('collapses leading zeros even when whitespace separates prefix and digits', () => {
    expect(normalizeSearch('NGC 0224')).toBe('ngc224');
    expect(normalizeSearch('M  007')).toBe('m7');
  });

  it('does not eat the digit "0" when it is not after an alpha prefix', () => {
    // Bare digits must pass through. The regex requires [a-z]0+(\d), so a
    // standalone "0" or a digit-only string never matches.
    expect(normalizeSearch('0')).toBe('0');
    expect(normalizeSearch('00')).toBe('00');
    expect(normalizeSearch('007')).toBe('007');
    expect(normalizeSearch('100')).toBe('100');
    expect(normalizeSearch('1024')).toBe('1024');
  });

  it('does not collapse zeros that appear between digits (not after a letter)', () => {
    // "10024" has a zero run in the middle but no preceding letter — keep it.
    expect(normalizeSearch('10024')).toBe('10024');
    // After collapsing the alpha-prefix run, internal zeros must remain.
    expect(normalizeSearch('NGC1024')).toBe('ngc1024');
    expect(normalizeSearch('NGC01024')).toBe('ngc1024');
  });

  it('lowercases and strips internal whitespace', () => {
    expect(normalizeSearch('Andromeda Galaxy')).toBe('andromedagalaxy');
    expect(normalizeSearch('M 42')).toBe('m42');
    expect(normalizeSearch('  m   42  ')).toBe('m42');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeSearch('   ')).toBe('');
    expect(normalizeSearch('')).toBe('');
  });

  it('preserves digits-only queries unchanged after lowercase/strip', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[1-9][0-9]{0,4}$/), (digits) => {
        expect(normalizeSearch(digits)).toBe(digits);
      }),
      { numRuns: 100 }
    );
  });
});

describe('matchesSearch', () => {
  const entry = {
    id: 'NGC0224',
    ngcName: 'NGC 224',
    name: 'Andromeda Galaxy',
    constellation: 'Andromeda',
    commonNames: ['M31', 'Great Andromeda Nebula'],
    messier: 31,
  };

  it('matches the catalog id with and without leading zeros', () => {
    expect(matchesSearch(entry, 'NGC224')).toBe(true);
    expect(matchesSearch(entry, 'NGC0224')).toBe(true);
    expect(matchesSearch(entry, 'ngc 224')).toBe(true);
  });

  it('matches by Messier number alone', () => {
    expect(matchesSearch(entry, '31')).toBe(true);
    expect(matchesSearch(entry, 'M31')).toBe(true);
  });

  it('returns true for an empty query', () => {
    expect(matchesSearch(entry, '')).toBe(true);
    expect(matchesSearch(entry, '   ')).toBe(true);
  });

  it('returns false for a clearly unrelated query', () => {
    expect(matchesSearch(entry, 'orion')).toBe(false);
  });
});
