import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors processedImageObjectUpload.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-project-archives-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import {
  isProjectArchiveName,
  projectArchiveMimeType,
  addProjectArchive,
  getProjectArchivesForObject,
  getProjectArchiveRecord,
  getProjectArchivePath,
  deleteProjectArchive,
} from '../../server/lib/library/projectArchives';
import { stmts, getLocalObjects } from '../../server/lib/library/objects';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function seedObject(objectId: string, folderName: string): void {
  stmts.upsertObject.run(
    objectId, folderName, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  fs.mkdirSync(path.join(LIBRARY_DIR, folderName), { recursive: true });
}

/** Stage a temp source file the way the multer upload handler hands one in. */
function stagedFile(name: string, contents = 'zip bytes'): string {
  const p = path.join(os.tmpdir(), `project-archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  fs.writeFileSync(p, contents);
  return p;
}

describe('isProjectArchiveName / projectArchiveMimeType', () => {
  it('accepts .zip plus the PixInsight project formats, case-insensitively', () => {
    expect(isProjectArchiveName('project.zip')).toBe(true);
    expect(isProjectArchiveName('Project.ZIP')).toBe(true);
    expect(isProjectArchiveName('icons.xpsm')).toBe(true);
    expect(isProjectArchiveName('M31.PXIPROJECT')).toBe(true);
    expect(isProjectArchiveName('project.rar')).toBe(false);
    expect(isProjectArchiveName('project.xisf')).toBe(false);
    expect(isProjectArchiveName('project')).toBe(false);
  });

  it('reports application/zip for zips and octet-stream for PixInsight project files', () => {
    expect(projectArchiveMimeType()).toBe('application/zip');
    expect(projectArchiveMimeType('a.zip')).toBe('application/zip');
    expect(projectArchiveMimeType('icons.xpsm')).toBe('application/octet-stream');
  });
});

describe('addProjectArchive', () => {
  it('stores the archive under <object>/project-archives/ and records it in the DB', () => {
    seedObject('NGC7000', 'NGC7000');

    const record = addProjectArchive(
      'NGC7000',
      stagedFile('NGC7000_project.zip'),
      'NGC7000_project.zip',
      'application/zip',
      'HOO final project',
      'Combines nights 1-3',
      'PixInsight',
    );

    expect(record.objectId).toBe('NGC7000');
    expect(record.title).toBe('HOO final project');
    expect(record.notes).toBe('Combines nights 1-3');
    expect(record.software).toBe('PixInsight');
    expect(record.path).toBe(`NGC7000/project-archives/${record.filename}`);
    expect(fs.existsSync(path.join(LIBRARY_DIR, 'NGC7000', 'project-archives', record.filename))).toBe(true);

    const list = getProjectArchivesForObject('NGC7000');
    expect(list.map(r => r.id)).toContain(record.id);

    const fetched = getProjectArchiveRecord(record.id);
    expect(fetched?.filename).toBe(record.filename);
  });

  it('keeps the original filename, only disambiguating on collision', () => {
    seedObject('M42', 'M42');

    const first = addProjectArchive(
      'M42', stagedFile('project.zip', 'a'), 'project.zip', 'application/zip', '', '', '',
    );
    const second = addProjectArchive(
      'M42', stagedFile('project.zip', 'b'), 'project.zip', 'application/zip', '', '', '',
    );

    expect(first.filename).toBe('project.zip');
    expect(second.filename).toBe('project (2).zip');
    expect(second.originalName).toBe('project.zip');
  });

  it('lists newest first and only ever returns this object\'s own archives', () => {
    seedObject('M31', 'M31');
    seedObject('M33', 'M33');

    addProjectArchive('M31', stagedFile('a.zip'), 'a.zip', 'application/zip', 'first', '', '');
    addProjectArchive('M33', stagedFile('b.zip'), 'b.zip', 'application/zip', 'other object', '', '');
    const second = addProjectArchive('M31', stagedFile('c.zip'), 'c.zip', 'application/zip', 'second', '', '');

    const list = getProjectArchivesForObject('M31');
    expect(list.map(r => r.title)).not.toContain('other object');
    expect(list[0].id).toBe(second.id);
  });
});

describe('getProjectArchivePath', () => {
  it('resolves the on-disk path and original name without reading the file', () => {
    seedObject('IC1396', 'IC1396');
    const record = addProjectArchive(
      'IC1396', stagedFile('elephant.zip', 'payload'), 'elephant_trunk.zip', 'application/zip', '', '', '',
    );

    const resolved = getProjectArchivePath(record.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('elephant_trunk.zip');
    expect(fs.readFileSync(resolved!.filePath, 'utf8')).toBe('payload');
  });

  it('returns null for an unknown id', () => {
    expect(getProjectArchivePath('proj_does_not_exist')).toBeNull();
  });
});

describe('deleteProjectArchive', () => {
  it('removes both the DB row and the file on disk', () => {
    seedObject('M16', 'M16');
    const record = addProjectArchive(
      'M16', stagedFile('to-delete.zip'), 'to-delete.zip', 'application/zip', '', '', '',
    );
    const onDisk = path.join(LIBRARY_DIR, 'M16', 'project-archives', record.filename);
    expect(fs.existsSync(onDisk)).toBe(true);

    deleteProjectArchive(record.id);

    expect(fs.existsSync(onDisk)).toBe(false);
    expect(getProjectArchiveRecord(record.id)).toBeNull();
    expect(getProjectArchivesForObject('M16').map(r => r.id)).not.toContain(record.id);
  });

  it('is a safe no-op for an unknown id', () => {
    expect(() => deleteProjectArchive('proj_does_not_exist')).not.toThrow();
  });
});

describe('getLocalObjects — projectArchiveCount (library grid card)', () => {
  it('is 0 for an object with no archives, without needing one to exist first', () => {
    seedObject('M51', 'M51');
    const found = getLocalObjects().find(o => o.id === 'M51');
    expect(found?.projectArchiveCount).toBe(0);
  });

  it('counts every archive for its own object, batched correctly across objects', () => {
    seedObject('M81', 'M81');
    seedObject('M82', 'M82');
    addProjectArchive('M81', stagedFile('a.zip'), 'a.zip', 'application/zip', '', '', '');
    addProjectArchive('M81', stagedFile('b.zip'), 'b.zip', 'application/zip', '', '', '');
    addProjectArchive('M82', stagedFile('c.zip'), 'c.zip', 'application/zip', '', '', '');

    const all = getLocalObjects();
    expect(all.find(o => o.id === 'M81')?.projectArchiveCount).toBe(2);
    expect(all.find(o => o.id === 'M82')?.projectArchiveCount).toBe(1);
  });

  it('drops back to 0 once every archive for that object is deleted', () => {
    seedObject('NGC6960', 'NGC6960');
    const record = addProjectArchive(
      'NGC6960', stagedFile('only.zip'), 'only.zip', 'application/zip', '', '', '',
    );
    expect(getLocalObjects().find(o => o.id === 'NGC6960')?.projectArchiveCount).toBe(1);

    deleteProjectArchive(record.id);

    expect(getLocalObjects().find(o => o.id === 'NGC6960')?.projectArchiveCount).toBe(0);
  });
});
