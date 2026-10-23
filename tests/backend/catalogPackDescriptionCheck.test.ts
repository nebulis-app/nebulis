import { describe, it, expect } from 'vitest';
import { descriptionLooksRight } from '../../server/lib/catalogPack/descriptionCheck';

const beehive = { name: 'Beehive Cluster', names: ['Praesepe'], designations: ['M44', 'NGC2632'] };
const box = { name: 'Box Nebula', names: [], designations: ['NGC6445'] };

describe('descriptionLooksRight', () => {
  it('rejects the article about a literal beehive', () => {
    expect(descriptionLooksRight('A beehive is an enclosed structure in which honey bees raise their young and produce honey.', beehive)).toBe(false);
  });

  it('accepts the cluster by name or by number', () => {
    expect(descriptionLooksRight('The Beehive Cluster is an open cluster in the constellation Cancer.', beehive)).toBe(true);
    expect(descriptionLooksRight('Messier 44, also known as Praesepe, is an open cluster.', beehive)).toBe(true);
    expect(descriptionLooksRight('M 44 is an open cluster in Cancer.', beehive)).toBe(true);
  });

  it('rejects a play named after the object', () => {
    expect(descriptionLooksRight('Little Gem is a play written by Dublin playwright Elaine Murphy.', box)).toBe(false);
  });

  it('does not match a number that is only the start of a longer one', () => {
    expect(descriptionLooksRight('NGC 64450 is a distant galaxy.', box)).toBe(false);
    expect(descriptionLooksRight('NGC 6445 is a planetary nebula in Sagittarius.', box)).toBe(true);
  });

  it('only reads the opening, so a late mention of the name does not count', () => {
    expect(descriptionLooksRight(`${'Unrelated words. '.repeat(40)}Box Nebula appears here.`, box)).toBe(false);
  });

  it('accepts a Sharpless number written Sh 2-12', () => {
    expect(descriptionLooksRight('Sh 2-12 is an HII region.', { name: 'Sh2-12', names: [], designations: ['SH2-12'] })).toBe(true);
    expect(descriptionLooksRight('Sh 2-123 is an HII region.', { name: 'Sh2-12', names: [], designations: ['SH2-12'] })).toBe(false);
  });
});
