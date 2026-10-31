/**
 * Finding the library again when its drive comes back at a different path. The search itself is pure (the drives are
 * passed in), so these run it against a fake tree: a map from folder to the folders inside it and the marker it holds.
 */
import { describe, it, expect } from 'vitest';
import { locateLibrary, pathBelowVolume, type LocatorDeps } from '../../server/lib/libraryLocator';

interface FakeFolder { marker?: string; retired?: boolean; children?: string[] }

function fakeDrives(tree: Record<string, FakeFolder>, over: Partial<LocatorDeps> = {}): LocatorDeps & { visited: string[] } {
  const visited: string[] = [];
  return {
    libraryId: 'ours',
    configuredPath: '/Volumes/Drive/Astro/library',
    volumeRoots: ['/Volumes/Drive 1'],
    platform: 'darwin',
    visited,
    readMarkerId: async dir => { visited.push(dir); return tree[dir]?.marker ?? null; },
    isRetired: async dir => tree[dir]?.retired === true,
    listDirs: async dir => {
      const folder = tree[dir];
      if (!folder) throw new Error('ENOENT');
      return folder.children ?? [];
    },
    ...over,
  };
}

describe('pathBelowVolume', () => {
  it.each([
    ['darwin', '/Volumes/Drive/Astro/library', 'Astro/library'],
    ['darwin', '/Volumes/Drive', ''],
    ['win32', 'E:\\Astro\\library', 'Astro\\library'],
    ['win32', 'E:\\', ''],
    ['linux', '/media/me/Drive/Astro/library', 'Astro/library'],
    ['linux', '/mnt/Drive/library', 'library'],
    ['linux', '/home/me/library', ''],
  ] as const)('%s %s -> %s', (platform, p, expected) => {
    expect(pathBelowVolume(p, platform)).toBe(expected);
  });
});

describe('locateLibrary', () => {
  it('finds the library at the same place on the volume that came back under a new name', async () => {
    const result = await locateLibrary(fakeDrives({
      '/Volumes/Drive 1': { children: ['Astro'] },
      '/Volumes/Drive 1/Astro': { children: ['library'] },
      '/Volumes/Drive 1/Astro/library': { marker: 'ours' },
    }));
    expect(result).toEqual({ status: 'found', dir: '/Volumes/Drive 1/Astro/library' });
  });

  it('finds a library kept at the root of the drive', async () => {
    const result = await locateLibrary(fakeDrives({ '/Volumes/Drive 1': { marker: 'ours' } }));
    expect(result).toEqual({ status: 'found', dir: '/Volumes/Drive 1' });
  });

  it('finds it a couple of folders down when the layout is not the same', async () => {
    const result = await locateLibrary(fakeDrives({
      '/Volumes/Drive 1': { children: ['Backups', 'Photos'] },
      '/Volumes/Drive 1/Photos': { children: ['Seestar'] },
      '/Volumes/Drive 1/Photos/Seestar': { marker: 'ours' },
    }));
    expect(result).toEqual({ status: 'found', dir: '/Volumes/Drive 1/Photos/Seestar' });
  });

  it('answers nothing when no drive holds the library', async () => {
    const result = await locateLibrary(fakeDrives({ '/Volumes/Drive 1': { children: ['Photos'] }, '/Volumes/Drive 1/Photos': {} }));
    expect(result).toEqual({ status: 'none' });
  });

  it('ignores another library\'s marker', async () => {
    const result = await locateLibrary(fakeDrives({ '/Volumes/Drive 1': { marker: 'someone-elses' } }));
    expect(result).toEqual({ status: 'none' });
  });

  it('never offers the saved path itself', async () => {
    const result = await locateLibrary(fakeDrives(
      { '/Volumes/Drive/Astro/library': { marker: 'ours' }, '/Volumes/Drive': { children: ['Astro'] }, '/Volumes/Drive/Astro': { children: ['library'] } },
      { volumeRoots: ['/Volumes/Drive'] },
    ));
    expect(result).toEqual({ status: 'none' });
  });

  it('skips an old copy that a move left behind, and takes the real one', async () => {
    const result = await locateLibrary(fakeDrives(
      {
        '/Volumes/Old': { marker: 'ours', retired: true },
        '/Volumes/Drive 1': { marker: 'ours' },
      },
      { volumeRoots: ['/Volumes/Old', '/Volumes/Drive 1'] },
    ));
    expect(result).toEqual({ status: 'found', dir: '/Volumes/Drive 1' });
  });

  it('reconnects to nothing when only an old copy is left', async () => {
    const result = await locateLibrary(fakeDrives({ '/Volumes/Old': { marker: 'ours', retired: true } }, { volumeRoots: ['/Volumes/Old'] }));
    expect(result).toEqual({ status: 'none' });
  });

  it('will not choose between two folders that both claim to be the library', async () => {
    const result = await locateLibrary(fakeDrives(
      { '/Volumes/A': { marker: 'ours' }, '/Volumes/B': { marker: 'ours' } },
      { volumeRoots: ['/Volumes/A', '/Volumes/B'] },
    ));
    expect(result).toEqual({ status: 'ambiguous', dirs: ['/Volumes/A', '/Volumes/B'] });
  });

  it('stops looking after the folder budget, so a huge drive cannot stall a request', async () => {
    const children = Array.from({ length: 5_000 }, (_, i) => `f${i}`);
    const deps = fakeDrives({ '/Volumes/Drive 1': { children } });
    const result = await locateLibrary({ ...deps, maxFolders: 50 });
    expect(result).toEqual({ status: 'none' });
    expect(deps.visited.length).toBeLessThanOrEqual(60);
  });

  it('does not look inside folders that are never a library', async () => {
    const deps = fakeDrives({
      '/Volumes/Drive 1': { children: ['.Trashes', '$RECYCLE.BIN', 'System Volume Information', 'Photos'] },
      '/Volumes/Drive 1/Photos': {},
    });
    await locateLibrary(deps);
    expect(deps.visited.some(v => /Trashes|RECYCLE|System Volume/.test(v))).toBe(false);
  });
});
