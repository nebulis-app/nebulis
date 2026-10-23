import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import {
  resolveArchiveRoot,
  resolveContainedArchivePath,
  isForbiddenDestination,
} from '../../server/lib/archive/archivePath';

/**
 * Containment and refusal for the external-archive destination.
 *
 * These tests exist before any code that writes or deletes, deliberately: the
 * archive feature's highest-ranked risk is retention pruning the wrong
 * directory, and its second is a copy-then-delete losing the only copy. Both are
 * only preventable if the destination can never resolve to the library, to
 * DATA_DIR, or to a path outside the configured archive root.
 *
 * The shape is copied from `objectTraversal.test.ts`, which guards the same
 * class of bug on the library side. Four audit criticals came from one unchecked
 * fallback there (`getFolderName` returning the raw id on a DB miss) reaching
 * sinks that joined it onto the library root. Every path in this feature is
 * built from user-supplied configuration, so it gets the same treatment.
 */

/** A real directory outside both the library and DATA_DIR.
 *
 *  The `-test-` infix matters: these are created beside DATA_DIR (the repo root
 *  under Vitest), and `.gitignore` covers the `nebulis-*-test-*` pattern, so a run
 *  that dies before its `afterEach` cleanup cannot leave an untracked directory
 *  sitting in the working tree for the public sync to trip over. */
function outsideDir(prefix = 'nebulis-archive-test-'): string {
  return fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
}

