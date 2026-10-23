import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import sharp from '../../server/lib/sharp-optional';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getById } from '../../server/lib/dsoCatalog';
import { getAnnotations } from '../../server/lib/annotate/annotateService';
import { approximateWcs } from '../../server/lib/annotate/wcs';

const REL = 'IC1805_mosaic/annotate-test/Stacked_mosaic_IC1805.jpg';

describe('getAnnotations', () => {
  afterEach(() => {
    db.prepare('DELETE FROM libraryFiles WHERE relPath = ?').run(REL);
    db.prepare('DELETE FROM fileWcs WHERE relPath = ?').run(REL);
    fs.rmSync(path.join(getLibraryDir(), 'IC1805_mosaic', 'annotate-test'), { recursive: true, force: true });
  });

  it("marks a mosaic's target even though its object id carries the _mosaic suffix", async () => {
    const abs = path.join(getLibraryDir(), REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#000' } }).jpeg().toFile(abs);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, 'stacked', ?)`,
    ).run('IC1805_mosaic', REL, path.basename(REL), path.basename(REL), '2026-10-01T00:00:00Z');
    const ic1805 = getById('IC1805')!;
    const wcs = approximateWcs({ raDeg: ic1805.ra * 15, decDeg: ic1805.dec, width: 1200, height: 800, longSideDeg: 3 });
    db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, 'astap', ?, 'x')`)
      .run(REL, fs.statSync(abs).mtimeMs, JSON.stringify(wcs));

    const result = await getAnnotations(REL);
    expect(result.quality).toBe('solved');
    expect(result.annotations.find(a => a.isTarget)?.id).toBe('IC1805');
  });
});
