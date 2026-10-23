import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-replacefile-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { replaceLibraryFile, ReplaceFileError, ORIGINAL_BACKUPS_DIR, originalBackupFile, restoreOriginalBackup } from '../../server/lib/library/replaceFile';
import { LIBRARY_DIR } from '../../server/lib/paths';

const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
const PNG = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);

let staged: string;
const stage = (data: Buffer) => { staged = path.join(TEST_DATA_DIR, 'staged.bin'); fs.writeFileSync(staged, data); return staged; };

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.rmSync(ORIGINAL_BACKUPS_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(LIBRARY_DIR, 'M31'), { recursive: true });
});

describe('replaceLibraryFile', () => {
  it('rewrites the file and keeps the first original once', () => {
    const file = path.join(LIBRARY_DIR, 'M31', 'a.jpg');
    fs.writeFileSync(file, JPEG('original'));

    expect(replaceLibraryFile('M31/a.jpg', stage(JPEG('turn1')), { confirmLinked: false }).backedUp).toBe(true);
    expect(fs.readFileSync(file).toString('latin1')).toContain('turn1');

    expect(replaceLibraryFile('M31/a.jpg', stage(JPEG('turn2')), { confirmLinked: false }).backedUp).toBe(false);
    expect(fs.readFileSync(file).toString('latin1')).toContain('turn2');

    const [dir] = fs.readdirSync(ORIGINAL_BACKUPS_DIR);
    expect(fs.readFileSync(path.join(ORIGINAL_BACKUPS_DIR, dir, 'a.jpg')).toString('latin1')).toContain('original');
    expect(fs.readdirSync(path.join(LIBRARY_DIR, 'M31'))).toEqual(['a.jpg']);
  });

  it('refuses a different format than the original', () => {
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M31', 'a.png'), PNG('x'));
    expect(() => replaceLibraryFile('M31/a.png', stage(JPEG('y')), { confirmLinked: false })).toThrow(ReplaceFileError);
  });

  it('refuses formats it cannot rewrite and paths outside the library', () => {
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M31', 'a.fits'), 'x');
    expect(() => replaceLibraryFile('M31/a.fits', stage(JPEG('y')), { confirmLinked: false })).toThrow(/Only JPEG and PNG/);
    expect(() => replaceLibraryFile('../outside.jpg', stage(JPEG('y')), { confirmLinked: false })).toThrow(ReplaceFileError);
  });
});

describe('original backup', () => {
  it('is absent until the first replace, then readable, and restoring puts it back and forgets it', () => {
    const file = path.join(LIBRARY_DIR, 'M31', 'a.jpg');
    fs.writeFileSync(file, JPEG('original'));
    expect(originalBackupFile('M31/a.jpg')).toBeNull();
    expect(() => restoreOriginalBackup('M31/a.jpg', { confirmLinked: false })).toThrow(/no saved original/);

    replaceLibraryFile('M31/a.jpg', stage(JPEG('edited')), { confirmLinked: false });
    const backup = originalBackupFile('M31/a.jpg');
    expect(backup).not.toBeNull();
    expect(fs.readFileSync(backup!).toString('latin1')).toContain('original');

    restoreOriginalBackup('M31/a.jpg', { confirmLinked: false });
    expect(fs.readFileSync(file).toString('latin1')).toContain('original');
    expect(originalBackupFile('M31/a.jpg')).toBeNull();
    expect(fs.readdirSync(path.join(LIBRARY_DIR, 'M31'))).toEqual(['a.jpg']);
  });
});
