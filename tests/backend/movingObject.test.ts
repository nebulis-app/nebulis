import { describe, it, expect } from 'vitest';
import { isMovingObject, cometKey } from '../../server/lib/library/movingObject';

describe('isMovingObject', () => {
  it.each(['161P', 'C2025R3PANSTARRS', 'C2025A6-CometLemmon'])('treats %s as a comet by its id', id => {
    expect(isMovingObject(id)).toBe(true);
  });
  it.each(['Comet', 'Asteroid'])('treats type %s as moving', type => {
    expect(isMovingObject('Custom', type)).toBe(true);
  });
  it.each([['M31', 'Spiral Galaxy'], ['NGC7000', null], ['C14', 'Open Cluster'], ['Moon', 'Natural Satellite']] as const)(
    'leaves %s (%s) to the catalog and sky survey', (id, type) => {
      expect(isMovingObject(id, type)).toBe(false);
    },
  );
});

describe('cometKey', () => {
  it.each([
    ['C-2023A3', 'C/2023 A3'],
    ['C2023A3(Tsuchinshan-ATLAS)', 'C/2023 A3'],
    ['C/2023 A3', 'C/2023 A3'],
    ['C-2025A6', 'C/2025 A6'],
    ['C2025A6-CometLemmon', 'C/2025 A6'],
    ['C2025R3PANSTARRS', 'C/2025 R3'],
    ['C-2017K2', 'C/2017 K2'],
    ['P/2010 H2', 'P/2010 H2'],
    ['C/2020 AB12', 'C/2020 AB12'],
    ['161P', '161P'],
    ['161PHartley-IRAS', '161P'],
    ['12P_Pons-Brooks', '12P'],
    ['12P/Pons-Brooks', '12P'],
    ['73P-B', '73P-B'],
    ['206P Barnard', '206P'],
  ])('folds %s to %s', (id, key) => { expect(cometKey(id)).toBe(key); });

  it('gives different names for one comet the same key', () => {
    expect(cometKey('C-2023A3')).toBe(cometKey('C2023A3(Tsuchinshan-ATLAS)'));
  });

  it.each(['M31', 'NGC7000', 'C14', 'C6', 'SH2-155', 'M31_mosaic', '3C273', '51Peg', '61Cygni', '12C', 'CometLemmon', 'Moon', 'C2023ATLAS'])(
    'does not claim %s', id => { expect(cometKey(id)).toBeNull(); },
  );
});
