import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedrescan-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { ensureLibraryDir, reclassifyObject } from '../../server/lib/library/objects';
import {
  commitSource, rescanSource,
} from '../../server/lib/library/librarySources';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true };
const roots: string[] = [];

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
  db.prepare('DELETE FROM notes').run();
  db.prepare('DELETE FROM objectDesignationRedirects').run();
  ensureLibraryDir();
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-rescan-source-'));
  roots.push(root);
  const m31 = path.join(root, 'Galaxies', 'M 31 - Andromeda');
  fs.mkdirSync(m31, { recursive: true });
  fs.writeFileSync(path.join(m31, 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'), 'a'.repeat(100));
  fs.writeFileSync(path.join(m31, 'Stacked_60_M 31_10.0s_IRCUT_20260102-200000.jpg'), 'b'.repeat(100));
  return root;
}


const objectsOf = (id: string) =>
  db.prepare<[string], { objectId: string }>('SELECT DISTINCT objectId FROM libraryFiles WHERE sourceId = ?').all(id).map(r => r.objectId);

describe('reclassify on a linked folder, then rescan', () => {
  it('a new link of the same folder honours an earlier reclassify', () => {
    const root = makeRoot();
    const first = commitSource(root, SETTINGS, { label: 'x' });
    reclassifyObject('M31', 'NGC7000', { remember: false });
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM librarySources').run();
    const again = commitSource(root, SETTINGS, { label: 'y' });
    expect(first.sourceId).not.toBe(again.sourceId);
    expect(objectsOf(again.sourceId)).toEqual(['NGC7000']);
  });

  it.each([true, false])('keeps the reclassified object after a rescan (remember=%s)', remember => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    expect(objectsOf(sourceId)).toEqual(['M31']);

    reclassifyObject('M31', 'NGC7000', { remember });
    expect(objectsOf(sourceId)).toEqual(['NGC7000']);

    rescanSource(sourceId, SETTINGS);
    expect(objectsOf(sourceId)).toEqual(['NGC7000']);
  });
});