describe('resolveArchiveRoot — destination validation', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeOutside = (): string => {
    const dir = outsideDir();
    created.push(dir);
    return dir;
  };

  it('accepts an absolute path outside the library and DATA_DIR', () => {
    const dir = makeOutside();
    const result = resolveArchiveRoot(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.root).toBe(path.resolve(dir));
  });

  it('normalizes a trailing separator instead of rejecting a legitimate path', () => {
    const dir = makeOutside();
    const result = resolveArchiveRoot(`${dir}${path.sep}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.root).toBe(path.resolve(dir));
  });

  it('rejects an empty or whitespace-only path', () => {
    for (const value of ['', '   ']) {
      const result = resolveArchiveRoot(value);
      expect(result.ok, `expected "${value}" to be rejected`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('empty');
    }
  });

  it('rejects a relative path', () => {
    for (const value of ['archive', './archive', '../archive']) {
      const result = resolveArchiveRoot(value);
      expect(result.ok, `expected "${value}" to be rejected`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not-absolute');
    }
  });

  it('rejects the library directory and anything inside it', () => {
    const library = path.resolve(getLibraryDir());
    const cases: Array<[string, string]> = [
      ['the library root itself', library],
      ['a descendant of the library', path.join(library, 'M 31')],
      ['a descendant several levels down', path.join(library, 'M 31', '2024-10-08')],
    ];
    for (const [label, candidate] of cases) {
      const result = resolveArchiveRoot(candidate);
      expect(result.ok, `expected ${label} to be rejected: ${candidate}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('overlaps-library');
    }
  });

  it('rejects DATA_DIR and anything inside it', () => {
    const dataDir = path.resolve(DATA_DIR);
    const cases: Array<[string, string]> = [
      ['DATA_DIR itself', dataDir],
      ['a descendant of DATA_DIR', path.join(dataDir, 'backups')],
    ];
    for (const [label, candidate] of cases) {
      const result = resolveArchiveRoot(candidate);
      expect(result.ok, `expected ${label} to be rejected: ${candidate}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('overlaps-data-dir');
    }
  });

  it('rejects an ancestor of either, whichever overlap it reports', () => {
    // An ancestor of one is usually also an ancestor of the other (the library
    // lives under DATA_DIR by default), so which overlap gets named is arbitrary.
    // What matters is that it is refused at all.
    const candidates = [
      path.dirname(path.resolve(getLibraryDir())),
      path.dirname(path.resolve(DATA_DIR)),
    ];
    for (const candidate of candidates) {
      const result = resolveArchiveRoot(candidate);
      expect(result.ok, `expected ancestor ${candidate} to be rejected`).toBe(false);
      if (!result.ok) expect(['overlaps-library', 'overlaps-data-dir']).toContain(result.reason);
    }
  });

  it('rejects the filesystem root and other unusable roots', () => {
    for (const value of [path.parse(process.cwd()).root, '.', '..']) {
      const result = resolveArchiveRoot(value);
      expect(result.ok, `expected "${value}" to be rejected`).toBe(false);
    }
  });
});

describe('resolveContainedArchivePath — containment inside the archive root', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = outsideDir('nebulis-archive-test-root-');
    outside = outsideDir('nebulis-archive-test-escape-');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('resolves ordinary segments beneath the root', () => {
    const resolved = resolveContainedArchivePath(root, 'M 31', '2024-10-08', 'a.jpg');
    expect(resolved).toBe(path.join(path.resolve(root), 'M 31', '2024-10-08', 'a.jpg'));
  });

  it('refuses dot, dot-dot, and empty segments', () => {
    for (const segment of ['.', '..', '']) {
      expect(
        resolveContainedArchivePath(root, segment),
        `expected segment "${segment}" to be refused`,
      ).toBeNull();
    }
  });

  it('refuses a segment containing a separator or traversal tokens', () => {
    for (const segment of ['a/b', 'a\\b', '../../etc', 'a/../../..', 'a\u0000b']) {
      expect(
        resolveContainedArchivePath(root, segment),
        `expected segment "${segment}" to be refused`,
      ).toBeNull();
    }
  });

  it('treats a literally-encoded traversal token as the single harmless segment it is', () => {
    // Express decodes %2F and %2e inside a route param BEFORE the handler runs,
    // so '../../etc' above is the string that actually arrives. A literal
    // '..%2F..%2Fetc' reaching here is one ordinary filename segment, and is
    // deliberately allowed, matching the precedent documented in
    // objectTraversal.test.ts. Asserting it is refused would be testing a string
    // that cannot occur.
    expect(resolveContainedArchivePath(root, '..%2F..%2Fetc')).toBe(
      path.join(path.resolve(root), '..%2F..%2Fetc'),
    );
  });

  it('refuses an absolute path passed as a segment', () => {
    for (const segment of ['/etc', path.join(outside, 'x'), 'C:\\Windows']) {
      expect(
        resolveContainedArchivePath(root, segment),
        `expected segment "${segment}" to be refused`,
      ).toBeNull();
    }
  });

  it('refuses traversal assembled across several otherwise-valid segments', () => {
    expect(resolveContainedArchivePath(root, 'a', '..', '..', 'outside')).toBeNull();
  });

  it('refuses a symlink inside the root that points outside it', () => {
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link, 'dir');
    // Lexically this looks contained; it must still be refused, because a write
    // or a prune through it would land outside the archive root.
    expect(resolveContainedArchivePath(root, 'escape', 'file.jpg')).toBeNull();
  });

  it('allows a symlink that stays inside the root', () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, path.join(root, 'link'), 'dir');
    expect(resolveContainedArchivePath(root, 'link', 'file.jpg')).toBe(path.join(root, 'link', 'file.jpg'));
  });

  it('does not treat the root itself as a contained path', () => {
    expect(resolveContainedArchivePath(root)).toBeNull();
  });
});

describe('isForbiddenDestination — the single predicate later steps rely on', () => {
  it('is true for the library, DATA_DIR, their ancestors, and their descendants', () => {
    const library = path.resolve(getLibraryDir());
    const dataDir = path.resolve(DATA_DIR);
    const forbidden = [
      library,
      dataDir,
      path.dirname(library),
      path.dirname(dataDir),
      path.join(library, 'M 31'),
      path.join(dataDir, 'backups'),
    ];
    for (const candidate of forbidden) {
      expect(isForbiddenDestination(candidate), `expected ${candidate} to be forbidden`).toBe(true);
    }
  });

  it('is false for an unrelated directory', () => {
    const dir = outsideDir();
    try {
      expect(isForbiddenDestination(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
