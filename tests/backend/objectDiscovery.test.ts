import { describe, it, expect } from 'vitest';
import {
  isContainerFolder,
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
