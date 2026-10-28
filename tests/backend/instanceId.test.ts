import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-instance-id-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { getInstanceId, _resetInstanceIdForTests } from '../../server/lib/instanceId';

const ID_FILE = path.join(TEST_DATA_DIR, '.instance-id');
const savedEnv = process.env.INSTANCE_ID;

beforeEach(() => {
  delete process.env.INSTANCE_ID;
  fs.rmSync(ID_FILE, { force: true });
  _resetInstanceIdForTests();
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = savedEnv;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('getInstanceId', () => {
  it('generates an id on first run and persists it', () => {
    const id = getInstanceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readFileSync(ID_FILE, 'utf8')).toBe(id);
  });

  it('returns the same id after a restart (cache cleared, file kept)', () => {
    const first = getInstanceId();
    _resetInstanceIdForTests();
    expect(getInstanceId()).toBe(first);
  });

  it('reads an id already on disk and trims whitespace', () => {
    fs.writeFileSync(ID_FILE, '  fixed-id-123\n');
    expect(getInstanceId()).toBe('fixed-id-123');
  });

  it('regenerates when the file is empty', () => {
    fs.writeFileSync(ID_FILE, '   \n');
    const id = getInstanceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readFileSync(ID_FILE, 'utf8')).toBe(id);
  });

  it('lets INSTANCE_ID win over the file, and writes nothing', () => {
    fs.writeFileSync(ID_FILE, 'from-file');
    process.env.INSTANCE_ID = ' from-env ';
    expect(getInstanceId()).toBe('from-env');
    expect(fs.readFileSync(ID_FILE, 'utf8')).toBe('from-file');
  });

  it('ignores a blank INSTANCE_ID', () => {
    process.env.INSTANCE_ID = '   ';
    fs.writeFileSync(ID_FILE, 'from-file');
    expect(getInstanceId()).toBe('from-file');
  });

  it('caches within a process even if the file changes', () => {
    const first = getInstanceId();
    fs.writeFileSync(ID_FILE, 'changed-on-disk');
    expect(getInstanceId()).toBe(first);
  });

  it('still returns a stable in-memory id when the file cannot be written', () => {
    // A directory where the file should be makes both the read and the write fail.
    fs.mkdirSync(ID_FILE);
    try {
      const id = getInstanceId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(getInstanceId()).toBe(id);
    } finally {
      fs.rmSync(ID_FILE, { recursive: true, force: true });
    }
  });
});
