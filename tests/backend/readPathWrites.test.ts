import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-readwrites-'));
});

import fs from 'fs';
import path from 'path';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { getLocalSessions } from '../../server/lib/library/observations';
import { setAutoGalleryImage, clearAutoGalleryImage, setGalleryImageUserChosen } from '../../server/lib/library/gallery';
import { acquireLibraryLock } from '../../server/lib/libraryBusy';

// Reads used to rewrite rows (session telescope, cover image) with unconditional UPDATEs, so a read that raced an import
// or a user's choice could overwrite it.
const cover = (id: string) =>
  db.prepare<[string], { galleryImage: string | null; galleryImageUserSet: number }>(
    'SELECT galleryImage, galleryImageUserSet FROM libraryObjects WHERE objectId = ?').get(id)!;

beforeEach(() => {
  for (const t of ['libraryFiles', 'librarySessions', 'libraryObjects']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO libraryObjects (objectId, folderName, lastImport) VALUES ('M31', 'M31', 'x')").run();
});

describe('cover image writes made by reads', () => {
  it('fills an empty auto cover', () => {
    setAutoGalleryImage('M31', 'M31/a.jpg');
    expect(cover('M31')).toEqual({ galleryImage: 'M31/a.jpg', galleryImageUserSet: 0 });
  });

  it('never replaces a cover that is already set', () => {
    setAutoGalleryImage('M31', 'M31/a.jpg');
    setAutoGalleryImage('M31', 'M31/b.jpg');
    expect(cover('M31').galleryImage).toBe('M31/a.jpg');
  });

  it('never replaces or clears a cover the user chose', () => {
    setGalleryImageUserChosen('M31', 'M31/mine.jpg');
    setAutoGalleryImage('M31', 'M31/auto.jpg');
    clearAutoGalleryImage('M31');
    expect(cover('M31')).toEqual({ galleryImage: 'M31/mine.jpg', galleryImageUserSet: 1 });
  });

  it('clears an auto cover', () => {
    setAutoGalleryImage('M31', 'M31/a.jpg');
    clearAutoGalleryImage('M31');
    expect(cover('M31').galleryImage).toBeNull();
  });
});

describe('session self-heal on read', () => {
  function seed() {
    fs.mkdirSync(path.join(LIBRARY_DIR, 'M31'), { recursive: true }); // the self-heal only runs for an object whose folder exists
    db.prepare("INSERT INTO librarySessions (objectId, date, telescopeId) VALUES ('M31', '2026-01-10', NULL)").run();
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, telescopeId, bytes, importedAt)
       VALUES ('M31', 'M31/a.fit', 'a.fit', 'a.fit', 'sub', '2026-01-10', 'scope-1', 1, 'x')`,
    ).run();
  }
  const rowScope = () => db.prepare<[], { telescopeId: string | null }>("SELECT telescopeId FROM librarySessions WHERE objectId = 'M31'").get()!.telescopeId;

  it('does not rewrite session rows while a library job holds the library, and heals on the next read', () => {
    seed();
    const release = acquireLibraryLock('archive');
    expect(release).not.toBeNull();
    try {
      getLocalSessions('M31');
      expect(rowScope()).toBeNull();
    } finally {
      release!();
    }
    getLocalSessions('M31');
    expect(rowScope()).toBe('scope-1');
  });
});
