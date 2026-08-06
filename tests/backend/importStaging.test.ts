import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors housekeeping.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-staging-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  IMPORT_TMP_BASE,
  isValidTmpId,
  isStagedPath,
  getImportTmpUsage,
  purgeImportTmp,
  purgeImportTmpSession,
  checkFreeSpace,
  onSameVolume,
} from '../../server/lib/library/importStaging';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function stage(name: string, files: Record<string, string>, ageMs = 0): string {
  const dir = path.join(IMPORT_TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (ageMs > 0) {
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, mtime, mtime);
  }
  return dir;
}

beforeEach(() => {
  fs.rmSync(IMPORT_TMP_BASE, { recursive: true, force: true });
});

describe('isStagedPath', () => {
  it('accepts the staging base and paths inside it', () => {
    expect(isStagedPath(IMPORT_TMP_BASE)).toBe(true);
    expect(isStagedPath(path.join(IMPORT_TMP_BASE, UUID))).toBe(true);
    expect(isStagedPath(path.join(IMPORT_TMP_BASE, UUID, 'M42', 'light.fit'))).toBe(true);
  });

  it('rejects paths outside the staging area', () => {
    expect(isStagedPath(path.join(TEST_DATA_DIR, 'library'))).toBe(false);
    expect(isStagedPath(path.join(TEST_DATA_DIR, 'library', 'M42'))).toBe(false);
  });

  it('rejects a sibling directory whose name merely starts with the base', () => {
    // `import-tmp-old` textually starts with the base but is a different
    // directory. A literal startsWith without the separator would delete it.
    expect(isStagedPath(`${IMPORT_TMP_BASE}-old`)).toBe(false);
  });

  it('resolves traversal before comparing, so ../ cannot escape the check', () => {
    // Textually starts with the base, actually points at the user's library.
    const sneaky = path.join(IMPORT_TMP_BASE, '..', 'library', 'M42');
    expect(isStagedPath(sneaky)).toBe(false);
  });
});

describe('isValidTmpId', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(isValidTmpId(UUID)).toBe(true);
    expect(isValidTmpId(UUID.toUpperCase())).toBe(true);
    expect(isValidTmpId('..')).toBe(false);
    expect(isValidTmpId('../../library')).toBe(false);
    expect(isValidTmpId('')).toBe(false);
    expect(isValidTmpId(`${UUID}/../..`)).toBe(false);
  });
});

describe('getImportTmpUsage', () => {
  it('reports zero when the staging area does not exist', () => {
    expect(getImportTmpUsage()).toMatchObject({ bytes: 0, files: 0, sessions: 0, oldestAt: null });
  });

  it('totals bytes and files across nested session directories', () => {
    stage('a', { 'M42/light.fit': 'x'.repeat(100), 'M42/sub/other.fit': 'x'.repeat(20) });
    stage('b', { 'stacked.jpg': 'x'.repeat(30) });

    const usage = getImportTmpUsage();

    expect(usage.sessions).toBe(2);
    expect(usage.files).toBe(3);
    expect(usage.bytes).toBe(150);
    expect(usage.oldestAt).not.toBeNull();
  });
});

describe('purgeImportTmp', () => {
  it('deletes sessions past the age floor and leaves recent ones alone', () => {
    stage('old', { 'a.fit': 'x'.repeat(10) }, 60 * 60 * 1000);
    stage('recent', { 'b.fit': 'x'.repeat(10) });

    const result = purgeImportTmp(10 * 60 * 1000);

    expect(result).toMatchObject({ deleted: 1, errors: 0, bytes: 10, skippedActive: 1 });
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'old'))).toBe(false);
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'recent'))).toBe(true);
  });

  it('with a zero age floor, clears everything', () => {
    stage('one', { 'a.fit': 'x' });
    stage('two', { 'b.fit': 'x' });

    const result = purgeImportTmp(0);

    expect(result.deleted).toBe(2);
    expect(result.skippedActive).toBe(0);
    expect(getImportTmpUsage().sessions).toBe(0);
  });
});

describe('purgeImportTmpSession', () => {
  it('deletes one session by id and reports its size', () => {
    stage(UUID, { 'a.fit': 'x'.repeat(64) });
    stage('other', { 'b.fit': 'x' });

    expect(purgeImportTmpSession(UUID)).toEqual({ deleted: true, bytes: 64 });
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, UUID))).toBe(false);
    expect(fs.existsSync(path.join(IMPORT_TMP_BASE, 'other'))).toBe(true);
  });

  it('refuses a non-UUID id rather than deleting a path built from it', () => {
    const victim = stage('victim', { 'a.fit': 'x' });

    expect(purgeImportTmpSession('../victim')).toEqual({ deleted: false, bytes: 0 });
    expect(purgeImportTmpSession('victim')).toEqual({ deleted: false, bytes: 0 });
    expect(fs.existsSync(victim)).toBe(true);
  });

  it('reports not-deleted for an id that is not staged', () => {
    expect(purgeImportTmpSession(UUID)).toEqual({ deleted: false, bytes: 0 });
  });
});

describe('checkFreeSpace', () => {
  it('passes when the request is small relative to the volume', () => {
    const check = checkFreeSpace(TEST_DATA_DIR, 1024, 'to test');
    expect(check.ok).toBe(true);
    expect(check.message).toBeNull();
  });

  it('fails with a readable message when the request exceeds free space', () => {
    const check = checkFreeSpace(TEST_DATA_DIR, Number.MAX_SAFE_INTEGER, 'to import these files');
    expect(check.ok).toBe(false);
    expect(check.message).toContain('Not enough free space to import these files');
    expect(check.message).toContain(TEST_DATA_DIR);
  });

  it('requires headroom beyond the requested bytes', () => {
    // The margin is what keeps an import from filling the volume to the last
    // byte, which breaks the database and logs rather than just the import.
    const check = checkFreeSpace(TEST_DATA_DIR, 0, 'to test');
    expect(check.requiredBytes).toBeGreaterThan(0);
  });

  it('allows the operation when the volume cannot be measured', () => {
    // Refusing an import because statfs failed on an unusual filesystem would
    // be worse than letting it run and surfacing a real ENOSPC.
    const check = checkFreeSpace(path.join(TEST_DATA_DIR, 'does-not-exist'), 1024, 'to test');
    expect(check.ok).toBe(true);
  });
});

describe('onSameVolume', () => {
  it('is true for two paths on the same filesystem', () => {
    expect(onSameVolume(TEST_DATA_DIR, TEST_DATA_DIR)).toBe(true);
  });

  it('is false when a path cannot be stat\'d, the conservative direction', () => {
    expect(onSameVolume(TEST_DATA_DIR, path.join(TEST_DATA_DIR, 'nope'))).toBe(false);
  });
});
