import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  expandSearchAliases,
  isDesignationShaped,
  normalizeDesignation,
  resolveCanonicalId,
} from '../../server/lib/catalogAliases';

/**
 * Property tests for catalog designation normalization. No DB: the alias
 * tables are built from bundled JSON at module load.
 */

const NUM_RUNS = 200;

const PREFIXES = ['NGC', 'IC', 'M', 'C', 'B', 'UGC', 'PGC', 'LDN', 'LBN', 'VDB', 'MEL', 'ARP', 'HCG', 'STOCK', 'CED'];
const LONG_PREFIXES: Record<string, string> = { M: 'Messier', C: 'Caldwell', B: 'Barnard' };

const numArb = fc.integer({ min: 1, max: 7999 });

/** One designation in many human spellings, paired with its canonical form. */
const spelledDesignationArb = fc
  .record({
    prefix: fc.constantFrom(...PREFIXES, 'SH2'),
    n: numArb,
    pad: fc.integer({ min: 0, max: 3 }),
    space: fc.constantFrom('', ' ', '  '),
    lower: fc.boolean(),
    longForm: fc.boolean(),
    outerWs: fc.constantFrom('', ' ', '\t'),
  })
  .map(({ prefix, n, pad, space, lower, longForm, outerWs }) => {
    let canonical: string;
    let spelled: string;
    if (prefix === 'SH2') {
      canonical = `SH2-${n}`;
      spelled = longForm ? `Sharpless${space}${n}` : `Sh2-${n}`;
    } else {
      canonical = `${prefix}${n}`;
      const zeros = prefix === 'NGC' || prefix === 'IC' ? '0'.repeat(pad) : '';
      const head = longForm && LONG_PREFIXES[prefix] ? LONG_PREFIXES[prefix] : prefix;
      spelled = `${head}${space}${zeros}${n}`;
    }
    if (lower) spelled = spelled.toLowerCase();
    return { spelled: `${outerWs}${spelled}${outerWs}`, canonical };
  });

describe('normalizeDesignation - property tests', () => {
  it('is idempotent on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), s => {
        const once = normalizeDesignation(s);
        expect(normalizeDesignation(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is idempotent on designation-shaped strings', () => {
    fc.assert(
      fc.property(spelledDesignationArb, ({ spelled }) => {
        const once = normalizeDesignation(spelled);
        expect(normalizeDesignation(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('folds every human spelling of a designation onto one canonical form', () => {
    fc.assert(
      fc.property(spelledDesignationArb, ({ spelled, canonical }) => {
        expect(isDesignationShaped(spelled)).toBe(true);
        expect(normalizeDesignation(spelled)).toBe(canonical);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns non-designation text unchanged apart from trimming', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), s => {
        fc.pre(!isDesignationShaped(s));
        expect(normalizeDesignation(s)).toBe(s.trim());
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('resolveCanonicalId - property tests', () => {
  it('is idempotent: a canonical id resolves to itself', () => {
    fc.assert(
      fc.property(fc.oneof(spelledDesignationArb.map(d => d.spelled), fc.string({ maxLength: 20 })), s => {
        const once = resolveCanonicalId(s);
        expect(resolveCanonicalId(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('ignores spelling: every spelling of one designation resolves identically', () => {
    fc.assert(
      fc.property(spelledDesignationArb, ({ spelled, canonical }) => {
        expect(resolveCanonicalId(spelled)).toBe(resolveCanonicalId(canonical));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('expandSearchAliases - property tests', () => {
  it('always puts the trimmed original term first and never repeats a term', () => {
    fc.assert(
      fc.property(fc.oneof(spelledDesignationArb.map(d => d.spelled), fc.string({ maxLength: 20 })), term => {
        const out = expandSearchAliases(term);
        expect(out[0]).toBe(term.trim());
        expect(new Set(out).size).toBe(out.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
