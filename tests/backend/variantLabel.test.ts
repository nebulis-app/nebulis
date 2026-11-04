import { describe, it, expect } from 'vitest';
import { variantLabelOf } from '../../src/lib/variantLabel';

describe('variantLabelOf', () => {
  it.each([
    ['NGC6960_mosaic', 'Mosaic'],
    ['M 31_Mosaic', 'Mosaic'],
    ['mosaic', null],
    ['M16_Ha', 'Hα'],
    ['IC1396_oiii', 'OIII'],
    ['M31', null],
    ['NGC7000', null],
  ])('%s -> %s', (id, label) => {
    expect(variantLabelOf(id)).toBe(label);
  });
});
