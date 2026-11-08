import { describe, it, expect } from 'vitest';
import { listTierMembers, ownedMembers, ownerTier, SELF_CONTAINED_TIERS } from '../../server/lib/catalogPack/tierMembership';
import { CATALOG_TIERS } from '../../server/lib/catalogPack/manifest';
import { resolveCanonicalId } from '../../server/lib/catalogAliases';

describe('pack tier membership', () => {
  it('gives every object exactly one owning tier, apart from the self-contained packs', () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const tier of CATALOG_TIERS) {
      if (SELF_CONTAINED_TIERS.has(tier)) continue;
      for (const id of ownedMembers(tier)) {
        if (seen.has(id)) clash.push(`${id}: ${seen.get(id)} and ${tier}`);
        seen.set(id, tier);
      }
    }
    expect(clash).toEqual([]);
  });

  it('lets a self-contained pack carry a cross-listed object without taking ownership', () => {
    expect(ownedMembers('abell')).toContain('SH2-274'); // Abell 21, the Medusa Nebula
    expect(ownerTier('SH2-274')).toBe('sharpless');
    expect(ownedMembers('berkeley')).toContain('NGC7822'); // Berkeley 59
    expect(ownerTier('NGC7822')).toBe('popular');
  });

  it('makes the catalog packs self-contained', () => {
    expect(ownedMembers('abell').length).toBe(listTierMembers().abell.length);
    expect(ownedMembers('berkeley').length).toBe(listTierMembers().berkeley.length);
    expect(listTierMembers().abell.length).toBe(80);
    expect(listTierMembers().berkeley.length).toBe(89);
  });

  it('lists only canonical ids', () => {
    const wrong: string[] = [];
    for (const [tier, ids] of Object.entries(listTierMembers())) for (const id of ids) if (resolveCanonicalId(id) !== id) wrong.push(`${tier}: ${id}`);
    expect(wrong).toEqual([]);
  });

  it('puts the Caldwell objects on the right ids', () => {
    const caldwell = new Set(listTierMembers().caldwell);
    expect(caldwell.has('IC2602')).toBe(true);
    expect(caldwell.has('NGC2070')).toBe(true);
    expect(caldwell.has('NGC2547')).toBe(false);
    expect(caldwell.size).toBe(109);
  });

  it('keeps one Heart Nebula, not an IC1805 and a Sh2-190', () => {
    expect(ownerTier('IC1805')).toBe('popular');
    expect(listTierMembers().sharpless).not.toContain('SH2-190');
    expect(ownerTier('SH2-190')).toBeNull();
    expect(ownedMembers('sharpless')).toContain('SH2-1');
  });

  it('ships the solar system once, in popular', () => {
    expect(ownerTier('Sun')).toBe('popular');
    expect(ownedMembers('extended')).not.toContain('Sun');
  });

  it('covers every Messier object', () => {
    expect(listTierMembers().messier.length).toBe(110);
    expect(ownerTier('M45')).toBe('messier');
  });
});
