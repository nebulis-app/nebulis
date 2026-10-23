import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import sharp from '../../server/lib/sharp-optional';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getById } from '../../server/lib/dsoCatalog';
import { getAnnotations } from '../../server/lib/annotate/annotateService';
import { markGeometryEdited } from '../../server/lib/annotate/geometryEdits';
import { approximateWcs } from '../../server/lib/annotate/wcs';

const DIR = 'M31/geometry-edit-test';
const REL = `${DIR}/Stacked_60_M 31_10.0s_IRCUT_20260530-211100.jpg`;

describe('annotations of a picture whose frame was edited', () => {
  let abs: string;

  beforeEach(async () => {
    abs = path.join(getLibraryDir(), REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#000' } }).jpeg().toFile(abs);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, 'stacked', ?)`,
    ).run('M31', REL, path.basename(REL), path.basename(REL), '2026-10-01T00:00:00Z');
  });

  afterEach(() => {
    for (const table of ['libraryFiles', 'fileWcs', 'fileGeometryEdits']) {
      db.prepare(`DELETE FROM ${table} WHERE relPath = ?`).run(REL);
    }
    fs.rmSync(path.join(getLibraryDir(), DIR), { recursive: true, force: true });
  });

  it('refuses the estimate once the frame was cropped or rotated', async () => {
    markGeometryEdited(REL);
    const result = await getAnnotations(REL);
    expect(result.quality).toBe('unavailable');
    expect(result.reason).toBe('edited');
    expect(result.annotations).toEqual([]);
  });

  it('still uses a plate solution, which is read from the picture itself', async () => {
    markGeometryEdited(REL);
    const m31 = getById('M31')!;
    const wcs = approximateWcs({ raDeg: m31.ra * 15, decDeg: m31.dec, width: 1200, height: 800, longSideDeg: 3 });
    db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, 'astap', ?, 'x')`)
      .run(REL, fs.statSync(abs).mtimeMs, JSON.stringify(wcs));
    expect((await getAnnotations(REL)).quality).toBe('solved');
  });

  it('forgets the mark when the file changes again, such as a restored original', async () => {
    markGeometryEdited(REL);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(abs, later, later);
    expect((await getAnnotations(REL)).reason).not.toBe('edited');
  });

  it('leaves an unedited picture alone', async () => {
    expect((await getAnnotations(REL)).reason).not.toBe('edited');
  });
});
