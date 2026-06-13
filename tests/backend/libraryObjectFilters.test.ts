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
      'Star',
      'Planet',
      'Natural Satellite',
      'Dwarf Planet',
      'Asteroid',
      'Comet',
    ]);
  });

  it('tags solar system object types', () => {
    expect(getLibraryObjectFilterTags('Star')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Planet')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Natural Satellite')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Dwarf Planet')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Asteroid')).toContain('solar-system');
    expect(getLibraryObjectFilterTags('Comet')).toContain('solar-system');
  });

  it('keeps deep-sky grouping tags', () => {
    expect(getLibraryObjectFilterTags('Spiral Galaxy')).toContain('galaxy');
    expect(getLibraryObjectFilterTags('Open Cluster')).toContain('cluster');
    expect(getLibraryObjectFilterTags('Planetary Nebula')).toContain('planetary-nebula');
    expect(getLibraryObjectFilterTags('Planetary Nebula')).not.toContain('solar-system');
    expect(getLibraryObjectFilterTags('Star Cloud')).not.toContain('solar-system');
  });
});
