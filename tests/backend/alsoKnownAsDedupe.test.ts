import { describe, it, expect } from 'vitest';
import { getAlsoKnownAs } from '../../server/data/catalog';

const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^([a-z]+)0+(\d)/, '$1$2');

describe('getAlsoKnownAs duplicates', () => {
  it.each(['M45', 'M31', 'IC434', 'NGC1976', 'M51'])('lists each name once for %s', (id) => {
    const names = getAlsoKnownAs(id);
    expect(new Set(names.map(norm)).size).toBe(names.length);
  });

  it('does not list the same Melotte designation twice for the Pleiades', () => {
    expect(getAlsoKnownAs('M45').filter((n) => /^mel0*22$/i.test(n))).toHaveLength(1);
  });

  it('does not list NGC224 and NGC0224 both for Andromeda', () => {
    expect(getAlsoKnownAs('M31').filter((n) => /^ngc0*224$/i.test(n))).toHaveLength(1);
  });
});
