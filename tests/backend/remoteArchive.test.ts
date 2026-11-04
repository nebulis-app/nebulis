import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-remotearchive-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

type Entry = { name: string; type: 'file' | 'dir'; size?: number };
type ListImpl = (dir: string) => Entry[];
const listCalls = vi.hoisted(() => [] as string[]);
const fakeListDir = vi.hoisted(() => ({ impl: ((): Entry[] => []) as ListImpl }));

vi.mock('../../server/lib/smb', () => ({
  smbListDir: async (dir: string) => {
    listCalls.push(dir);
    return fakeListDir.impl(dir);
  },
}));

import { collectRemoteArchiveCandidates, isMissingDirectoryError } from '../../server/lib/library/remoteArchive';
import { ASIAIR_CALIBRATION_WALK, ASIAIR_CALIBRATION_PATHS } from '../../server/lib/walkers/asiairWalker';
import type { TelescopeProfile } from '../../server/lib/telescopes';

const profile = {} as TelescopeProfile;

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  listCalls.length = 0;
  fakeListDir.impl = () => [];
});

const file = (name: string): Entry => ({ name, type: 'file', size: 10 });
const dir = (name: string): Entry => ({ name, type: 'dir' });

describe('collectRemoteArchiveCandidates — ASIAIR phantom recursive tree', () => {
  // The corrupted-EMMC shape: below `Autorun/Dark/` every directory holds the
  // same nine entries again, forever.
  const PHANTOM = ['Plan', 'Autorun', 'Preview', 'Live', 'log', 'Video', 'Dark', 'Flat', 'Bias'];
  const phantomTree = (d: string): Entry[] => {
    if (d.endsWith('Autorun/Dark')) return [file('dark_001.fit'), dir('Preview')];
    return PHANTOM.map(dir);
  };

  it('finishes with a handful of listings instead of exploding, and still returns the real frames', async () => {
    fakeListDir.impl = phantomTree;
    const out = await collectRemoteArchiveCandidates(profile, '/ASIAIR', ['Autorun/Dark'], ASIAIR_CALIBRATION_WALK);
    expect(out.map(c => c.relPath)).toEqual(['Autorun/Dark/dark_001.fit']);
    // Un-guarded, this tree is 9^12 listings. Guarded it is tiny.
    expect(listCalls.length).toBeLessThan(40);
  });

  it('cuts the branch at the first repeated folder name', async () => {
    fakeListDir.impl = phantomTree;
    await collectRemoteArchiveCandidates(profile, '/ASIAIR', ['Autorun/Dark'], ASIAIR_CALIBRATION_WALK);
    // `Autorun/Dark/Preview/Autorun` is listed (Autorun is new only if it is
    // not already a segment — it is, so it must not be).
    expect(listCalls).not.toContain('/ASIAIR/Autorun/Dark/Preview/Autorun');
    expect(listCalls).not.toContain('/ASIAIR/Autorun/Dark/Preview/Dark');
  });

  it('covers every ASIAIR calibration folder within the same bound', async () => {
    fakeListDir.impl = (d) => (/^\/ASIAIR\/(Autorun|Plan)\/(Dark|Flat|Bias|FlatDark)$/.test(d) ? [file('f.fit'), dir('Preview')] : PHANTOM.map(dir));
    const out = await collectRemoteArchiveCandidates(profile, '/ASIAIR', ASIAIR_CALIBRATION_PATHS, ASIAIR_CALIBRATION_WALK);
    expect(out).toHaveLength(ASIAIR_CALIBRATION_PATHS.length);
    expect(listCalls.length).toBeLessThan(400);
  });
});

describe('collectRemoteArchiveCandidates — defaults leave ordinary trees alone', () => {
  it('descends past three levels and through a repeated folder name when no limits are passed', async () => {
    fakeListDir.impl = (d) => {
      if (d === '/Photos') return [dir('2024')];
      if (d === '/Photos/2024') return [dir('Photos')]; // legitimate repeated name
      if (d === '/Photos/2024/Photos') return [dir('a')];
      if (d === '/Photos/2024/Photos/a') return [dir('b')];
      if (d === '/Photos/2024/Photos/a/b') return [file('deep.fit')];
      return [];
    };
    const out = await collectRemoteArchiveCandidates(profile, '/', ['Photos']);
    expect(out.map(c => c.relPath)).toEqual(['Photos/2024/Photos/a/b/deep.fit']);
  });

  it('counts depth below the swept folder, not the device path above it', async () => {
    fakeListDir.impl = (d) => {
      if (d === '/My Images/Astronomy/Dwarf/DWARF 3/CALI_FRAME') return [dir('x')];
      if (d === '/My Images/Astronomy/Dwarf/DWARF 3/CALI_FRAME/x') return [file('dark.fits')];
      return [];
    };
    const out = await collectRemoteArchiveCandidates(
      profile, '/My Images/Astronomy/Dwarf/DWARF 3', ['CALI_FRAME'], { maxDepth: 3, skipRepeatedSegments: true },
    );
    expect(out.map(c => c.relPath)).toEqual(['CALI_FRAME/x/dark.fits']);
  });

  it('a repeated name in the base path never trips the repeat guard', async () => {
    fakeListDir.impl = (d) => {
      if (d === '/Astro/Astro/Dark') return [file('d.fit')];
      return [];
    };
    const out = await collectRemoteArchiveCandidates(profile, '/Astro/Astro', ['Dark'], ASIAIR_CALIBRATION_WALK);
    expect(out).toHaveLength(1);
  });

  it('honours maxDepth', async () => {
    fakeListDir.impl = (d) => {
      const depth = d.split('/').length - 2; // '/A' -> 0
      return depth < 6 ? [dir('n'), file(`f${depth}.fit`)] : [];
    };
    const out = await collectRemoteArchiveCandidates(profile, '/', ['A'], { maxDepth: 2 });
    // 'A' is depth 0, so a file at depth 2 has 3 directory segments.
    expect(Math.max(...out.map(c => c.relPath.split('/').length - 1))).toBe(3);
  });
});

