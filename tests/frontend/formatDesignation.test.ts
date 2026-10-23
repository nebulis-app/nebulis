import { describe, it, expect } from 'vitest';
import { formatAliases, formatDesignation } from '../../src/lib/formatDesignation';

describe('formatDesignation', () => {
  it('fixes prefix casing and drops leading zeros', () => {
    expect(formatDesignation('Mel022')).toBe('Mel22');
    expect(formatDesignation('MEL022')).toBe('Mel22');
    expect(formatDesignation('IC0434')).toBe('IC434');
    expect(formatDesignation('ngc 1976')).toBe('NGC1976');
    expect(formatDesignation('b33')).toBe('B33');
  });

  it('keeps a letter suffix, uppercased', () => {
    expect(formatDesignation('NGC1976a')).toBe('NGC1976A');
  });

  it('leaves common names and other formats exactly as they were', () => {
    expect(formatDesignation('Orion B')).toBe('Orion B');
    expect(formatDesignation("Bode's Galaxy")).toBe("Bode's Galaxy");
    expect(formatDesignation('Sh2-132')).toBe('Sh2-132');
    expect(formatDesignation('Be29')).toBe('Be29');
  });
});

describe('formatAliases', () => {
  it('collapses names that differ only in case, zeros or spacing, keeping the first', () => {
    expect(formatAliases(['Mel022', 'MEL022', 'Mel 22', 'Pleiades'])).toEqual(['Mel22', 'Pleiades']);
  });

  it('keeps order for distinct names', () => {
    expect(formatAliases(['IC0434', 'Orion B', 'Barnard 33', 'B33'])).toEqual(['IC434', 'Orion B', 'Barnard 33', 'B33']);
  });
});
