import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import sharp from '../../server/lib/sharp-optional';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getById } from '../../server/lib/dsoCatalog';
import { getAnnotations } from '../../server/lib/annotate/annotateService';
import { approximateWcs, type EditRotation, type GeometryEdit } from '../../server/lib/annotate/wcs';
import { EDITOR_PREVIEW_MAX_PX, renderEditedPicture, renderEditorPreview } from '../../server/lib/library/imageEdit';
import { imageEditRequestSchema, type ImageEditRequest } from '../../server/lib/library/imageEditSchema';
import { ImageEditError, runImageEdit } from '../../server/lib/library/imageEditService';
import { originalBackupFile } from '../../server/lib/library/replaceFile';
import { deleteProcessedImage, getProcessedImageRecord } from '../../server/lib/library/processed';
import { applyPixelAdjustments } from '../../src/lib/imageAdjust';
import { editGrid, findInGrid, makeGrid } from './gridEdit';

const W = 12, H = 8;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageedit-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A PNG whose every pixel says where it came from: red is the column, green the row. */
async function codedPng(file: string): Promise<void> {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.set([x * 20, y * 30, 0], (y * W + x) * 3);
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
}

async function readCoded(file: string): Promise<number[][]> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return Array.from({ length: info.height }, (_, y) => Array.from({ length: info.width }, (_, x) => {
    const i = (y * info.width + x) * info.channels;
    return (data[i + 1] / 30) * W + data[i] / 20;
  }));
}

const NONE = { brightness: 0, contrast: 0, saturation: 0 };
const CROP = { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.875 };
const EDITS: Array<[string, GeometryEdit]> = [];
for (const rotation of [0, 90, 180, 270] as EditRotation[]) {
  for (const flipH of [false, true]) {
    for (const flipV of [false, true]) EDITS.push([`rotate ${rotation}${flipH ? ' flipH' : ''}${flipV ? ' flipV' : ''}`, { rotation, flipH, flipV }]);
  }
}
EDITS.push(['crop', { crop: CROP }], ['crop and rotate 90', { crop: CROP, rotation: 90 }], ['crop, flip and rotate 270', { crop: CROP, flipH: true, rotation: 270 }]);

