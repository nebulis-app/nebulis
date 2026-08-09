import { describe, expect, it } from 'vitest';
import {
  LIBRARY_OBJECT_FILTERS,
  getLibraryObjectFilterTags,
} from '../../server/lib/library/objectFilters';

describe('library object filters', () => {
  it('exposes a Solar System filter for mobile and web clients', () => {
    const solar = LIBRARY_OBJECT_FILTERS.find(filter => filter.id === 'solar-system');
    expect(solar?.label).toBe('Solar System');
    expect(solar?.matchTypes).toEqual([
      'Planet',
      'Natural Satellite',
      'Dwarf Planet',
      'Asteroid',
      'Comet',
    ]);
  });

  it('tags solar system object types', () => {
    expect(getLibraryObjectFilterTags('Planet')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Natural Satellite')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Dwarf Planet')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Asteroid')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Comet')).toContain('solar-system');
  });

  it('does not file stars under the solar system', () => {
    expect(getLibraryObjectFilterTags('Star')).not.toContain('solar-system');
    expect(getLibraryObjectFilterTags('Star')).toContain('star');
    expect(getLibraryObjectFilterTags('Double Star')).toContain('star');
    // A star cloud is a Milky Way region, not a star.
    expect(getLibraryObjectFilterTags('Star Cloud')).not.toContain('star');
    expect(getLibraryObjectFilterTags('Starburst Galaxy')).not.toContain('star');
  });

  it('gives comets their own chip while keeping them in the solar system', () => {
    const tags = getLibraryObjectFilterTags('Comet');
    expect(tags).toContain('comet');
    expect(tags).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Planet')).not.toContain('comet');
  });

  it('collects unresolved objects under one chip, however their type is stored', () => {
    // The worklist of objects a user needs to correct by hand. Rows written by
    // resolveCatalogMeta carry the literal "Unknown"; older ones can be NULL.
    expect(getLibraryObjectFilterTags('Unknown')).toContain('unknown');
    expect(getLibraryObjectFilterTags(null)).toEqual(['unknown']);
    expect(getLibraryObjectFilterTags('')).toEqual(['unknown']);
    expect(getLibraryObjectFilterTags('Galaxy')).not.toContain('unknown');
  });

  it('keeps deep-sky grouping tags', () => {
    expect(getLibraryObjectFilterTags('Spiral Galaxy')).toContain('galaxy');
    expect(getLibraryObjectFilterTags('Open Cluster')).toContain('cluster');
    expect(getLibraryObjectFilterTags('Planetary Nebula')).toContain('planetary-nebula');
    expect(getLibraryObjectFilterTags('Planetary Nebula')).not.toContain('solar-system');
    expect(getLibraryObjectFilterTags('Star Cloud')).not.toContain('solar-system');
  });
});
