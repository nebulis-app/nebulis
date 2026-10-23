import { describe, it, expect } from 'vitest';
import { getCuratedDescription, getSiblingDescription } from '../../server/lib/curatedDescriptions.js';

describe('getSiblingDescription', () => {
  it('lends NGC6992\'s paragraph to NGC6995, which shares the Eastern Veil name', () => {
    expect(getCuratedDescription('NGC6995')).toBeNull();
    const text = getSiblingDescription('NGC6995');
    expect(text?.extract.startsWith('NGC 6995 is a section of the Eastern Veil Nebula.')).toBe(true);
    expect(text?.extract).toContain('NGC 6992 is the bright eastern arc');
  });

  it('does not lend a description to an object that has its own', () => {
    expect(getSiblingDescription('NGC6992')).toBeNull();
  });

  it('does not borrow across catalog numbers, only across common names', () => {
    // These share a designation alias with a curated neighbour, not a name.
    expect(getSiblingDescription('NGC2520')).toBeNull();
    expect(getSiblingDescription('NGC3189')).toBeNull();
  });

  it('returns null for an object with no namesake and for an unknown id', () => {
    expect(getSiblingDescription('NOT-A-REAL-ID')).toBeNull();
  });
});
