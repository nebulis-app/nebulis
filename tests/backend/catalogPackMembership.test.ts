import { describe, it, expect } from 'vitest';
import { listTierMembers, ownedMembers, ownerTier } from '../../server/lib/catalogPack/tierMembership';
import { CATALOG_TIERS } from '../../server/lib/catalogPack/manifest';
import { resolveCanonicalId } from '../../server/lib/catalogAliases';

describe('pack tier membership', () => {
  it('gives every object to exactly one tier', () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const tier of CATALOG_TIERS) for (const id of ownedMembers(tier)) {
      if (seen.has(id)) clash.push(`${id}: ${seen.get(id)} and ${tier}`);
      seen.set(id, tier);
    }
    expect(clash).toEqual([]);
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
