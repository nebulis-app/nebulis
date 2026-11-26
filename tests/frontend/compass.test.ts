import { describe, expect, it } from 'vitest';
import { compassKey } from '../../src/lib/compass';

describe('compassKey', () => {
  it('names the nearest of eight points, wrapping around north', () => {
    expect(compassKey(0)).toBe('N');
    expect(compassKey(22)).toBe('N');
    expect(compassKey(23)).toBe('NE');
    expect(compassKey(180)).toBe('S');
    expect(compassKey(250)).toBe('W');
    expect(compassKey(337.4)).toBe('NW');
    expect(compassKey(337.6)).toBe('N');
    expect(compassKey(-90)).toBe('W');
    expect(compassKey(720 + 90)).toBe('E');
  });
});
