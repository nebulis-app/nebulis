import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// paths.ts / db.ts capture DATA_DIR at module load. Redirect to a temp dir
// before any server module imports resolve (vi.hoisted runs first).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  // Scratch dirs live under <repo>/.test-tmp (gitignored, wiped before each run
  // by tests/globalSetup.ts) so a crashed run never litters the repo root.
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-libpath-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  getLibraryDir,
  getDefaultLibraryDir,
  isDefaultLocation,
  isLibraryAvailable,
  ensureLibraryDir,
  setLibraryPath,
  getLibraryId,
  writeMarker,
  readMarker,
  LibraryUnavailableError,
  MARKER_FILENAME,
} from '../../server/lib/libraryPath';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  setLibraryPath(''); // reset to default between tests
});

describe('libraryPath resolution', () => {
  it('defaults to {DATA_DIR}/library', () => {
    expect(isDefaultLocation()).toBe(true);
    expect(getLibraryDir()).toBe(path.join(TEST_DATA_DIR, 'library'));
    expect(getDefaultLibraryDir()).toBe(path.join(TEST_DATA_DIR, 'library'));
  });

  it('returns the configured path once set', () => {
    const relocated = path.join(TEST_DATA_DIR, 'relocated');
    setLibraryPath(relocated);
    expect(isDefaultLocation()).toBe(false);
    expect(getLibraryDir()).toBe(relocated);
  });

  it('treats an empty configured path as default', () => {
    setLibraryPath('   ');
    expect(isDefaultLocation()).toBe(true);
    expect(getLibraryDir()).toBe(getDefaultLibraryDir());
  });
});

describe('libraryId', () => {
  it('generates a stable id and persists it', () => {
    const id = getLibraryId();
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(getLibraryId()).toBe(id); // stable across calls
  });
});

describe('marker file', () => {
  it('writes and reads back a marker', () => {
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'marker-'));
    writeMarker(dir, 'abc-123');
    expect(fs.existsSync(path.join(dir, MARKER_FILENAME))).toBe(true);
    expect(readMarker(dir)?.libraryId).toBe('abc-123');
  });

  it('returns null for a directory with no marker', () => {
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'nomarker-'));
    expect(readMarker(dir)).toBeNull();
  });
});

describe('isLibraryAvailable', () => {
  it('is always available at the default location', () => {
    setLibraryPath('');
    expect(isLibraryAvailable()).toBe(true);
  });

  it('is unavailable when the relocated dir does not exist', () => {
    setLibraryPath(path.join(TEST_DATA_DIR, 'does-not-exist'));
    expect(isLibraryAvailable()).toBe(false);
  });

  it('is unavailable when the relocated dir has no marker', () => {
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'unmarked-'));
    setLibraryPath(dir);
    expect(isLibraryAvailable()).toBe(false);
  });

  it('is unavailable when the marker is for a different library', () => {
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'foreign-'));
    writeMarker(dir, 'some-other-library-id');
    setLibraryPath(dir);
    expect(isLibraryAvailable()).toBe(false);
  });

  it('is available when the relocated dir has our matching marker', () => {
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'ours-'));
    writeMarker(dir, getLibraryId());
    setLibraryPath(dir);
    expect(isLibraryAvailable()).toBe(true);
  });
});

describe('ensureLibraryDir', () => {
  it('creates the default directory on demand', () => {
    setLibraryPath('');
    const dir = ensureLibraryDir();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('throws LibraryUnavailableError when the relocated drive is missing', () => {
    setLibraryPath(path.join(TEST_DATA_DIR, 'missing-drive', 'lib'));
    expect(() => ensureLibraryDir()).toThrow(LibraryUnavailableError);
  });
});
