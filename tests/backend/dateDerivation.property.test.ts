import { describe, it, expect, afterAll } from 'vitest';
import * as fc from 'fast-check';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveFromPath, deriveFileDate } from '../../server/lib/library/dateDerivation';
import { isPlausibleCalendarDate } from '../../server/lib/telescopeFiles';

/**
 * Property tests for the date-derivation chain. No DB. The deriveFileDate
 * regression writes one scratch file under the OS temp dir (removed after).
 */

const NUM_RUNS = 200;

const digits = (n: number) =>
  fc.array(fc.constantFrom(...'0123456789'.split('')), { minLength: n, maxLength: n }).map(a => a.join(''));

const segmentArb = fc.oneof(
  fc.string({ maxLength: 20 }).map(s => s.replace(/[/\\]/g, '_')),
  digits(8).map(d => `19${d.slice(2)}`),
  digits(8).map(d => `20${d.slice(2)}`),
  digits(8).map(d => `20${d.slice(2, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`),
  digits(8).map(d => `session_20${d.slice(2, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}_Ha`),
);

describe('deriveFromPath - property tests', () => {
  it('only ever returns a real calendar date from a folder segment', () => {
    fc.assert(
      fc.property(fc.array(segmentArb, { minLength: 1, maxLength: 5 }), segments => {
        const rel = [...segments, 'light_001.fits'].join('/');
        const derived = deriveFromPath(rel);
        if (derived) {
          expect(derived.source).toBe('folder');
          expect(isPlausibleCalendarDate(derived.date!)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('ignores the leaf filename and treats \\ and / the same', () => {
    fc.assert(
      fc.property(fc.array(segmentArb, { minLength: 1, maxLength: 4 }), segments => {
        const posix = deriveFromPath([...segments, 'x.fits'].join('/'));
        const win = deriveFromPath([...segments, 'x.fits'].join('\\'));
        expect(win).toEqual(posix);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('deriveFileDate - impossible filename date regression (audit bug 2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-datederiv-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('falls through to the folder date instead of returning a garbage filename date', () => {
    const name = 'Stacked_150_M42_10.0s_IRCUT_54805140-210530A.jpg';
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, '');
    const derived = deriveFileDate(abs, `M42/2024-01-15/${name}`, fs.statSync(abs), { useMtimeFallback: false });
    expect(derived).toEqual({ date: '2024-01-15', source: 'folder', time: null });
  });

  it('keeps a valid filename date with its time (unchanged behavior)', () => {
    const name = 'Stacked_150_M42_10.0s_IRCUT_20241015-210530A.jpg';
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, '');
    const derived = deriveFileDate(abs, `M42/2024-01-15/${name}`, fs.statSync(abs), { useMtimeFallback: false });
    expect(derived).toEqual({ date: '2024-10-15', source: 'filename', time: '210530' });
  });
});
