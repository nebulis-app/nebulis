import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// IMPORTANT: paths.ts captures DATA_DIR / LIBRARY_DIR at module load.
// Redirect both to a per-test-file temp dir before any server module imports
// resolve. vi.hoisted runs before all imports, including transitive ones.
//
// We deliberately put TEST_DATA_DIR *outside* os.tmpdir() so that it cannot be
// confused with the multer-upload tmp area — the importer's defense-in-depth
// check refuses any tempPath outside os.tmpdir(). It nests under <repo>/.test-tmp
// (gitignored, wiped by tests/globalSetup.ts), which is still outside
// os.tmpdir(), so that constraint holds while keeping the repo root clean.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-import-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { importUploadedFiles } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';

function writeUpload(content: string): string {
  // Multer writes uploads under os.tmpdir(); the importer enforces that
  // tempPath resolves inside os.tmpdir(). Use a real tmp file so the
  // defense-in-depth check passes.
  const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-upload-'));
  const file = path.join(fd, 'upload.bin');
  fs.writeFileSync(file, content);
  return file;
}

function listLibraryRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listLibraryRecursive(full));
    else out.push(full);
  }
  return out;
}

describe('importUploadedFiles — originalName traversal guard', () => {
  beforeEach(() => {
    // Wipe the library between tests so file counts are predictable.
    if (fs.existsSync(LIBRARY_DIR)) {
      fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('imports a benign file into the object folder', () => {
    // A jpg imports by default (importJpg !== false). Object name comes from
    // relativePath so this test is independent of parseFilename's classifier.
    const tempPath = writeUpload('benign');
    const result = importUploadedFiles([
      {
        tempPath,
        originalName: 'M31_stacked_20241015.jpg',
        relativePath: 'M31/M31_stacked_20241015.jpg',
      },
    ]);
    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);

    const written = listLibraryRecursive(LIBRARY_DIR);
    expect(written).toHaveLength(1);
    // File must live inside LIBRARY_DIR.
    expect(written[0].startsWith(LIBRARY_DIR + path.sep)).toBe(true);
    // Filename must be exactly the original basename — no path components.
    expect(path.basename(written[0])).toBe(
      'M31_stacked_20241015.jpg',
    );
  });

  it('rejects originalName containing forward-slash path separators', () => {
    const tempPath = writeUpload('malicious');
    const result = importUploadedFiles([
      {
        tempPath,
        originalName: '../../../tmp/owned.fit',
        // Give the importer a plausible relativePath so it gets past the
        // object-name resolution and reaches the per-file basename guard.
        relativePath: 'M31/owned.fit',
      },
    ]);

    // The basename guard must skip the single upload entirely (skipped=1,
    // not "1 or more" — exactly one upload was submitted, so any other count
    // would mean either silent duplication or partial work).
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);

    // Nothing must have been written outside LIBRARY_DIR.
    const writtenInLib = listLibraryRecursive(LIBRARY_DIR);
    for (const p of writtenInLib) {
      expect(p.startsWith(LIBRARY_DIR + path.sep)).toBe(true);
    }
    // No file named owned.fit should have ended up under /tmp.
    expect(fs.existsSync('/tmp/owned.fit')).toBe(false);
  });

  it('rejects originalName containing backslash path separators', () => {
    const tempPath = writeUpload('malicious');
    const result = importUploadedFiles([
      {
        tempPath,
        originalName: '..\\..\\Windows\\owned.fit',
        relativePath: 'M31/owned.fit',
      },
    ]);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    const written = listLibraryRecursive(LIBRARY_DIR);
    for (const p of written) {
      expect(p.startsWith(LIBRARY_DIR + path.sep)).toBe(true);
    }
  });

  it('rejects originalName containing a NUL byte', () => {
    const tempPath = writeUpload('malicious');
    const result = importUploadedFiles([
      {
        tempPath,
        originalName: 'evil\x00.fit',
        relativePath: 'M31/evil.fit',
      },
    ]);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('rejects tempPath that lives outside os.tmpdir()', () => {
    // Create the upload file *outside* tmp so the defense-in-depth check
    // refuses to touch it.
    const outsideDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'not-tmp-'));
    const tempPath = path.join(outsideDir, 'upload.bin');
    fs.writeFileSync(tempPath, 'should not be touched');

    const result = importUploadedFiles([
      {
        tempPath,
        originalName: 'M31_stacked_20241015.jpg',
      },
    ]);

    expect(result.imported).toBe(0);
    // One specific error per rejected upload, with a message identifying the
    // upload-location issue. `errors.length > 0` previously passed for ANY
    // error including the wrong one (e.g. a generic IO failure).
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/temporary upload location/);
    // Crucially: the file outside tmp must still exist. The cleanup branch
    // must not unlink arbitrary paths just because the upload was rejected.
    expect(fs.existsSync(tempPath)).toBe(true);
  });
});
