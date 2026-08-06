import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-manualobs-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { createManualObservation } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';

describe('createManualObservation', () => {
  it('never writes outside the library directory, even for a traversal-shaped object name', () => {
    // Regression: this path used to path.join(LIBRARY_DIR, folderName) directly,
    // unlike every other import path (which goes through safeObjectDir). An
    // objectName of ".." normalized to a folderName of ".." and wrote the
    // uploaded image into DATA_DIR, next to the database and secrets.
    expect(() => createManualObservation('..', '2026-01-01', Buffer.from('jpg'), 'jpg')).toThrow(/unsafe/i);
    // Nothing should have been written into DATA_DIR as a side effect of the
    // rejected call, and LIBRARY_DIR must not contain a ".." entry either.
    expect(fs.existsSync(path.join(TEST_DATA_DIR, '..', 'nebulis.db'))).toBe(false);
    expect(fs.existsSync(LIBRARY_DIR) && fs.readdirSync(LIBRARY_DIR)).not.toContain('..');
  });

  it('rejects an unsupported image extension even if the caller bypasses the route-level filter', () => {
    expect(() => createManualObservation('M31', '2026-01-01', Buffer.from('x'), 'exe')).toThrow(/unsupported image type/i);
  });

  it('still creates a normal observation for a valid object name', () => {
    const result = createManualObservation('M31', '2026-01-01', Buffer.from('jpg'), 'jpg');
    expect(result.objectId).toBe('M31');
    expect(result.date).toBe('2026-01-01');
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'M31'))).toBe(true);
    const files = fs.readdirSync(path.join(LIBRARY_DIR, 'M31'));
    expect(files.some(f => f.startsWith('M31_') && f.endsWith('.jpg'))).toBe(true);
  });
});
