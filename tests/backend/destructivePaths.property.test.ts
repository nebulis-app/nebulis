import { describe, it, expect, afterAll } from 'vitest';
import * as fc from 'fast-check';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveContainedArchivePath, pathsOverlap } from '../../server/lib/archive/archivePath';
import { stageUploadDestPath } from '../../server/lib/library/uploadPath';
import { mergeArchiveRun, type ArchiveManifest } from '../../server/lib/archive/archiveManifest';
import type { ArchiveCandidate } from '../../server/lib/archive/archiveSelect';
import { skyToPixel, pixelToSky, parseWcs, type Wcs } from '../../server/lib/annotate/wcs';

/**
 * The invariants behind operations that delete or overwrite a user's files, stated for
 * arbitrary input instead of a hand-picked list: a path guard never lets a write escape
 * its root, a manifest merge never loses a recorded file, and the sky/pixel mapping that
 * decides which object an annotation names is its own inverse.
 */

const NUM_RUNS = 400;

// Pieces an attacker (or a bad filename) would use, mixed with ordinary names.
const piece = fc.constantFrom('a', 'b', 'M42', 'IMG 1.fit', '..', '.', '', '...', '....//', '%2e%2e', '..\\', 'x/y', '\\', '/', '\u0000', 'é', ' ', '~', 'C:', '..%2f');