describe('renderEditedPicture', () => {
  it.each(EDITS)('%s moves every pixel where the editor’s canvas export put it', async (_name, edit) => {
    const src = path.join(dir, 'src.png'), out = path.join(dir, 'out.png');
    await codedPng(src);
    const size = await renderEditedPicture({ sourcePath: src, edit, adjust: NONE, format: 'png', outPath: out });
    const expected = editGrid(makeGrid(W, H), edit);
    expect(size).toEqual({ width: expected[0].length, height: expected.length });
    expect(await readCoded(out)).toEqual(expected);
    expect(findInGrid(expected, 0)).not.toBeUndefined();
  });

  it('adjusts color with the browser’s arithmetic', async () => {
    const src = path.join(dir, 'src.png'), out = path.join(dir, 'out.png');
    await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 100, g: 150, b: 200 } } }).png().toFile(src);
    await renderEditedPicture({ sourcePath: src, edit: {}, adjust: { brightness: 20, contrast: 30, saturation: -40 }, format: 'png', outPath: out });
    const got = (await sharp(out).raw().toBuffer()).subarray(0, 3);
    const want = new Uint8ClampedArray([100, 150, 200, 255]);
    applyPixelAdjustments(want, 20, 30, -40);
    expect(Array.from(got)).toEqual(Array.from(want.subarray(0, 3)));
  });

  it('honors the EXIF orientation like the browser does before editing', async () => {
    const src = path.join(dir, 'src.jpg'), out = path.join(dir, 'out.png');
    await sharp({ create: { width: 40, height: 20, channels: 3, background: '#888' } }).jpeg().withMetadata({ orientation: 6 }).toFile(src);
    const size = await renderEditedPicture({ sourcePath: src, edit: {}, adjust: NONE, format: 'png', outPath: out });
    expect(size).toEqual({ width: 20, height: 40 });
  });

  it('lays a text overlay of any size over the whole picture', async () => {
    const src = path.join(dir, 'src.png'), out = path.join(dir, 'out.png');
    await sharp({ create: { width: 40, height: 20, channels: 3, background: '#000' } }).png().toFile(src);
    const overlay = await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    await renderEditedPicture({ sourcePath: src, edit: {}, adjust: NONE, overlay, format: 'png', outPath: out });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(Array.from(data.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(data.subarray(data.length - info.channels, data.length - info.channels + 3))).toEqual([255, 0, 0]);
  });

  it('flattens transparency onto black for a JPEG and keeps it for a PNG', async () => {
    const src = path.join(dir, 'src.png');
    await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toFile(src);
    await renderEditedPicture({ sourcePath: src, edit: {}, adjust: NONE, format: 'jpeg', outPath: path.join(dir, 'o.jpg') });
    await renderEditedPicture({ sourcePath: src, edit: {}, adjust: NONE, format: 'png', outPath: path.join(dir, 'o.png') });
    expect((await sharp(path.join(dir, 'o.jpg')).raw().toBuffer())[0]).toBeLessThan(8);
    expect((await sharp(path.join(dir, 'o.png')).metadata()).hasAlpha).toBe(true);
  });

  it('edits a 24 MP stack without the memory a browser canvas needed', { timeout: 120_000 }, async () => {
    const src = path.join(dir, 'big.jpg'), out = path.join(dir, 'out.jpg');
    await sharp({ create: { width: 3672, height: 6528, channels: 3, background: '#345' } }).jpeg().toFile(src);
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    const size = await renderEditedPicture({
      sourcePath: src, edit: { rotation: 90, flipH: true, crop: { x1: 0, y1: 0, x2: 1, y2: 0.9 } },
      adjust: { brightness: 10, contrast: 10, saturation: 10 }, format: 'jpeg', outPath: out,
    });
    clearInterval(timer);
    expect(size).toEqual({ width: Math.round(6528 * 0.9), height: 3672 });
    const grewMb = (peak - before) / 1024 / 1024;
    console.info(`24 MP edit peak RSS growth: ${grewMb.toFixed(0)} MB`);
    expect(grewMb).toBeLessThan(450);
  });
});

describe('renderEditorPreview', () => {
  it('fits a large picture inside the preview size and keeps its shape', async () => {
    const src = path.join(dir, 'big.jpg');
    await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#222' } }).jpeg().toFile(src);
    const meta = await sharp(await renderEditorPreview(src, EDITOR_PREVIEW_MAX_PX)).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(1536);
  });
  it('does not enlarge a small one', async () => {
    const src = path.join(dir, 'small.jpg');
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#222' } }).jpeg().toFile(src);
    expect((await sharp(await renderEditorPreview(src, EDITOR_PREVIEW_MAX_PX)).metadata()).width).toBe(300);
  });
});

