import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { canonicalImportName, parsesToDate } from '../../server/lib/library/importNaming';

/**
 * canonicalImportName names a file inside an object folder, so whatever a
 * walker hands it, the result has to be one path segment, unused, and dated
 * into the session it was assigned to.
 */

const NUM_RUNS = 300;

const day = fc
  .tuple(fc.integer({ min: 2000, max: 2035 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

// Names with the characters that matter: separators, dots, colons, spaces, unicode.
const rawName = fc.string({ unit: fc.constantFrom('a', 'B', '1', '.', '.', '/', '\\', ':', ' ', '_', '-', 'é', '*'), minLength: 1, maxLength: 24 });

describe('canonicalImportName properties', () => {
  it('is always a single path segment', () => {
    fc.assert(
      fc.property(rawName, day, (name, date) => {
        const out = canonicalImportName(name, date, null, null, new Set());
        expect(out).not.toMatch(/[/\\]/);
        expect(out.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never returns a name that is already taken', () => {
    fc.assert(
      fc.property(rawName, day, fc.array(rawName, { maxLength: 4 }), (name, date, taken) => {
        const used = new Set(taken);
        used.add(name);
        expect(used.has(canonicalImportName(name, date, null, null, used))).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // parseFilename needs an extension to recognize the dated form, so extensionless names are out of scope here.
  it('a rewritten name with an extension parses to the date it was assigned', () => {
    fc.assert(
      fc.property(rawName, day, (name, date) => {
        const out = canonicalImportName(`${name}x.fit`, date, null, null, new Set());
        expect(parsesToDate(out, date)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
