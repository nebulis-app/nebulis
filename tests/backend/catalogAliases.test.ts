import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveCanonicalId,
  getAliasesForCanonical,
  expandSearchAliases,
} from '../../server/lib/catalogAliases';

/**
 * Pull every alias key straight from the source so the test stays in sync with
 * the table automatically. The map is a literal of `['ALIAS', 'CANONICAL']`
 * pairs; this regex captures the alias (left) side of each entry.
 */
function allAliasKeys(): string[] {
  const src = fs.readFileSync(
    path.join(__dirname, '../../server/lib/catalogAliases.ts'),
    'utf8',
  );
  const re = /\['([^']+)',\s*'([^']+)'\]/g;
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) keys.push(m[1]);
  return keys;
}

describe('catalogAliases', () => {
  it('every alias resolves to a stable fixpoint (no cycles, no chains)', () => {
    // This is the invariant that the M102 ↔ NGC5866 cycle violated: the table
    // mapped both directions, so each designation resolved to the other and the
    // two never merged into one library object. resolveCanonicalId does a single
    // lookup, so resolving the result again must return the same id. Any alias
    // that fails this points at a value that is itself an alias key.
    const unstable: string[] = [];
    for (const alias of allAliasKeys()) {
      const once = resolveCanonicalId(alias);
      const twice = resolveCanonicalId(once);
      if (once !== twice) unstable.push(`${alias} -> ${once} -> ${twice}`);
    }
    expect(unstable).toEqual([]);
  });

  it('a canonical id is never itself an alias key', () => {
    // Equivalent guarantee stated on the canonical side: nothing an alias points
    // to may also appear on the left of another entry. Catches a cycle even if
    // both halves were added far apart in the file.
    const keys = new Set(allAliasKeys().map(k => k.toUpperCase().replace(/\s+/g, '')));
    const offenders: string[] = [];
    for (const alias of allAliasKeys()) {
      const canonical = resolveCanonicalId(alias).toUpperCase().replace(/\s+/g, '');
      if (keys.has(canonical)) offenders.push(`${alias} -> ${resolveCanonicalId(alias)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('alias and canonical name of the same object converge', () => {
    // Each pair is two real designations for one physical object. Both must land
    // on the same canonical id or they split into duplicate library cards — the
    // exact import-overwrite bug this guards against.
    const samePairs: Array<[string, string, string]> = [
      ['C63', 'NGC7293', 'Helix Nebula'],
      ['M102', 'NGC5866', 'Spindle Galaxy'],
      ['C9', 'Sh2-155', 'Cave Nebula'],
      ['IC2118', 'NGC1909', 'Witch Head'],
      ['C30', 'NGC7331', 'Caldwell/NGC'],
      ['SH2-49', 'M16', 'Eagle Nebula'],
      ['C11', 'Sh2-162', 'Bubble Nebula'], // Caldwell + Sharpless onto one NGC
      ['NGC224', 'M31', 'Andromeda'],
      ['Lunar', 'Moon', 'Moon'],
      ['Solar', 'Sun', 'Sun'],
    ];
    for (const [a, b, label] of samePairs) {
      expect(
        resolveCanonicalId(a),
        `${label}: "${a}" and "${b}" must resolve to the same canonical id`,
      ).toBe(resolveCanonicalId(b));
    }
  });

  it('M102 resolves to NGC5866 and NGC5866 stays put (cycle is gone)', () => {
    expect(resolveCanonicalId('M102')).toBe('NGC5866');
    expect(resolveCanonicalId('NGC5866')).toBe('NGC5866');
  });

  it('C9 and Sh2-155 both fold into the Sharpless canonical', () => {
    expect(resolveCanonicalId('C9')).toBe('SH2-155');
    expect(resolveCanonicalId('Sh2-155')).toBe('SH2-155');
  });

  it('leaves unknown ids unchanged', () => {
    expect(resolveCanonicalId('NGC9999')).toBe('NGC9999');
    expect(resolveCanonicalId('SomeCustomName')).toBe('SomeCustomName');
  });

  it('reverse lookup lists the aliases that fold into a canonical id', () => {
    expect(getAliasesForCanonical('NGC7293')).toContain('C63');
    expect(getAliasesForCanonical('NGC7331')).toContain('C30');
    // NGC5866 should now list M102 (and only resolve one way).
    expect(getAliasesForCanonical('NGC5866')).toContain('M102');
  });

  it('expandSearchAliases includes the canonical id and known aliases', () => {
    const terms = expandSearchAliases('C63');
    expect(terms).toContain('C63');
    expect(terms).toContain('NGC7293');
  });
});
