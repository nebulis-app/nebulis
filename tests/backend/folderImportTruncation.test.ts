import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-truncation-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// Hitting the real 50,000-file-per-object cap in folderScan.ts would mean
// creating 50k+ files on disk just to exercise this path, so this stubs
// walkObjectFiles's `truncated` flag directly. collectObjectSources (the
// other export from this module) keeps its real behavior via importOriginal.
vi.mock('../../server/lib/library/folderScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/library/folderScan')>();
  return {
    ...actual,
    walkObjectFiles: (...args: Parameters<typeof actual.walkObjectFiles>) => {
      const result = actual.walkObjectFiles(...args);
      if (args[0].folderName === 'M42') return { ...result, truncated: true };
      return result;
    },
  };
});

import { commitFolderImport, getImportStatus } from '../../server/lib/library/import';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('commitFolderImport — per-object truncation is surfaced, not silently dropped', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('reports which object(s) hit the per-object file cap instead of reporting plain success', async () => {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'truncation-src-'));
    fs.mkdirSync(path.join(root, 'M42'));
    fs.writeFileSync(path.join(root, 'M42', 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg'), 'jpg');

    await commitFolderImport({
      rootPath: root,
      objects: [
        {
          folderName: 'M42',
          targetObjectId: 'M42',
          targetFolderName: 'M42',
          sessionMap: { '2024-01-15': '2024-01-15' },
        },
      ],
    });

    const status = getImportStatus();
    expect(status.error).toMatch(/per-object file limit/i);
    expect(status.error).toContain('M42');
  });
});
