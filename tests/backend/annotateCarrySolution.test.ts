import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import db from '../../server/lib/db';
import sharp from '../../server/lib/sharp-optional';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getById } from '../../server/lib/dsoCatalog';
import { carrySolutionThroughEdit, getAnnotations, solutionBeforeEdit } from '../../server/lib/annotate/annotateService';
import { markGeometryEdited } from '../../server/lib/annotate/geometryEdits';
import { geometryEditSchema } from '../../server/lib/annotate/geometryEditSchema';
import { approximateWcs, type GeometryEdit } from '../../server/lib/annotate/wcs';

const DIR = 'M31/carry-solution-test';
const STEM = 'Stacked_60_M 31_10.0s_IRCUT_20260530-211100';
const REL = `${DIR}/${STEM}.jpg`;

/** The editor's save, as the server sees it: read the solution, write the new pixels, then carry it. */
async function saveEdit(abs: string, edit: GeometryEdit, width: number, height: number): Promise<void> {
  const base = await solutionBeforeEdit(REL);
  await sharp({ create: { width, height, channels: 3, background: '#111' } }).jpeg().toFile(abs);
  markGeometryEdited(REL);
  if (base) carrySolutionThroughEdit(REL, base, edit);
}

function fitsHeader(cards: Record<string, number | string>): Buffer {
  const lines = ['SIMPLE  =                    T', 'BITPIX  =                   16', 'NAXIS   =                    2'];
  for (const [k, v] of Object.entries(cards)) lines.push(`${k.padEnd(8)}= ${typeof v === 'number' ? String(v).padStart(20) : `'${v}'`}`);
  lines.push('END');
  const text = lines.map(l => l.padEnd(80)).join('');
  return Buffer.from(text.padEnd(Math.ceil(text.length / 2880) * 2880));
}

describe('annotations after the editor changes a picture’s frame', () => {
  let abs: string;
  const m31 = getById('M31')!;
  const solution = approximateWcs({ raDeg: m31.ra * 15, decDeg: m31.dec, width: 1200, height: 800, longSideDeg: 3 });

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

  const storeSolution = () =>
    db.prepare(`INSERT INTO fileWcs (relPath, mtimeMs, source, wcsJson, solvedAt) VALUES (?, ?, 'astap', ?, 'x')`)
      .run(REL, fs.statSync(abs).mtimeMs, JSON.stringify(solution));

  it('keeps the stored solution through a rotation, with no solver run', async () => {
    storeSolution();
    await saveEdit(abs, { rotation: 90 }, 800, 1200);
    const result = await getAnnotations(REL);
    expect(result.quality).toBe('solved');
    expect(result.imageWidth).toBe(800);
    expect(result.imageHeight).toBe(1200);
    expect(result.solve.state).toBe('idle');
    expect(result.annotations.length).toBeGreaterThan(0);
  });

  it('keeps the pixel scale and puts the target where the unedited picture had it', async () => {
    storeSolution();
    const before = await getAnnotations(REL);
    await saveEdit(abs, { rotation: 90 }, 800, 1200);
    const after = await getAnnotations(REL);
    expect(after.pixelScaleArcsec).toBeCloseTo(before.pixelScaleArcsec!, 3);
    const target = (r: typeof before) => r.annotations.find(a => a.id === 'M31') ?? r.annotations[0];
    const a = target(before), b = target(after);
    // A clockwise quarter turn of a 1200 x 800 picture sends (x, y) to (800 - y, x).
    expect(b.x).toBeCloseTo(800 - a.y, 1);
    expect(b.y).toBeCloseTo(a.x, 1);
  });

  it('carries a solution through a crop', async () => {
    storeSolution();
    await saveEdit(abs, { crop: { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 } }, 600, 400);
    const result = await getAnnotations(REL);
    expect(result.quality).toBe('solved');
    expect(result.imageWidth).toBe(600);
  });

  it('composes: a second edit starts from the first one’s solution', async () => {
    storeSolution();
    const before = await getAnnotations(REL);
    await saveEdit(abs, { rotation: 90 }, 800, 1200);
    await saveEdit(abs, { rotation: 270 }, 1200, 800);
    const after = await getAnnotations(REL);
    expect(after.quality).toBe('solved');
    // A quarter turn each way is no turn: every circle is back where it started.
    expect(after.annotations.map(a => [a.id, Math.round(a.x), Math.round(a.y)]))
      .toEqual(before.annotations.map(a => [a.id, Math.round(a.x), Math.round(a.y)]));
  });

  it('says nothing is carried when the picture had no solution', async () => {
    expect(await solutionBeforeEdit(REL)).toBeNull();
  });

  it('gives the original’s solution back once the file changes again, as a restored original does', async () => {
    storeSolution();
    await saveEdit(abs, { rotation: 90 }, 800, 1200);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(abs, later, later);
    expect((await getAnnotations(REL)).quality).not.toBe('solved');
  });

  it('moves a FITS twin’s header position with the picture while the frame is still the captured one', async () => {
    const header = fitsHeader({
      NAXIS1: 1200, NAXIS2: 800, CRVAL1: solution.crval1, CRVAL2: solution.crval2, CRPIX1: solution.crpix1, CRPIX2: solution.crpix2,
      CD1_1: solution.cd.cd11, CD1_2: solution.cd.cd12, CD2_1: solution.cd.cd21, CD2_2: solution.cd.cd22,
    });
    fs.writeFileSync(path.join(path.dirname(abs), `${STEM}.fit`), header);
    expect(await solutionBeforeEdit(REL)).not.toBeNull();
    await saveEdit(abs, { rotation: 90 }, 800, 1200);
    const result = await getAnnotations(REL);
    expect(result.quality).toBe('solved');
    expect(result.imageHeight).toBe(1200);
  });

  it('does not use the header once the frame was edited without a carried solution', async () => {
    fs.writeFileSync(path.join(path.dirname(abs), `${STEM}.fit`), fitsHeader({ NAXIS1: 1200, NAXIS2: 800 }));
    markGeometryEdited(REL);
    expect(await solutionBeforeEdit(REL)).toBeNull();
  });
});

describe('geometryEditSchema', () => {
  it('accepts what the editor sends', () => {
    expect(geometryEditSchema.safeParse({ crop: { x1: 0, y1: 0.1, x2: 1, y2: 0.9 }, flipH: true, flipV: false, rotation: 270 }).success).toBe(true);
    expect(geometryEditSchema.safeParse({}).success).toBe(true);
  });
  it.each([
    ['a rotation that is not a quarter turn', { rotation: 45 }],
    ['a crop outside the picture', { crop: { x1: -0.1, y1: 0, x2: 1, y2: 1 } }],
    ['a crop with no area', { crop: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } }],
    ['a flipped crop', { crop: { x1: 0.8, y1: 0, x2: 0.2, y2: 1 } }],
    ['text for a number', { crop: { x1: '0', y1: 0, x2: 1, y2: 1 } }],
  ])('refuses %s', (_name, value) => {
    expect(geometryEditSchema.safeParse(value).success).toBe(false);
  });
});
