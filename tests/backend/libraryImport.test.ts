import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { stageUploadDestPath } from '../../server/lib/library/uploadPath';

// `stageUploadDestPath` is the single guard the folder-import upload route uses
// to map a client-supplied relative path onto the per-upload staging dir. It
// must contain every result inside tmpDir and reject anything that tries to
// escape via "..", an absolute path, backslash separators, or control chars.
// (Replaces the old `importUploadedFiles` suite — that function was folded into
// the two-phase upload-temp → commit flow during the import refactor.)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-stage-test-'));

function isContained(p: string): boolean {
  return p === tmpDir || p.startsWith(tmpDir + path.sep);
}

describe('stageUploadDestPath — upload staging traversal guard', () => {
  it('maps a benign relative path into the staging dir', () => {
    const dest = stageUploadDestPath(tmpDir, 'M31/M31_stacked_20241015.jpg');
    expect(dest).not.toBeNull();
    expect(isContained(dest!)).toBe(true);
    expect(path.basename(dest!)).toBe('M31_stacked_20241015.jpg');
    expect(path.basename(path.dirname(dest!))).toBe('M31');
  });

  it('strips ".." segments instead of escaping upward', () => {
    const dest = stageUploadDestPath(tmpDir, '../../../tmp/owned.fit');
    // ".." segments are dropped, leaving a contained path — never an escape.
    expect(dest).not.toBeNull();
    expect(isContained(dest!)).toBe(true);
    expect(dest!).toContain(`${path.sep}tmp${path.sep}owned.fit`);
    // Containment (line above) is the real guarantee. A literal `startsWith('/tmp/')`
    // check is meaningless here on Linux, where `os.tmpdir()` (and thus `tmpDir`
    // itself) already lives under /tmp — asserting containment already proves no
    // escape happened without relying on where the OS puts its temp dir.
  });

  it('neutralizes backslash path separators', () => {
    const dest = stageUploadDestPath(tmpDir, '..\\..\\Windows\\owned.fit');
    expect(dest).not.toBeNull();
    expect(isContained(dest!)).toBe(true);
    expect(path.basename(dest!)).toBe('owned.fit');
  });

  it('treats a leading-slash absolute path as relative to the staging dir', () => {
    const dest = stageUploadDestPath(tmpDir, '/etc/passwd');
    expect(dest).not.toBeNull();
    expect(isContained(dest!)).toBe(true);
    expect(dest!).not.toBe('/etc/passwd');
  });

  it('rejects a path containing a NUL byte', () => {
    expect(stageUploadDestPath(tmpDir, 'evil\x00.fit')).toBeNull();
  });

  it('rejects a path containing other control characters', () => {
    expect(stageUploadDestPath(tmpDir, 'evil\n.fit')).toBeNull();
  });

  it('rejects a path that reduces to nothing (only "." / ".." segments)', () => {
    expect(stageUploadDestPath(tmpDir, '..')).toBeNull();
    expect(stageUploadDestPath(tmpDir, './.././')).toBeNull();
    expect(stageUploadDestPath(tmpDir, '')).toBeNull();
  });
});
