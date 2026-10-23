import { describe, it, expect } from 'vitest';
import { isOneOf, isOptionValue, isRecord } from '../../src/lib/typeGuards';
import { isObjectFavoriteVars, isImageFavoriteVars } from '../../src/lib/favoriteMutations';

describe('isOneOf', () => {
  const KINDS = ['seestar', 'dwarf'] as const;

  it('is true for a member and false for a non-member', () => {
    expect(isOneOf(KINDS, 'dwarf')).toBe(true);
    expect(isOneOf(KINDS, 'vespera')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isOneOf(KINDS, 'Dwarf')).toBe(false);
  });
});

describe('isOptionValue', () => {
  const OPTIONS = [{ value: 'date', label: 'Date' }, { value: 'name', label: 'Name' }] as const;

  it('matches option values, not labels', () => {
    expect(isOptionValue(OPTIONS, 'name')).toBe(true);
    expect(isOptionValue(OPTIONS, 'Name')).toBe(false);
  });

  it('is false for an empty option list', () => {
    expect(isOptionValue([], 'date')).toBe(false);
  });
});

describe('frontend isRecord', () => {
  it('accepts objects and rejects null and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(3)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('rejects arrays, matching the server-side guard', () => {
    expect(isRecord([])).toBe(false);
  });
});

describe('isObjectFavoriteVars', () => {
  it('accepts { objectId: string, next: boolean }', () => {
    expect(isObjectFavoriteVars({ objectId: 'M31', next: true })).toBe(true);
  });

  it('rejects wrong field types and missing fields', () => {
    expect(isObjectFavoriteVars({ objectId: 31, next: true })).toBe(false);
    expect(isObjectFavoriteVars({ objectId: 'M31', next: 'true' })).toBe(false);
    expect(isObjectFavoriteVars({ objectId: 'M31' })).toBe(false);
    expect(isObjectFavoriteVars(null)).toBe(false);
    expect(isObjectFavoriteVars(undefined)).toBe(false);
  });

  it('does not accept image-favorite vars', () => {
    expect(isObjectFavoriteVars({ imagePath: 'a.jpg', isFavorite: true })).toBe(false);
  });
});

describe('isImageFavoriteVars', () => {
  it('accepts { imagePath: string, isFavorite: boolean }', () => {
    expect(isImageFavoriteVars({ imagePath: 'M31/a.jpg', isFavorite: false })).toBe(true);
  });

  it('rejects wrong field types, missing fields, and object-favorite vars', () => {
    expect(isImageFavoriteVars({ imagePath: 'a.jpg', isFavorite: 1 })).toBe(false);
    expect(isImageFavoriteVars({ isFavorite: true })).toBe(false);
    expect(isImageFavoriteVars({ objectId: 'M31', next: true })).toBe(false);
    expect(isImageFavoriteVars('a.jpg')).toBe(false);
  });
});
