import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateLocateInput, locateFolderOnDisk, locateFolderInRoots } from '../../server/lib/folderLocate';

const sample = (relativePath: string, size = 10) => ({ relativePath, size });

describe('validateLocateInput', () => {
  it('accepts a plain folder name with safe relative paths', () => {
    expect(validateLocateInput('M31', [sample('lights/a.fits'), sample('b.jpg')])).toBe(true);
  });

  it('rejects an empty anchor name', () => {
    expect(validateLocateInput('', [sample('a.fits')])).toBe(false);
  });

  it('rejects anchor names containing path separators or dot segments', () => {
    expect(validateLocateInput('a/b', [sample('a.fits')])).toBe(false);
    expect(validateLocateInput('a\\b', [sample('a.fits')])).toBe(false);
    expect(validateLocateInput('..', [sample('a.fits')])).toBe(false);
    expect(validateLocateInput('.', [sample('a.fits')])).toBe(false);
  });

  it('rejects empty and oversized sample lists', () => {
    expect(validateLocateInput('M31', [])).toBe(false);
    const many = Array.from({ length: 65 }, (_, i) => sample(`f${i}.fits`));
    expect(validateLocateInput('M31', many)).toBe(false);
  });

  it('rejects traversal and absolute sample paths', () => {
    expect(validateLocateInput('M31', [sample('../etc/hosts')])).toBe(false);
    expect(validateLocateInput('M31', [sample('a/../../b.fits')])).toBe(false);
    expect(validateLocateInput('M31', [sample('/etc/hosts')])).toBe(false);
    expect(validateLocateInput('M31', [sample('a\\b.fits')])).toBe(false);
    expect(validateLocateInput('M31', [sample('a//b.fits')])).toBe(false);
  });

  it('rejects non-finite and negative sizes', () => {
    expect(validateLocateInput('M31', [sample('a.fits', -1)])).toBe(false);
    expect(validateLocateInput('M31', [sample('a.fits', Number.NaN)])).toBe(false);
  });
});

describe('locateFolderOnDisk', () => {
  it('returns null for invalid input without walking the disk', async () => {
    const start = Date.now();
    expect(await locateFolderOnDisk('..', [sample('a.fits')])).toBeNull();
    expect(await locateFolderOnDisk('M31', [sample('../x')])).toBeNull();
    // Rejection must be immediate, not a timed-out search.
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('locateFolderInRoots', () => {
  const made: string[] = [];
  function tempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locate-'));
    made.push(dir);
    return dir;
  }
  function makeFolder(base: string, rel: string, files: Record<string, number>): string {
    const dir = path.join(base, ...rel.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, size] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(size));
    }
    return dir;
  }
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const samples = [sample('lights/a.fits', 100), sample('b.jpg', 50)];
  const files = { 'lights/a.fits': 100, 'b.jpg': 50 };

  it('finds a folder a few levels down and returns it as the scan root', async () => {
    const root = tempRoot();
    const dir = makeFolder(root, 'Astro/2025/M31', files);
    expect(await locateFolderInRoots([root], 'M31', samples)).toBe(dir);
  });

  it('returns the folder itself, not its parent, when the sample paths carry the folder name', async () => {
    const root = tempRoot();
    makeFolder(root, 'Astro/M31', files);
    makeFolder(root, 'Astro/NGC7000', files);
    const withAnchor = [sample('M31/lights/a.fits', 100), sample('M31/b.jpg', 50)];
    expect(await locateFolderInRoots([root], 'M31', withAnchor)).toBe(path.join(root, 'Astro', 'M31'));
  });

  it('returns a flat folder itself, so its neighbours are never offered', async () => {
    const root = tempRoot();
    makeFolder(root, 'Astro/IC444', { 'Light_0001.fit': 100, 'Light_0002.fit': 100 });
    makeFolder(root, 'Astro/M31/LIGHTS', { 'a.fit': 10 });
    const flat = [sample('IC444/Light_0001.fit', 100), sample('IC444/Light_0002.fit', 100)];
    expect(await locateFolderInRoots([root], 'IC444', flat)).toBe(path.join(root, 'Astro', 'IC444'));
  });

  it('ignores a same-named decoy whose file sizes differ', async () => {
    const root = tempRoot();
    makeFolder(root, 'old/M31', { 'lights/a.fits': 999, 'b.jpg': 50 });
    const real = makeFolder(root, 'new/M31', files);
    expect(await locateFolderInRoots([root], 'M31', samples)).toBe(real);
  });

  it('matches the folder name case-insensitively', async () => {
    const root = tempRoot();
    const dir = makeFolder(root, 'astro/m31', files);
    expect(await locateFolderInRoots([root], 'M31', samples)).toBe(dir);
  });

  it('gives up on a folder buried deeper than the search depth', async () => {
    const root = tempRoot();
    makeFolder(root, 'a/b/c/d/e/f/M31', files);
    expect(await locateFolderInRoots([root], 'M31', samples)).toBeNull();
  });

  it('does not let a wide root starve a later root', async () => {
    const wide = tempRoot();
    for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(wide, `d${i}`, 'x'), { recursive: true });
    const other = tempRoot();
    const dir = makeFolder(other, 'Astro/M31', files);
    expect(await locateFolderInRoots([wide, other], 'M31', samples)).toBe(dir);
  });

  it('treats an unreadable or missing root as a miss, not an error', async () => {
    const good = tempRoot();
    const dir = makeFolder(good, 'M31', files);
    const missing = path.join(os.tmpdir(), 'locate-does-not-exist-xyz');
    expect(await locateFolderInRoots([missing, good], 'M31', samples)).toBe(dir);
    expect(await locateFolderInRoots([missing], 'M31', samples)).toBeNull();
  });

  it('returns null with no roots, and stays inside its deadline on a miss', async () => {
    expect(await locateFolderInRoots([], 'M31', samples)).toBeNull();
    const root = tempRoot();
    for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(root, `d${i}`), { recursive: true });
    const start = Date.now();
    expect(await locateFolderInRoots([root], 'nope', samples, 200)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
