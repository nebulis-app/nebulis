import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-redirect-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  getDesignationRedirect,
  setDesignationRedirect,
  deleteDesignationRedirect,
} from '../../server/lib/library/designationRedirects';
import { reclassifyObject } from '../../server/lib/library/objects';
import '../../server/lib/library/objects'; // runs the table-creation + migration blocks
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

void TEST_DATA_DIR;

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    `INSERT INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, layout)
     VALUES (?, ?, ?, ?, 0, 'flat')`,
  ).run(objectId, folderName, 3, '2026-01-01T00:00:00Z');
}

beforeEach(() => {
  const existing = new Set(
    db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name),
  );
  for (const t of [
    'libraryFiles', 'librarySessions', 'libraryDeletedSessions', 'notes',
    'favorites', 'wishlist', 'sessionProcessedImages', 'captureInfo',
    'plannedSessions', 'processingRuns', 'libraryObjects', 'objectDesignationRedirects',
  ]) {
    if (existing.has(t)) db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
});

describe('designationRedirects get/set round trip', () => {
  it('normalizes the key so spacing/case do not matter', () => {
    setDesignationRedirect('ngc 6992', 'IC5070');
    expect(getDesignationRedirect('NGC6992')).toBe('IC5070');
    expect(getDesignationRedirect('NGC 6992')).toBe('IC5070');
  });

  it('returns null when nothing is set', () => {
    expect(getDesignationRedirect('NGC1499')).toBeNull();
  });

  it('a later set overwrites the earlier target', () => {
    setDesignationRedirect('NGC6992', 'IC5070');
    setDesignationRedirect('NGC6992', 'SH2-102');
    expect(getDesignationRedirect('NGC6992')).toBe('SH2-102');
  });

  it('delete removes the redirect', () => {
    setDesignationRedirect('NGC6992', 'IC5070');
    deleteDesignationRedirect('NGC6992');
    expect(getDesignationRedirect('NGC6992')).toBeNull();
  });
});

describe('reclassifyObject', () => {
  it('renames when the target has no library object yet, and records a redirect', () => {
    seedObject('NGC6992', 'NGC6992');

    const result = reclassifyObject('NGC6992', 'IC5070', { remember: true });

    expect(result).toEqual({ mode: 'rename', objectId: 'IC5070' });
    expect(db.prepare('SELECT objectId FROM libraryObjects WHERE objectId = ?').get('NGC6992')).toBeUndefined();
    expect(db.prepare('SELECT objectId FROM libraryObjects WHERE objectId = ?').get('IC5070')).toEqual({ objectId: 'IC5070' });
    expect(getDesignationRedirect('NGC6992')).toBe('IC5070');
  });

  it('merges when the target already has a library object, folding fileCount', () => {
    seedObject('NGC6992', 'NGC6992');
    seedObject('IC5070', 'IC5070');

    const result = reclassifyObject('NGC6992', 'IC5070', { remember: false });

    expect(result).toEqual({ mode: 'merge', objectId: 'IC5070' });
    expect(db.prepare('SELECT objectId FROM libraryObjects WHERE objectId = ?').get('NGC6992')).toBeUndefined();
    const merged = db.prepare('SELECT fileCount FROM libraryObjects WHERE objectId = ?').get('IC5070') as { fileCount: number };
    expect(merged.fileCount).toBe(6); // 3 + 3
    // remember: false must not create a redirect.
    expect(getDesignationRedirect('NGC6992')).toBeNull();
  });

  it('throws when the object does not exist', () => {
    expect(() => reclassifyObject('NOPE', 'IC5070', { remember: false })).toThrow();
  });

  it('throws when the target resolves to the same object', () => {
    seedObject('NGC6992', 'NGC6992');
    expect(() => reclassifyObject('NGC6992', 'NGC6992', { remember: false })).toThrow();
  });
});