describe('imageEditRequestSchema', () => {
  const base = { source: { kind: 'telescope', path: 'M31/a.jpg' }, save: { mode: 'overwrite' } };
  it('fills in no edit and no adjustment', () => {
    const parsed = imageEditRequestSchema.parse(base);
    expect(parsed.edit).toEqual({});
    expect(parsed.adjust).toEqual(NONE);
  });
  it.each([
    ['a brightness past the slider', { ...base, adjust: { brightness: 101 } }],
    ['an unknown source kind', { ...base, source: { kind: 'url', path: 'x' } }],
    ['a new picture with no object', { ...base, save: { mode: 'new', target: 'library', date: '2026-05-30' } }],
    ['a bad session date', { ...base, save: { mode: 'new', target: 'library', objectId: 'M31', date: '30/05/2026' } }],
    ['an impossible rotation', { ...base, edit: { rotation: 45 } }],
  ])('refuses %s', (_name, value) => {
    expect(imageEditRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe('runImageEdit', () => {
  const DIR = 'M31/image-edit-service-test';
  const REL = `${DIR}/Stacked_60_M 31_10.0s_IRCUT_20260530-211100.jpg`;
  const m31 = getById('M31')!;
  const solution = approximateWcs({ raDeg: m31.ra * 15, decDeg: m31.dec, width: 1200, height: 800, longSideDeg: 3 });
  const createdProcessed: string[] = [];
  let abs: string;

  beforeEach(async () => {
    abs = path.join(getLibraryDir(), REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#123' } }).jpeg().toFile(abs);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, 'stacked', ?)`,
    ).run('M31', REL, path.basename(REL), path.basename(REL), '2026-10-01T00:00:00Z');
    db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, 'astap', ?, 'x')`)
      .run(REL, fs.statSync(abs).mtimeMs, JSON.stringify(solution));
  });

  afterEach(() => {
    for (const table of ['libraryFiles', 'fileWcs', 'fileGeometryEdits']) db.prepare(`DELETE FROM ${table} WHERE relPath = ?`).run(REL);
    fs.rmSync(path.join(getLibraryDir(), DIR), { recursive: true, force: true });
    while (createdProcessed.length) { const id = createdProcessed.pop()!; if (getProcessedImageRecord(id)) deleteProcessedImage(id); }
  });

  const overwrite = (edit: ImageEditRequest['edit'], adjust = NONE): ImageEditRequest =>
    imageEditRequestSchema.parse({ source: { kind: 'telescope', path: REL }, edit, adjust, save: { mode: 'overwrite' } });

  it('overwrites a library picture, keeps the first original, and keeps its plate solution', async () => {
    const original = fs.readFileSync(abs);
    await runImageEdit(overwrite({ rotation: 90 }));
    expect((await sharp(abs).metadata()).width).toBe(800);
    expect(fs.readFileSync(originalBackupFile(REL)!).equals(original)).toBe(true);
    const annotations = await getAnnotations(REL);
    expect(annotations.quality).toBe('solved');
    expect(annotations.imageWidth).toBe(800);
    // A second edit must not replace the first original with the first edit.
    await runImageEdit(overwrite({ flipH: true }));
    expect(fs.readFileSync(originalBackupFile(REL)!).equals(original)).toBe(true);
  });

  it('keeps the plate solution through a color-only edit, which changes the file but not its frame', async () => {
    await runImageEdit(overwrite({}, { brightness: 20, contrast: 0, saturation: 0 }));
    const annotations = await getAnnotations(REL);
    expect(annotations.quality).toBe('solved');
    expect(annotations.reason).not.toBe('edited');
  });

  it('refuses a file that is not in the library, and one that is not a JPEG or PNG', async () => {
    await expect(runImageEdit(imageEditRequestSchema.parse({ source: { kind: 'telescope', path: 'M31/nope.jpg' }, save: { mode: 'overwrite' } })))
      .rejects.toMatchObject({ status: 404 });
    fs.writeFileSync(path.join(path.dirname(abs), 'notes.txt'), 'x');
    db.prepare(`INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt) VALUES (?, ?, ?, ?, 'stacked', ?)`)
      .run('M31', `${DIR}/notes.txt`, 'notes.txt', 'notes.txt', '2026-10-01T00:00:00Z');
    try {
      await expect(runImageEdit(imageEditRequestSchema.parse({ source: { kind: 'telescope', path: `${DIR}/notes.txt` }, save: { mode: 'overwrite' } })))
        .rejects.toBeInstanceOf(ImageEditError);
    } finally {
      db.prepare('DELETE FROM libraryFiles WHERE relPath = ?').run(`${DIR}/notes.txt`);
    }
  });

  it('saves a new version beside the telescope files as an edited variant', async () => {
    const result = await runImageEdit(imageEditRequestSchema.parse({
      source: { kind: 'telescope', path: REL }, edit: { rotation: 90 },
      save: { mode: 'new', target: 'library', objectId: 'M31', date: '2026-05-30' },
    }));
    expect(result.kind).toBe('telescopeNew');
    if (result.kind !== 'telescopeNew') return;
    expect(result.filename).toMatch(/^M31_20260530-\d{6}E\.jpg$/);
    const written = path.join(getLibraryDir(), 'M31', result.filename);
    try {
      expect((await sharp(written).metadata()).width).toBe(800);
      expect((await sharp(abs).metadata()).width).toBe(1200); // the source is untouched
    } finally {
      fs.rmSync(written, { force: true });
    }
  });

  it('saves a new processed image, then overwrites it in place', async () => {
    const created = await runImageEdit(imageEditRequestSchema.parse({
      source: { kind: 'telescope', path: REL }, title: 'M31 tweaked', adjust: { brightness: 10 },
      save: { mode: 'new', target: 'processed', objectId: 'M31', date: null },
    }));
    expect(created.kind).toBe('processed');
    if (created.kind !== 'processed') return;
    createdProcessed.push(created.id);
    expect(getProcessedImageRecord(created.id)?.objectId).toBe('M31');

    const again = await runImageEdit(imageEditRequestSchema.parse({
      source: { kind: 'processed', id: created.id }, edit: { rotation: 270 }, save: { mode: 'overwrite' },
    }));
    expect(again).toMatchObject({ kind: 'processed', id: created.id });
  });

  it('refuses a processed image that does not exist', async () => {
    await expect(runImageEdit(imageEditRequestSchema.parse({ source: { kind: 'processed', id: 'proc_missing' }, save: { mode: 'overwrite' } })))
      .rejects.toMatchObject({ status: 404 });
  });

  describe('a file in a linked folder', () => {
    const SOURCE_ID = 'edit-test-source';
    const LINKED = `@src/${SOURCE_ID}/Stacked_60_M 31_10.0s_IRCUT_20260530-211100.jpg`;
    let linkedAbs: string;

    beforeEach(async () => {
      linkedAbs = path.join(dir, 'Stacked_60_M 31_10.0s_IRCUT_20260530-211100.jpg');
      await sharp({ create: { width: 600, height: 400, channels: 3, background: '#345' } }).jpeg().toFile(linkedAbs);
      db.prepare(`INSERT INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, 'edit test', ?, 1, 'x')`).run(SOURCE_ID, dir);
      db.prepare(
        `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, importedAt, sourceId, sourcePath) VALUES (?, ?, ?, ?, 'stacked', ?, ?, ?)`,
      ).run('M31', LINKED, path.basename(linkedAbs), path.basename(linkedAbs), '2026-10-01T00:00:00Z', SOURCE_ID, path.basename(linkedAbs));
    });
    afterEach(() => {
      db.prepare('DELETE FROM libraryFiles WHERE relPath = ?').run(LINKED);
      db.prepare('DELETE FROM librarySources WHERE id = ?').run(SOURCE_ID);
    });

    const overwriteLinked = (confirmLinked?: boolean) => imageEditRequestSchema.parse({
      source: { kind: 'telescope', path: LINKED }, edit: { rotation: 90 },
      save: { mode: 'overwrite', ...(confirmLinked ? { confirmLinked } : {}) },
    });

    it('is refused without confirmation and left untouched', async () => {
      const before = fs.readFileSync(linkedAbs);
      await expect(runImageEdit(overwriteLinked())).rejects.toMatchObject({ status: 409, code: 'LINKED_REPLACE_UNCONFIRMED' });
      expect(fs.readFileSync(linkedAbs).equals(before)).toBe(true);
    });

    it('is replaced once confirmed, with the first original kept', async () => {
      const before = fs.readFileSync(linkedAbs);
      await runImageEdit(overwriteLinked(true));
      expect((await sharp(linkedAbs).metadata()).width).toBe(400);
      expect(fs.readFileSync(originalBackupFile(LINKED)!).equals(before)).toBe(true);
      fs.rmSync(path.dirname(originalBackupFile(LINKED)!), { recursive: true, force: true });
    });

    it('can still be saved as a new version without any confirmation', async () => {
      const result = await runImageEdit(imageEditRequestSchema.parse({
        source: { kind: 'telescope', path: LINKED },
        save: { mode: 'new', target: 'processed', objectId: 'M31', date: null },
      }));
      if (result.kind === 'processed') createdProcessed.push(result.id);
      expect(result.kind).toBe('processed');
      expect((await sharp(linkedAbs).metadata()).width).toBe(600);
    });
  });
});
