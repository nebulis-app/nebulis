import { describe, it, expect } from 'vitest';
import { variedMix } from '../../src/lib/variedMix';
import { classOfType } from '../../src/lib/objectCategories';

/** Minimal shape: variedMix only reads `type`. */
const t = (id: string, type: string) => ({ id, type });

const ids = (list: Array<{ id: string }>) => list.map(x => x.id);

describe('variedMix', () => {
  it('is a permutation: nothing lost, nothing duplicated, nothing reordered twice', () => {
    const input = [
      t('g1', 'Galaxy'), t('g2', 'Spiral Galaxy'), t('g3', 'Galaxy Pair'),
      t('n1', 'Emission Nebula'), t('n2', 'Reflection Nebula'),
      t('c1', 'Open Cluster'), t('c2', 'Globular Cluster'),
      t('o1', 'Double Star'), t('o2', 'Star Cloud'),
    ];
    const out = variedMix(input);

    expect(out).toHaveLength(input.length);
    expect(ids(out).sort()).toEqual(ids(input).sort());
    // Same object instances, not copies.
    for (const item of out) expect(input).toContain(item);
  });

  it('rotates nebula, galaxy, cluster as the documented order', () => {
    const out = variedMix([
      t('g1', 'Galaxy'), t('g2', 'Spiral Galaxy'),
      t('n1', 'Emission Nebula'),
      t('c1', 'Open Cluster'),
    ]);
    expect(ids(out)).toEqual(['n1', 'g1', 'c1', 'g2']);
  });

  it('shows every family before repeating one, so the top of the list is varied', () => {
    const input = [
      t('g1', 'Galaxy'), t('g2', 'Galaxy'), t('g3', 'Galaxy'), t('g4', 'Galaxy'),
      t('n1', 'Emission Nebula'),
      t('c1', 'Open Cluster'),
    ];
    const firstThree = variedMix(input).slice(0, 3).map(x => classOfType(x.type) ?? 'other');
    expect(new Set(firstThree).size).toBe(3);
  });

  it('leaves no two neighbours in the same family when the counts allow it', () => {
    const out = variedMix([
      t('g1', 'Galaxy'), t('g2', 'Galaxy'),
      t('n1', 'Emission Nebula'), t('n2', 'Reflection Nebula'),
      t('c1', 'Open Cluster'), t('c2', 'Globular Cluster'),
    ]);
    for (let i = 1; i < out.length; i += 1) {
      expect(classOfType(out[i].type), `${out[i - 1].id} then ${out[i].id}`)
        .not.toBe(classOfType(out[i - 1].type));
    }
  });

  it("keeps the caller's ranking inside each family", () => {
    const input = [
      t('g1', 'Galaxy'), t('g2', 'Galaxy'), t('g3', 'Galaxy'),
      t('n1', 'Emission Nebula'), t('n2', 'Emission Nebula'),
    ];
    const out = variedMix(input);
    expect(ids(out).filter(id => id.startsWith('g'))).toEqual(['g1', 'g2', 'g3']);
    expect(ids(out).filter(id => id.startsWith('n'))).toEqual(['n1', 'n2']);
  });

  it('leaves a single-family list exactly as it came in', () => {
    const input = [t('g1', 'Galaxy'), t('g2', 'Galaxy'), t('g3', 'Galaxy')];
    expect(ids(variedMix(input))).toEqual(['g1', 'g2', 'g3']);
  });

  it('returns an empty list when given an empty list', () => {
    expect(variedMix([])).toEqual([]);
  });

  it('rotates types no family claims through their own slot rather than dropping them', () => {
    const out = variedMix([
      t('g1', 'Galaxy'), t('g2', 'Galaxy'), t('g3', 'Galaxy'),
      t('o1', 'Double Star'), t('o2', 'Star Cloud'), t('o3', 'Unknown'),
    ]);
    // Galaxy leads the rotation only until the unclaimed bucket has its turn.
    expect(ids(out)).toEqual(['g1', 'o1', 'g2', 'o2', 'g3', 'o3']);
  });

  it('files a hybrid by the shared mapping, so Cluster + Nebula rotates as a nebula', () => {
    expect(classOfType('Cluster + Nebula')).toBe('nebula');
    const out = variedMix([t('h', 'Cluster + Nebula'), t('g', 'Galaxy')]);
    expect(ids(out)).toEqual(['h', 'g']);
  });

  it('is deterministic', () => {
    const input = [
      t('g1', 'Galaxy'), t('n1', 'Emission Nebula'), t('c1', 'Open Cluster'),
      t('o1', 'Double Star'), t('g2', 'Galaxy'),
    ];
    expect(ids(variedMix(input))).toEqual(ids(variedMix(input)));
  });
});
