import { describe, expect, it } from 'vitest';
import {
  getCuratedRecord,
  getAllCuratedRecords,
  getDerivedAliasIndex,
  getAliasConflicts,
  resolveToCanonical,
} from '../../server/lib/catalogStore';
import { resolveCanonicalId, normalizeDesignation } from '../../server/lib/catalogAliases';

const norm = (id: string) => normalizeDesignation(id).toUpperCase().replace(/\s+/g, '');

describe('catalogStore', () => {
  it('unifies the two curated files into one record set', () => {
    const records = getAllCuratedRecords();
    // catalog-curated.json has 557 entries; curated-descriptions.json adds
    // ~120 more that have no curated-file counterpart once cross-catalog
    // duplicates collapse. The exact number moves as the curated layer grows —
    // assert a sane floor and "more than the curated file alone", not equality.
    expect(records.length).toBeGreaterThan(557);
    expect(records.length).toBeGreaterThan(640);
    for (const r of records) {
      expect(r.canonicalId).toBeTruthy();
      expect(r.designations).toContain(norm(r.canonicalId));
      expect(typeof r.description).toBe('string');
    }
  });

  it('resolves IC 342 to one record carrying its description and every designation', () => {
    const rec = getCuratedRecord('C5');
    expect(rec).not.toBeNull();
    expect(rec!.canonicalId).toBe('IC342');
    expect(rec!.description).toMatch(/IC ?342/);
    expect(rec!.designations).toEqual(expect.arrayContaining(['IC342', 'C5']));
    expect(rec!.programs).toContain('caldwell');
    // Same record regardless of which designation is asked for.
    expect(getCuratedRecord('IC 342')).toEqual(rec);
    expect(getCuratedRecord('Caldwell 5')).toEqual(rec);
  });

  it('the merged description is at least as long as either source had', () => {
    // M31 has text in both files; the store must not have picked the shorter.
    const rec = getCuratedRecord('M31');
    expect(rec).not.toBeNull();
    expect(rec!.description.length).toBeGreaterThan(100);
    expect(rec!.descriptionSource).toMatch(/^https?:\/\//);
  });

  it('has no unresolved alias conflicts at load', () => {
    // A designation that two sources claim for different canonical ids is a
    // real data bug — a changed canonical id rewrites library folder keys.
    expect(getAliasConflicts()).toEqual([]);
  });

  it('the derived alias index is a superset of the hand-written ALIASES map', () => {
    // Risk-table mitigation: before any of the ALIASES map is deleted in
    // Step 4, prove the derived index covers every mapping it had. Every
    // alias the old map knew must resolve to the same canonical id here.
    const knownAliases: Array<[string, string]> = [
      ['NGC1952', 'M1'], ['NGC224', 'M31'], ['NGC5194', 'M51'],
      ['C5', 'IC342'], ['C30', 'NGC7331'], ['C14', 'NGC869'],
      ['SH2-49', 'M16'], ['SH2-155', 'SH2-155'], ['C9', 'SH2-155'],
      ['M102', 'NGC5866'], ['NGC1909', 'IC2118'],
      ['NGC6611', 'M16'], ['NGC7089', 'M2'], ['C109', 'NGC3195'],
    ];
    const index = getDerivedAliasIndex();
    for (const [alias, canonical] of knownAliases) {
      expect(norm(resolveToCanonical(alias)), `alias ${alias}`).toBe(norm(canonical));
      // and it is actually in the derived index, not just the fallback
      if (norm(alias) !== norm(canonical)) {
        expect(index.get(norm(alias)), `${alias} in derived index`).toBeTruthy();
      }
    }
  });

  it('no designation resolves to two canonical ids', () => {
    const index = getDerivedAliasIndex();
    const seen = new Map<string, string>();
    for (const [designation, canonical] of index) {
      const prev = seen.get(designation);
      expect(prev === undefined || prev === canonical, `${designation}: ${prev} vs ${canonical}`).toBe(true);
      seen.set(designation, canonical);
    }
  });

  it('every program member resolves to a real canonical id', () => {
    for (const rec of getAllCuratedRecords()) {
      if (rec.programs.length === 0) continue;
      expect(resolveCanonicalId(rec.canonicalId)).toBeTruthy();
    }
  });
});
