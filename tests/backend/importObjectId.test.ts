import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-importid-'));
});

import '../../server/lib/library/objects'; // creates the tables
import db from '../../server/lib/db';
import { resolveImportObjectId } from '../../server/lib/library/importObjectId';
import { setDesignationRedirect, deleteDesignationRedirect } from '../../server/lib/library/designationRedirects';

// One resolver for every import path: the telescope sync used to know only designations, the folder wizard also read
// common names, and the sync ignored "Remember this" redirects.
describe('resolveImportObjectId', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM objectDesignationRedirects').run();
    db.prepare('DELETE FROM libraryObjects').run();
  });

  it('keeps resolving plain designations and aliases exactly as before', () => {
    expect(resolveImportObjectId('M 42')).toBe('M42');
    expect(resolveImportObjectId('M42')).toBe('M42');
    expect(resolveImportObjectId('NGC 224')).toBe('M31');
    expect(resolveImportObjectId('C63')).toBe('NGC7293');
  });

  it('resolves a common name the way the folder wizard does', () => {
    expect(resolveImportObjectId('California Nebula')).toBe('NGC1499');
  });

  it('resolves a designation embedded in a longer folder name', () => {
    expect(resolveImportObjectId('Seestar_M42')).toBe('M42');
  });

  it('refuses to guess between two designations', () => {
    expect(resolveImportObjectId('M81_M82')).toBe('M81_M82');
  });

  it('leaves an unrecognised name as the folder name', () => {
    expect(resolveImportObjectId('My Backyard Test')).toBe('MyBackyardTest');
  });

  it('keeps an object that already exists under the unrecognised id', () => {
    db.prepare("INSERT INTO libraryObjects (objectId, folderName, lastImport) VALUES ('CaliforniaNebula', 'California Nebula', '2026-01-01')").run();
    expect(resolveImportObjectId('California Nebula')).toBe('CaliforniaNebula');
  });

  it('applies a remembered reclassify redirect, which wins over the catalog', () => {
    setDesignationRedirect('M81', 'M82');
    expect(resolveImportObjectId('M81')).toBe('M82');
    expect(resolveImportObjectId('M 81')).toBe('M82');
    deleteDesignationRedirect('M81');
    expect(resolveImportObjectId('M81')).toBe('M81');
  });
});
