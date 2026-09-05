import { describe, it, expect } from 'vitest';
import {
  isContainerFolder,
  isNonObjectFolder,
  stripCaptureModeSuffix,
  targetFromFileName,
  groupByTarget,
  planObjectFolder,
} from '../../server/lib/library/objectDiscovery';

// Pure rules, no I/O: these are the decisions that used to be reimplemented per
// import path and drifted apart, so they are pinned here directly rather than
// only through a filesystem scan.

describe('isContainerFolder', () => {
  it('matches the SeeStar planetary dumping grounds, case-insensitively', () => {
    expect(isContainerFolder('Planetary_photo')).toBe(true);
    expect(isContainerFolder('planetary_photos')).toBe(true);
    expect(isContainerFolder('PLANETARY_PHOTO')).toBe(true);
  });

  it('does not match ordinary object folders', () => {
    expect(isContainerFolder('M 27')).toBe(false);
    expect(isContainerFolder('NGC7000')).toBe(false);
    // Substring, not the container itself.
    expect(isContainerFolder('my_planetary_photo_backup')).toBe(false);
  });
});

describe('stripCaptureModeSuffix', () => {
  it('strips a trailing SeeStar capture-mode suffix, case-insensitively', () => {
    expect(stripCaptureModeSuffix('Lunar_video')).toBe('Lunar');
    expect(stripCaptureModeSuffix('Jupiter_Photo')).toBe('Jupiter');
    expect(stripCaptureModeSuffix('Solar_VIDEO')).toBe('Solar');
  });

  it('leaves ordinary object folders untouched', () => {
    expect(stripCaptureModeSuffix('M 31')).toBe('M 31');
    expect(stripCaptureModeSuffix('NGC7000')).toBe('NGC7000');
    // Only a trailing suffix, not one mid-name.
    expect(stripCaptureModeSuffix('video_test_object')).toBe('video_test_object');
  });
});

describe('isNonObjectFolder', () => {
  it('matches the Dwarf folders that hold no observations, case-insensitively', () => {
    // These sit next to the observation folders on a Dwarf volume. Treating them
    // as objects created library entries named "CALI_FRAME"/"RESTACKED" and
    // imported darks and flats as light frames of an object by that name.
    // STARTRAILS was missed when the others were added, so it alone kept
    // producing a junk library object of that name.
    for (const name of ['CALI_FRAME', 'DWARF_DARK', 'RESTACKED', 'STARTRAILS']) {
      expect(isNonObjectFolder(name)).toBe(true);
      expect(isNonObjectFolder(name.toLowerCase())).toBe(true);
    }
  });

  it('matches the daytime capture-mode folders', () => {
    expect(isNonObjectFolder('Normal_Photos')).toBe(true);
    expect(isNonObjectFolder('Panoramas')).toBe(true);
    expect(isNonObjectFolder('Burst')).toBe(true);
    expect(isNonObjectFolder('Videos')).toBe(true);
  });

  it('does not match real object folders or Dwarf session folders', () => {
    expect(isNonObjectFolder('M31')).toBe(false);
    expect(isNonObjectFolder('NGC 7000')).toBe(false);
    expect(isNonObjectFolder('DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345')).toBe(false);
    // Substring, not the whole name: a user's own folder must survive.
    expect(isNonObjectFolder('M42_restacked')).toBe(false);
    expect(isNonObjectFolder('my videos of M31')).toBe(false);
  });

  it('is disjoint from isContainerFolder', () => {
    // A folder is either expanded into per-target objects or dropped, never both.
    expect(isNonObjectFolder('planetary_photo')).toBe(false);
    expect(isContainerFolder('cali_frame')).toBe(false);
  });
});

describe('targetFromFileName', () => {
  it('extracts the target a filename names', () => {
    expect(targetFromFileName('Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit')).toBe('M 27');
  });

  it('strips _thn so a thumbnail groups with its image', () => {
    expect(targetFromFileName('Stacked_150_M42_10.0s_IRCUT_20241015-210530A_thn.jpg')).toBe('M42');
  });

  it('returns null when the name encodes no target', () => {
    // parseFilename falls back to the whole filename, which is not a target.
    expect(targetFromFileName('notes.txt')).toBeNull();
  });
});

describe('groupByTarget', () => {
  it('separates files that name a target from those that do not', () => {
    const { byTarget, unnamed } = groupByTarget([
      'Stacked_30_M 27_10.0s_IRCUT_20250930-213816.fit',
      'Stacked_30_M 31_10.0s_IRCUT_20250930-213817.fit',
      'readme.txt',
    ]);
    expect([...byTarget.keys()].sort()).toEqual(['M 27', 'M 31']);
    expect(unnamed).toEqual(['readme.txt']);
  });
});

describe('planObjectFolder', () => {
  const stacked = (target: string, n: string) =>
    `Stacked_30_${target}_10.0s_IRCUT_20250930-2138${n}.fit`;

  it('keeps a single-target folder whole so its companion and nested dirs survive', () => {
    // The regression that dropped 1184 sub-frames: this used to split, which
    // pinned the source to top-level files and discarded the _sub companion.
    const plan = planObjectFolder('M 27', [stacked('M 27', '16'), stacked('M 27', '17')]);
    expect(plan).toEqual({ kind: 'whole', folderName: 'M 27' });
  });

  it('renames a folder to the target its files agree on', () => {
    const plan = planObjectFolder('session1', [stacked('M 27', '16')]);
    expect(plan).toEqual({ kind: 'whole', folderName: 'M 27' });
  });

  it('does not rename when some files name no target', () => {
    const plan = planObjectFolder('session1', [stacked('M 27', '16'), 'readme.txt']);
    expect(plan).toEqual({ kind: 'whole', folderName: 'session1' });
  });

  it('splits a folder that genuinely holds several targets', () => {
    const plan = planObjectFolder('Night1', [stacked('M 27', '16'), stacked('M 31', '17')]);
    expect(plan.kind).toBe('split');
    if (plan.kind !== 'split') return;
    expect(plan.groups.map(g => g.folderName).sort()).toEqual(['M 27', 'M 31']);
    expect(plan.leftover).toBeNull();
  });

  it('gives untargeted files in a mixed folder a home under the folder name', () => {
    const plan = planObjectFolder('Night1', [
      stacked('M 27', '16'), stacked('M 31', '17'), 'readme.txt',
    ]);
    expect(plan.kind).toBe('split');
    if (plan.kind !== 'split') return;
    expect(plan.leftover).toEqual({ folderName: 'Night1', fileNames: ['readme.txt'] });
  });

  it('always splits a container, even on a single target, and drops its untargeted files', () => {
    // A container must never become a library object itself, so a lone planet
    // still splits out rather than staying whole under the container's name.
    const plan = planObjectFolder('Planetary_photo', [
      '2026-03-31-194930-Jupiter.jpg', 'thumbs.db',
    ]);
    expect(plan.kind).toBe('split');
    if (plan.kind !== 'split') return;
    expect(plan.groups.map(g => g.folderName)).toEqual(['Jupiter']);
    expect(plan.leftover).toBeNull();
  });

  it('treats an empty folder as whole', () => {
    expect(planObjectFolder('M 27', [])).toEqual({ kind: 'whole', folderName: 'M 27' });
  });
});
