import { describe, it, expect } from 'vitest';
import { validateLocateInput, locateFolderOnDisk } from '../../server/lib/folderLocate';

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