describe('resolveContainedArchivePath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-contain-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns null or a strict descendant of the root, for any segments', () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 5 }), segments => {
        const out = resolveContainedArchivePath(root, ...segments);
        if (out !== null) {
          expect(out.startsWith(root + path.sep)).toBe(true);
          expect(out).not.toBe(root);
          expect(path.relative(root, out).split(path.sep)).not.toContain('..');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never accepts a segment that is itself a traversal', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b'), { maxLength: 3 }), fc.constantFrom('..', '.', ''), fc.array(fc.constantFrom('a', 'b'), { maxLength: 3 }), (before, bad, after) => {
        expect(resolveContainedArchivePath(root, ...before, bad, ...after)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('accepts plain names and puts them where the segments say', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/), { minLength: 1, maxLength: 4 }), segments => {
        expect(resolveContainedArchivePath(root, ...segments)).toBe(path.join(root, ...segments));
      }),
      { numRuns: 100 },
    );
  });

  it('refuses a relative or empty root', () => {
    fc.assert(
      fc.property(fc.constantFrom('', ' ', 'relative/dir', '.', '..'), fc.array(piece, { maxLength: 3 }), (badRoot, segments) => {
        expect(resolveContainedArchivePath(badRoot, ...segments)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

describe('pathsOverlap', () => {
  const absolute = fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 4 }).map(parts => path.sep + parts.join(path.sep));

  it('is symmetric', () => {
    fc.assert(fc.property(absolute, absolute, (a, b) => { expect(pathsOverlap(a, b)).toBe(pathsOverlap(b, a)); }), { numRuns: 300 });
  });

  it('a folder overlaps itself and anything inside it', () => {
    fc.assert(
      fc.property(absolute, fc.constantFrom('x', 'y'), (a, child) => {
        expect(pathsOverlap(a, a)).toBe(true);
        expect(pathsOverlap(a, path.join(a, child))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('sibling folders sharing a name prefix do not overlap', () => {
    expect(pathsOverlap('/data/library', '/data/library-old')).toBe(false);
  });

  it('two different folders do not overlap just because neither exists yet', () => {
    fc.assert(
      fc.property(absolute, absolute, (a, b) => {
        fc.pre(a !== b && !a.startsWith(b + path.sep) && !b.startsWith(a + path.sep));
        expect(pathsOverlap(a, b)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('a folder still to be created beside an existing one does not overlap it', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-overlap-'));
    try {
      fs.mkdirSync(path.join(parent, 'photos'));
      expect(pathsOverlap(path.join(parent, 'archive'), path.join(parent, 'photos'))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('still sees through a symlinked parent to the folder it points at', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-overlap-'));
    try {
      fs.mkdirSync(path.join(parent, 'real'));
      fs.symlinkSync(path.join(parent, 'real'), path.join(parent, 'link'));
      // link/new does not exist, but it will be created inside real/.
      expect(pathsOverlap(path.join(parent, 'link', 'new'), path.join(parent, 'real'))).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('stageUploadDestPath', () => {
  const tmp = path.join(os.tmpdir(), 'nebulis-stage-root');

  it('returns null or a path strictly inside the staging dir, for arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), raw => {
        const out = stageUploadDestPath(tmp, raw);
        if (out !== null) expect(out.startsWith(tmp + path.sep)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns null or a contained path for traversal-shaped webkitRelativePath values', () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 6 }).map(parts => parts.join('/')), raw => {
        const out = stageUploadDestPath(tmp, raw);
        if (out !== null) {
          expect(out.startsWith(tmp + path.sep)).toBe(true);
          expect(path.relative(tmp, out).split(path.sep)).not.toContain('..');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps an ordinary relative path as given', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/), { minLength: 1, maxLength: 4 }), parts => {
        expect(stageUploadDestPath(tmp, parts.join('/'))).toBe(path.join(tmp, ...parts));
      }),
      { numRuns: 100 },
    );
  });
});

describe('mergeArchiveRun', () => {
  const names = fc.constantFrom('M31', 'M42', 'NGC 7000');
  const candidate = fc.record({
    objectId: names,
    relPath: fc.constantFrom('2026-10-01/a.fit', '2026-10-01/b.fit', '2026-10-02/c.jpg', 'd.fit'),
    role: fc.constantFrom('sub', 'stacked'),
    bytes: fc.integer({ min: 1, max: 1_000_000 }),
    mtimeMs: fc.integer({ min: 1, max: 2_000_000_000_000 }),
  }).map(c => ({ ...c, folderName: c.objectId.replace(/\s+/g, '_'), fileName: path.posix.basename(c.relPath) }) as unknown as ArchiveCandidate);
  const candidates = fc.array(candidate, { maxLength: 12 });
  const empty: ArchiveManifest = { version: 2, updatedAt: '2026-10-01T00:00:00Z', objects: {} };
  const T1 = '2026-11-01T00:00:00Z';
  const T2 = '2026-11-02T00:00:00Z';

  const relPaths = (m: ArchiveManifest, folder: string) => (m.objects[folder]?.files ?? []).map(f => f.relPath);

  it('is idempotent: merging the same run twice equals merging it once', () => {
    fc.assert(
      fc.property(candidates, cs => {
        const once = mergeArchiveRun(empty, cs, T1);
        expect(mergeArchiveRun(once, cs, T1)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });

  it('never loses a recorded file, whatever a later run brings', () => {
    fc.assert(
      fc.property(candidates, candidates, (first, second) => {
        const before = mergeArchiveRun(empty, first, T1);
        const after = mergeArchiveRun(before, second, T2);
        for (const folder of Object.keys(before.objects)) {
          for (const rel of relPaths(before, folder)) expect(relPaths(after, folder)).toContain(rel);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('records every landed candidate, with no duplicate paths and a stable order', () => {
    fc.assert(
      fc.property(candidates, cs => {
        const merged = mergeArchiveRun(empty, cs, T1);
        for (const c of cs) expect(relPaths(merged, c.folderName)).toContain(c.relPath);
        for (const folder of Object.keys(merged.objects)) {
          const rels = relPaths(merged, folder);
          expect(new Set(rels).size).toBe(rels.length);
          expect(rels).toEqual([...rels].sort((a, b) => a.localeCompare(b)));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keeps firstArchivedAt for the same object and restarts it for a different one in the same folder', () => {
    const base = (objectId: string) => ({ objectId, folderName: 'Folder', relPath: 'a.fit', role: 'sub', bytes: 1, mtimeMs: 1, fileName: 'a.fit' }) as unknown as ArchiveCandidate;
    const first = mergeArchiveRun(empty, [base('M31')], T1);
    expect(mergeArchiveRun(first, [base('M31')], T2).objects.Folder.firstArchivedAt).toBe(T1);
    const swapped = mergeArchiveRun(first, [base('M42')], T2);
    expect(swapped.objects.Folder.firstArchivedAt).toBe(T2);
    expect(swapped.objects.Folder.files.map(f => f.relPath)).toContain('a.fit');
  });
});

describe('WCS projection', () => {
  const wcsArb: fc.Arbitrary<Wcs> = fc.record({
    crval1: fc.double({ min: 0, max: 359.9, noNaN: true }),
    crval2: fc.double({ min: -75, max: 75, noNaN: true }),
    width: fc.integer({ min: 200, max: 4000 }),
    height: fc.integer({ min: 200, max: 4000 }),
    scale: fc.double({ min: 2e-4, max: 2e-3, noNaN: true }), // degrees per pixel, about 0.7 to 7 arcsec
    angle: fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
    flip: fc.boolean(),
    yDown: fc.boolean(),
  }).map(({ scale, angle, flip, ...r }) => {
    const sign = flip ? -1 : 1;
    return {
      ...r,
      // Same -0 rule as `cd` below: fc.double can draw -0 for crval2, and JSON stores it as 0.
      crval1: r.crval1 + 0,
      crval2: r.crval2 + 0,
      crpix1: r.width / 2,
      crpix2: r.height / 2,
      // `+ 0` turns -0 into 0: JSON has no negative zero, so a stored -0 reads back as 0.
      cd: { cd11: -scale * Math.cos(angle) * sign + 0, cd12: scale * Math.sin(angle) + 0, cd21: -scale * Math.sin(angle) * sign + 0, cd22: -scale * Math.cos(angle) + 0 },
    };
  });

  it('skyToPixel inverts pixelToSky for every in-frame pixel', () => {
    fc.assert(
      fc.property(wcsArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (wcs, fx, fy) => {
        const x = fx * (wcs.width - 1);
        const y = fy * (wcs.height - 1);
        const sky = pixelToSky(wcs, x, y);
        const back = skyToPixel(wcs, sky.raDeg, sky.decDeg);
        expect(back).not.toBeNull();
        expect(back!.x).toBeCloseTo(x, 2);
        expect(back!.y).toBeCloseTo(y, 2);
      }),
      { numRuns: 300 },
    );
  });

  it('a pixel maps to a valid sky position', () => {
    fc.assert(
      fc.property(wcsArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (wcs, fx, fy) => {
        const sky = pixelToSky(wcs, fx * wcs.width, fy * wcs.height);
        expect(sky.decDeg).toBeGreaterThanOrEqual(-90);
        expect(sky.decDeg).toBeLessThanOrEqual(90);
        expect(Number.isFinite(sky.raDeg)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('parseWcs reads back exactly what JSON stored', () => {
    fc.assert(
      fc.property(wcsArb, wcs => {
        expect(parseWcs(JSON.parse(JSON.stringify(wcs)))).toEqual(wcs);
      }),
      { numRuns: 200 },
    );
  });

  it('parseWcs refuses a solution with any field missing or not a finite number', () => {
    fc.assert(
      fc.property(wcsArb, fc.constantFrom('crval1', 'crval2', 'crpix1', 'crpix2', 'width', 'height'), fc.constantFrom(undefined, null, 'x', NaN, Infinity), (wcs, field, bad) => {
        const broken: Record<string, unknown> = { ...wcs, [field]: bad };
        expect(parseWcs(JSON.parse(JSON.stringify(broken, (_k, v) => (v === undefined ? undefined : v))))).toBeNull();
      }),
      { numRuns: 150 },
    );
  });
});
