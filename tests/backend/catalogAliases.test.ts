import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveCanonicalId,
  getAliasesForCanonical,
  expandSearchAliases,
  normalizeDesignation,
} from '../../server/lib/catalogAliases';
import { getById } from '../../server/lib/dsoCatalog';

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

describe('normalizeDesignation', () => {
  const cases: Array<[string, string]> = [
    ['ngc 224', 'NGC224'],
    ['NGC0224', 'NGC224'],
    ['ic 342', 'IC342'],
    ['IC0405', 'IC405'],
    ['m 31', 'M31'],
    ['Messier 31', 'M31'],
    ['caldwell 5', 'C5'],
    ['C5', 'C5'],
    ['Sh2-155', 'SH2-155'],
    ['sh2 155', 'SH2-155'],
    ['sharpless 155', 'SH2-155'],
    ['B33', 'B33'],
    ['Barnard 33', 'B33'],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => {
      expect(normalizeDesignation(input)).toBe(expected);
      // Idempotent.
      expect(normalizeDesignation(expected)).toBe(expected);
    });
  }

  it('leaves non-designations (custom names, comet ids) untouched', () => {
    expect(normalizeDesignation('My Favorite Nebula')).toBe('My Favorite Nebula');
    expect(normalizeDesignation('C-2023 A3')).toBe('C-2023 A3');
    expect(normalizeDesignation('Star Trails')).toBe('Star Trails');
  });

  it('leaves variant ids that merely START like a designation untouched', () => {
    // A prefix match here uppercased the whole string ("M31_mosaic" ->
    // "M31_MOSAIC"), which rekeyed a live library object and orphaned its
    // files. A bare designation is the WHOLE string, not just its start.
    for (const id of [
      'M31_mosaic', 'M31_Mosaic', 'IC434_mosaic', 'NGC7000_mosaic',
      'M31_Ha', 'NGC2244SatelliteCluster', 'B33_panel2',
    ]) {
      expect(normalizeDesignation(id)).toBe(id);
      expect(resolveCanonicalId(id)).toBe(id);
    }
  });

  it('still normalizes and folds bare designations, incl. component suffixes', () => {
    expect(normalizeDesignation('ngc 7318a')).toBe('NGC7318A');
    expect(normalizeDesignation('NGC 0224')).toBe('NGC224');
    expect(resolveCanonicalId('ngc224')).toBe('M31');
    expect(resolveCanonicalId('NGC9999')).toBe('NGC9999');
  });
});

describe('cross-catalog lookup coverage', () => {
  // Caldwell numbers with no higher catalog designation (dark nebulae / naked-eye
  // clusters that were never given an NGC/IC number), plus C37 whose NGC6885 is
  // filtered out of the Seestar DSO catalog. Anything NEW landing here is a
  // regression — this is the invariant the IC342 "no description" bug violated.
  const CALDWELL_EXCEPTIONS = new Set(['C41', 'C99', 'C37']);
  const CALDWELL = Array.from({ length: 109 }, (_, i) => `C${i + 1}`);

  it('every Caldwell number (minus known exceptions) resolves to a stable, findable object', () => {
    const broken: string[] = [];
    for (const c of CALDWELL) {
      if (CALDWELL_EXCEPTIONS.has(c)) continue;
      const canonical = resolveCanonicalId(c);
      if (canonical === c) { broken.push(`${c}: no alias`); continue; }
      if (resolveCanonicalId(canonical) !== canonical) { broken.push(`${c} -> ${canonical} not a fixpoint`); continue; }
      const byC = getById(c);
      const byCanonical = getById(canonical);
      if (!byC) broken.push(`${c}: getById returned nothing`);
      else if (!byCanonical) broken.push(`${canonical} (from ${c}): getById returned nothing`);
      else if (byC.id !== byCanonical.id) broken.push(`${c} -> ${byC.id} but ${canonical} -> ${byCanonical.id}`);
    }
    expect(broken).toEqual([]);
  });

  it('the known Caldwell exceptions are exactly those three (flag new gaps)', () => {
    const gaps: string[] = [];
    for (const c of CALDWELL) {
      const canonical = resolveCanonicalId(c);
      if (canonical === c || !getById(canonical)) gaps.push(c);
    }
    expect(new Set(gaps)).toEqual(CALDWELL_EXCEPTIONS);
  });

  it('every Messier number resolves to a fixpoint and is findable', () => {
    const broken: string[] = [];
    for (let n = 1; n <= 110; n++) {
      const m = `M${n}`;
      // M102 is disputed and deliberately mapped to NGC5866.
      const expected = m === 'M102' ? 'NGC5866' : m;
      if (resolveCanonicalId(m) !== expected) broken.push(`${m} -> ${resolveCanonicalId(m)} (want ${expected})`);
      if (!getById(m)) broken.push(`${m}: getById returned nothing`);
    }
    expect(broken).toEqual([]);
  });

  it('resolves an object identically from its NGC and Messier designation', () => {
    // M16 = NGC6611, M1 = NGC1952, M45 has no NGC (skipped).
    for (const [a, b] of [['NGC6611', 'M16'], ['NGC1952', 'M1'], ['NGC224', 'M31'], ['NGC5194', 'M51']]) {
      expect(getById(a)?.id).toBe(getById(b)?.id);
    }
  });
});