describe('collectRemoteArchiveCandidates — cancel and dead-device handling', () => {
  it('stops listing as soon as shouldCancel turns true', async () => {
    let cancelled = false;
    fakeListDir.impl = (d) => {
      cancelled = true; // first listing flips the flag
      return d === '/A' ? [dir('b'), dir('c')] : [file('x.fit')];
    };
    const out = await collectRemoteArchiveCandidates(profile, '/', ['A', 'B'], { shouldCancel: () => cancelled });
    expect(listCalls).toEqual(['/A']);
    expect(out).toEqual([]);
  });

  it('does not list anything when already cancelled', async () => {
    await collectRemoteArchiveCandidates(profile, '/', ['A'], { shouldCancel: () => true });
    expect(listCalls).toEqual([]);
  });

  it('abandons the sweep after repeated back-to-back listing failures', async () => {
    fakeListDir.impl = () => { throw new Error('smbclient timed out'); };
    await collectRemoteArchiveCandidates(profile, '/', ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(listCalls).toHaveLength(3);
  });

  it('a success between failures resets the count', async () => {
    fakeListDir.impl = (d) => {
      if (d === '/b') return [];
      throw new Error('boom');
    };
    await collectRemoteArchiveCandidates(profile, '/', ['a', 'b', 'c', 'd', 'e']);
    // a fails, b succeeds (reset), then c, d, e fail -> stop after e.
    expect(listCalls).toEqual(['/a', '/b', '/c', '/d', '/e']);
  });
});

describe('collectRemoteArchiveCandidates — folders the device does not have', () => {
  const notFound = () => new Error('SMB connection failed: NT_STATUS_OBJECT_NAME_NOT_FOUND');

  it('still reaches Plan/ when the first Autorun folders are absent (ASIAIR that keeps calibration under Plan)', async () => {
    fakeListDir.impl = (d) => {
      if (d === '/ASIAIR/Plan/Dark') return [file('d.fit')];
      throw notFound();
    };
    const out = await collectRemoteArchiveCandidates(profile, '/ASIAIR', ASIAIR_CALIBRATION_PATHS, ASIAIR_CALIBRATION_WALK);
    expect(out.map(c => c.relPath)).toEqual(['Plan/Dark/d.fit']);
    expect(listCalls).toHaveLength(ASIAIR_CALIBRATION_PATHS.length);
  });

  it('finds Plan/ after a lone Autorun/Dark with Flat, Bias and FlatDark absent', async () => {
    fakeListDir.impl = (d) => {
      if (d === '/ASIAIR/Autorun/Dark') return [file('a.fit')];
      if (d === '/ASIAIR/Plan/Flat') return [file('f.fit')];
      throw notFound();
    };
    const out = await collectRemoteArchiveCandidates(profile, '/ASIAIR', ASIAIR_CALIBRATION_PATHS, ASIAIR_CALIBRATION_WALK);
    expect(out.map(c => c.relPath).sort()).toEqual(['Autorun/Dark/a.fit', 'Plan/Flat/f.fit']);
  });

  it('still abandons a sweep whose failures are not "not found" (timeouts, refusals)', async () => {
    fakeListDir.impl = () => { throw new Error('SMB connection failed: Connection timed out'); };
    await collectRemoteArchiveCandidates(profile, '/', ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(listCalls).toHaveLength(3);
  });

  it('a long unbroken run of "not found" still ends the sweep (a dropped Windows share reads that way)', async () => {
    fakeListDir.impl = () => { throw notFound(); };
    const folders = Array.from({ length: 40 }, (_, i) => `f${i}`);
    await collectRemoteArchiveCandidates(profile, '/', folders);
    expect(listCalls).toHaveLength(12);
  });

  it('recognizes each backend\'s missing-directory error and nothing else', () => {
    for (const m of [
      'SMB connection failed: NT_STATUS_OBJECT_NAME_NOT_FOUND',
      'SMB connection failed: NT_STATUS_OBJECT_PATH_NOT_FOUND',
      "SMB connection failed: ENOENT: no such file or directory, scandir '\\\\nas\\share\\Autorun\\Dark'",
      'SMB connection failed: Share or folder not found',
    ]) expect(isMissingDirectoryError(new Error(m)), m).toBe(true);
    for (const m of [
      'SMB connection failed: Connection timed out',
      'SMB connection failed: Authentication failed',
      'SMB connection failed: NT_STATUS_ACCESS_DENIED',
      'SMB connection failed: smbclient is not installed on the server',
      'SMB connection failed: Host not found',
    ]) expect(isMissingDirectoryError(new Error(m)), m).toBe(false);
  });
});
