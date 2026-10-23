import { describe, it, expect } from 'vitest';
import { exploreCategoryForType } from '../../src/lib/exploreCategory';
import { getPlannerCatalog } from '../../server/lib/dsoCatalog';
import { categoryOf } from '../../server/lib/explore/categories';

/**
 * "Find similar" on the Wishlist maps an object's type label to an Explore tile. The server decides the tile with
 * the label and OpenNGC's type code; this walks every object in the catalog and demands the label alone gives the same
 * answer, so a similar-object link can never land on a tile that doesn't list the object.
 */
describe('exploreCategoryForType', () => {
  it('agrees with the server for every object in the catalog', () => {
    const disagreements = getPlannerCatalog()
      .filter(e => exploreCategoryForType(e.type) !== categoryOf(e))
      .map(e => `${e.id} (${e.type}, ${e.typeCode}): client ${exploreCategoryForType(e.type)} vs server ${categoryOf(e)}`);
    expect(disagreements).toEqual([]);
  });

  it('knows the labels people see', () => {
    expect(exploreCategoryForType('Spiral Galaxy')).toBe('galaxies');
    expect(exploreCategoryForType('Galaxy Pair')).toBe('galaxy-groups');
    expect(exploreCategoryForType('Planetary Nebula')).toBe('planetary-nebulae');
    expect(exploreCategoryForType('Supernova Remnant')).toBe('supernova-remnants');
    expect(exploreCategoryForType('Open Cluster')).toBe('clusters');
    expect(exploreCategoryForType('Dark Nebula')).toBe('dark-reflection');
    expect(exploreCategoryForType('Emission/Reflection Nebula')).toBe('emission-nebulae');
    expect(exploreCategoryForType('Double Star')).toBeNull();
    expect(exploreCategoryForType('')).toBeNull();
    expect(exploreCategoryForType(undefined)).toBeNull();
  });
});
