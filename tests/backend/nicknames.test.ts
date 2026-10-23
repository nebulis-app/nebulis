import { describe, it, expect } from 'vitest';
import { nicknamesFromFolderNames, mergeNicknames, parseNicknames } from '../../server/lib/library/nicknames';

const NGC188 = { catalogName: 'NGC188', aliases: ['C1'] };

describe('nicknamesFromFolderNames', () => {
  it('takes the name after the designation in a labelled folder', () => {
    expect(nicknamesFromFolderNames(['C 1 - Cepheus Old Cluster'], 'NGC188', NGC188)).toEqual(['Cepheus Old Cluster']);
  });

  it('drops a name the catalog already gives, however it is spelled', () => {
    expect(nicknamesFromFolderNames(['M 31 - Andromeda Galaxy'], 'M31', { catalogName: 'Andromeda Galaxy', aliases: [] })).toEqual([]);
    expect(nicknamesFromFolderNames(['M 31 - andromeda  galaxy'], 'M31', { catalogName: 'Andromeda Galaxy', aliases: [] })).toEqual([]);
  });

  it('ignores a folder whose designation is a different object, a second designation, or no separator', () => {
    expect(nicknamesFromFolderNames(['M 42 - Orion Nebula'], 'NGC188', NGC188)).toEqual([]);
    expect(nicknamesFromFolderNames(['C 1 - NGC 188'], 'NGC188', NGC188)).toEqual([]);
    expect(nicknamesFromFolderNames(['C 1'], 'NGC188', NGC188)).toEqual([]);
  });

  it('skips _sub folders and de-duplicates', () => {
    expect(nicknamesFromFolderNames(['C 1_sub', 'C 1 - Cepheus Old Cluster', 'C 1 - Cepheus Old  cluster'], 'NGC188', NGC188)).toEqual(['Cepheus Old Cluster']);
  });
});

describe('mergeNicknames', () => {
  it('adds only new names, case- and punctuation-insensitively, and survives bad JSON', () => {
    expect(mergeNicknames('["Polarissima Cluster"]', ['polarissima cluster', 'Other'])).toEqual(['Polarissima Cluster', 'Other']);
    expect(parseNicknames('not json')).toEqual([]);
    expect(parseNicknames(null)).toEqual([]);
  });
});
