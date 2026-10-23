import { describe, it, expect } from 'vitest';
import { parseDsoRecord, normalizeCatalogNumber, displayDesignation, formatRaText, formatDecText } from '../../server/lib/dsoCatalogData';

// dso-catalog.json is validated record by record at load (parseDsoRecord). A
// field of the wrong type must read as absent rather than flow through typed
// as valid, and a record without an id or name is dropped.
describe('parseDsoRecord', () => {
  it('carries every well-typed field through', () => {
    const r = parseDsoRecord({
      id: 'M42', name: 'Orion Nebula', names: ['Great Orion Nebula'], designations: ['M42', 'NGC1976'],
      type: 'Emission Nebula', typeCode: 'Cl+N', constellation: 'Orion', ra: 5.588, dec: -5.39,
      magnitude: 4, sizeArcmin: 85, distanceLy: 1344, listed: 'M42', curated: true,
      sharpless: { ra: 83.8, dec: -5.4, sizeArcmin: 90 }, description: 'Bright.', wikiUrl: 'https://x',
      reviewedAt: '2026-01-01', sources: { name: 'https://y' },
    });
    expect(r).toMatchObject({
      id: 'M42', name: 'Orion Nebula', names: ['Great Orion Nebula'], designations: ['M42', 'NGC1976'],
      typeCode: 'Cl+N', ra: 5.588, dec: -5.39, magnitude: 4, sizeArcmin: 85, distanceLy: 1344,
      listed: 'M42', curated: true, sharpless: { ra: 83.8, dec: -5.4, sizeArcmin: 90 }, reviewedAt: '2026-01-01',
      sources: { name: 'https://y' },
    });
  });

  it('reads wrongly typed optional fields as absent', () => {
    const r = parseDsoRecord({
      id: 'NGC9991', name: 'Bad Optionals', names: 'x', designations: 'NGC9991', type: 7, ra: 'x', dec: null,
      magnitude: '9.5', sizeArcmin: 'big', listed: 3, curated: 'yes', sharpless: { ra: 'a' }, sources: { a: 1, b: 'ok' },
    })!;
    expect(r.names).toEqual([]);
    expect(r.designations).toEqual(['NGC9991']);
    expect(r.type).toBe('Unknown');
    expect([r.ra, r.dec, r.magnitude, r.sizeArcmin, r.listed]).toEqual([null, null, null, null, null]);
    expect(r.curated).toBe(false);
    expect(r.sharpless).toBeNull();
    expect(r.sources).toEqual({ b: 'ok' });
  });

  it('puts the id among the designations when the record left it out', () => {
    expect(parseDsoRecord({ id: 'IC63', name: 'Ghost of Cassiopeia', designations: ['LBN622'] })!.designations).toEqual(['IC63', 'LBN622']);
  });

  it('drops a record without an id or a name, or that is not an object', () => {
    expect(parseDsoRecord({ name: 'No id' })).toBeNull();
    expect(parseDsoRecord({ id: 'NGC1' })).toBeNull();
    expect(parseDsoRecord('NGC1')).toBeNull();
    expect(parseDsoRecord(null)).toBeNull();
  });
});

describe('designation spelling', () => {
  it('folds every catalog prefix to one spelling, without zero padding', () => {
    expect(normalizeCatalogNumber('NGC 0224')).toBe('NGC224');
    expect(normalizeCatalogNumber('Mel022')).toBe('MEL22');
    expect(normalizeCatalogNumber('Melotte 22')).toBe('MEL22');
    expect(normalizeCatalogNumber('sharpless 190')).toBe('SH2-190');
    expect(normalizeCatalogNumber('Caldwell 5')).toBe('C5');
    expect(normalizeCatalogNumber('M040')).toBe('M40');
    expect(normalizeCatalogNumber('M31_mosaic')).toBeNull();
    expect(normalizeCatalogNumber('Andromeda Galaxy')).toBeNull();
  });

  it('writes catalog numbers the way people do', () => {
    expect(displayDesignation('SH2-190')).toBe('Sh2-190');
    expect(displayDesignation('MEL22')).toBe('Mel22');
    expect(displayDesignation('VDB141')).toBe('vdB141');
    expect(displayDesignation('NGC224')).toBe('NGC224');
  });

  it('formats coordinates in the curated notation', () => {
    expect(formatRaText(5.587917)).toBe('05h 35m 16.5s');
    expect(formatDecText(-5.389722)).toBe('-05° 23′ 23″');
    expect(formatDecText(62.041667)).toBe('+62° 02′ 30″');
    expect(formatRaText(23.99999)).toBe('00h 00m 0s');
  });
});
